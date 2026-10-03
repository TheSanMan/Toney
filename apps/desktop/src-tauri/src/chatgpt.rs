//! Direct Sign in with ChatGPT for locally hosted OSS clients.
//! Credentials stay in Rust and owner-only atomic files; no callback/token events
//! are emitted to webviews. Account catalog order is authoritative, not a promise
//! of unlimited usage. See docs/adr-006-chatgpt-agent.md for protocol references.
use crate::{failure, NativeError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};
use url::Url;

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const MAX_JSON: usize = 2 * 1024 * 1024;
const MAX_STREAM: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct ChatGptState {
    session: Mutex<Session>,
    refresh: Mutex<()>,
}
#[derive(Default)]
struct Session {
    initialized: bool,
    generation: u64,
    host_id: String,
    registration: Option<Registration>,
    credentials: Option<Credentials>,
    authorizing: bool,
    models: Vec<Model>,
    error: Option<NativeError>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Registration {
    client_id: String,
    subject: String,
    email: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    registration: Registration,
    access_token: String,
    refresh_token: String,
    id_token: String,
    scopes: String,
    expires_at: u64,
    earliest_refresh_at: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    slug: String,
    display_name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BaseRequest {
    protocol_version: u32,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InterpretRequest {
    protocol_version: u32,
    request_id: String,
    model: String,
    prompt: String,
    baseline: Value,
    current_tone: Option<Value>,
}
struct Pending {
    state: String,
    nonce: String,
    verifier: String,
    redirect: String,
    registration: Option<Registration>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn err(code: &str, message: &str, id: &str) -> NativeError {
    failure(code, message, Some(id))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn base(value: Value) -> Result<BaseRequest, NativeError> {
    let request: BaseRequest = serde_json::from_value(value)
        .map_err(|_| failure("CHATGPT_REQUEST_INVALID", "Invalid ChatGPT request.", None))?;
    check_base(request.protocol_version, &request.request_id)?;
    Ok(request)
}
fn check_base(version: u32, id: &str) -> Result<(), NativeError> {
    if version != 1
        || id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(err(
            "CHATGPT_REQUEST_INVALID",
            "Invalid protocol or request ID.",
            id,
        ));
    }
    Ok(())
}
fn random() -> Result<String, NativeError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| {
        failure(
            "CHATGPT_RANDOM_FAILED",
            "Cannot prepare secure sign-in.",
            None,
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, NativeError> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| {
            failure(
                "CHATGPT_STORAGE_FAILED",
                "Cannot locate account storage.",
                None,
            )
        })?
        .join("chatgpt");
    std::fs::create_dir_all(&path).map_err(|_| {
        failure(
            "CHATGPT_STORAGE_FAILED",
            "Cannot create account storage.",
            None,
        )
    })?;
    if std::fs::symlink_metadata(&path)
        .map_err(|_| {
            failure(
                "CHATGPT_STORAGE_FAILED",
                "Cannot inspect account storage.",
                None,
            )
        })?
        .file_type()
        .is_symlink()
    {
        return Err(failure(
            "CHATGPT_STORAGE_FAILED",
            "Account storage must be a real directory.",
            None,
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|_| {
            failure(
                "CHATGPT_STORAGE_FAILED",
                "Cannot protect account storage.",
                None,
            )
        })?;
    }
    Ok(path)
}
fn save(path: &Path, value: &impl Serialize) -> Result<(), NativeError> {
    let data = serde_json::to_vec(value).map_err(|_| {
        failure(
            "CHATGPT_STORAGE_FAILED",
            "Cannot encode account storage.",
            None,
        )
    })?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|_| {
        failure(
            "CHATGPT_STORAGE_FAILED",
            "Cannot write account storage.",
            None,
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| {
                failure(
                    "CHATGPT_STORAGE_FAILED",
                    "Cannot protect credentials.",
                    None,
                )
            })?;
    }
    file.write_all(&data)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| {
            failure(
                "CHATGPT_STORAGE_FAILED",
                "Cannot save account storage.",
                None,
            )
        })?;
    file.persist(path).map_err(|_| {
        failure(
            "CHATGPT_STORAGE_FAILED",
            "Cannot replace account storage.",
            None,
        )
    })?;
    Ok(())
}
fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, NativeError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(failure(
                "CHATGPT_STORAGE_FAILED",
                "Cannot read account storage.",
                None,
            ))
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 128 * 1024 {
        return Err(failure(
            "CHATGPT_STORAGE_INVALID",
            "Invalid account storage.",
            None,
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(failure(
                "CHATGPT_STORAGE_UNPROTECTED",
                "Account credentials require owner-only file permissions.",
                None,
            ));
        }
    }
    let data = std::fs::read(path).map_err(|_| {
        failure(
            "CHATGPT_STORAGE_FAILED",
            "Cannot read account storage.",
            None,
        )
    })?;
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|_| failure("CHATGPT_STORAGE_INVALID", "Invalid account storage.", None))
}
async fn initialize(app: &tauri::AppHandle) -> Result<(), NativeError> {
    let state = app.state::<ChatGptState>();
    let mut s = state.session.lock().await;
    if s.initialized {
        return Ok(());
    }
    let directory = directory(app)?;
    s.host_id = match read::<String>(&directory.join("host.json"))? {
        Some(id) if text(&id, 200) => id,
        Some(_) => {
            return Err(failure(
                "CHATGPT_STORAGE_INVALID",
                "Invalid host identity.",
                None,
            ))
        }
        None => {
            let id = format!("toney:{}", random()?);
            save(&directory.join("host.json"), &id)?;
            id
        }
    };
    s.registration = read(&directory.join("registration.json"))?;
    s.credentials = read(&directory.join("credentials.json"))?;
    if let Some(c) = &s.credentials {
        if !valid_credentials(c)
            || s.registration.as_ref().is_none_or(|r| {
                r.client_id != c.registration.client_id || r.subject != c.registration.subject
            })
        {
            return Err(failure(
                "CHATGPT_STORAGE_INVALID",
                "Stored session does not match its account registration.",
                None,
            ));
        }
    }
    s.initialized = true;
    Ok(())
}
fn valid_credentials(c: &Credentials) -> bool {
    text(&c.registration.client_id, 200)
        && c.registration.client_id != "dynamic_agent_client"
        && text(&c.registration.subject, 512)
        && text(&c.access_token, 32768)
        && text(&c.refresh_token, 32768)
        && text(&c.id_token, 32768)
        && permitted(&c.scopes)
}
fn permitted(scope: &str) -> bool {
    let scopes: HashSet<_> = scope.split_whitespace().collect();
    ["openid", "resource.invoke", "chatgpt.tokens.use.direct"]
        .iter()
        .all(|s| scopes.contains(s))
}
fn status(s: &Session, id: &str) -> Value {
    let phase = if s.authorizing {
        "authorizing"
    } else if s.error.is_some() {
        "error"
    } else if s.credentials.is_some() {
        "connected"
    } else {
        "disconnected"
    };
    let mut value = json!({"protocolVersion":1,"requestId":id,"status":phase,"models":s.models});
    if phase == "connected" {
        if let Some(c) = &s.credentials {
            value["account"] = json!({});
            if let Some(email) = &c.registration.email {
                value["account"]["email"] = json!(email);
            }
        }
    }
    if phase == "error" {
        if let Some(error) = &s.error {
            value["error"] = json!({"code":error.code,"message":error.message,"requestId":id});
        }
    }
    value
}
fn client(id: &str) -> Result<reqwest::Client, NativeError> {
    reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| {
            err(
                "CHATGPT_NETWORK_FAILED",
                "Cannot prepare ChatGPT connection.",
                id,
            )
        })
}
fn http_status(status: reqwest::StatusCode, id: &str) -> Result<(), NativeError> {
    if status.is_success() {
        return Ok(());
    }
    let (code,message)=match status.as_u16(){401=>("CHATGPT_SESSION_EXPIRED","ChatGPT session expired. Sign in again."),403=>("CHATGPT_ACCESS_DENIED","This account has not enabled ChatGPT plan usage for Toney."),429=>("CHATGPT_USAGE_LIMIT","ChatGPT usage is currently limited. Review your plan and app limits in ChatGPT Settings → Usage, or retry later."),_ =>("CHATGPT_HTTP_FAILED","ChatGPT request failed. Retry or reconnect your account.")};
    Err(err(
        code,
        &format!("{message} HTTP {}.", status.as_u16()),
        id,
    ))
}
async fn bounded_json(mut response: reqwest::Response, id: &str) -> Result<Value, NativeError> {
    http_status(response.status(), id)?;
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        err(
            "CHATGPT_NETWORK_FAILED",
            "ChatGPT response interrupted.",
            id,
        )
    })? {
        if data.len() + chunk.len() > MAX_JSON {
            return Err(err(
                "CHATGPT_RESPONSE_TOO_LARGE",
                "ChatGPT response exceeded its limit.",
                id,
            ));
        }
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| {
        err(
            "CHATGPT_RESPONSE_INVALID",
            "ChatGPT returned an invalid response.",
            id,
        )
    })
}
fn build_authorize(p: &Pending, host: &str) -> Url {
    let mut url = Url::parse(AUTHORIZE).unwrap();
    let mut query = url.query_pairs_mut();
    query
        .append_pair(
            "client_id",
            p.registration
                .as_ref()
                .map_or("dynamic_agent_client", |r| r.client_id.as_str()),
        )
        .append_pair("ext_agent_host_id", host)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &p.redirect)
        .append_pair("scope", SCOPES)
        .append_pair("resource", RESOURCE)
        .append_pair("state", &p.state)
        .append_pair("nonce", &p.nonce)
        .append_pair("code_challenge_method", "S256")
        .append_pair(
            "code_challenge",
            &URL_SAFE_NO_PAD.encode(Sha256::digest(p.verifier.as_bytes())),
        );
    if p.registration.is_none() {
        query.append_pair("agent_name_hint", "Toney");
    } else if let Some(email) = p.registration.as_ref().and_then(|r| r.email.as_ref()) {
        query.append_pair("login_hint", email);
    }
    drop(query);
    url
}
fn parse_callback(target: &str, p: &Pending) -> Result<Option<(String, String)>, NativeError> {
    if target.len() > 16384 || !target.starts_with("/auth/callback?") {
        return Ok(None);
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| {
        failure(
            "CHATGPT_CALLBACK_INVALID",
            "Invalid sign-in callback.",
            None,
        )
    })?;
    let mut fields = std::collections::HashMap::new();
    for (key, value) in url.query_pairs() {
        if fields.insert(key.to_string(), value.to_string()).is_some() {
            return Ok(None);
        }
    }
    if fields.get("state") != Some(&p.state) {
        return Ok(None);
    }
    if fields.contains_key("error") {
        return Err(failure(
            "CHATGPT_SIGN_IN_DENIED",
            "ChatGPT sign-in was declined. Continue with ChatGPT when ready to grant plan access.",
            None,
        ));
    }
    let code = fields
        .get("code")
        .filter(|c| text(c, 8192))
        .ok_or_else(|| {
            failure(
                "CHATGPT_CALLBACK_INVALID",
                "Sign-in returned no authorization code.",
                None,
            )
        })?;
    let issued = match (&p.registration, fields.get("client_id")) {
        (Some(r), Some(id)) if id != &r.client_id => {
            return Err(failure(
                "CHATGPT_ACCOUNT_MISMATCH",
                "Sign-in returned a different registration.",
                None,
            ))
        }
        (Some(r), _) => r.client_id.clone(),
        (None, Some(id)) if text(id, 200) && id != "dynamic_agent_client" => id.clone(),
        _ => {
            return Err(failure(
                "CHATGPT_REGISTRATION_INCOMPLETE",
                "Sign-in returned no issued client ID.",
                None,
            ))
        }
    };
    Ok(Some((code.clone(), issued)))
}
async fn identity(
    id_token: &str,
    issued: &str,
    nonce: Option<&str>,
    id: &str,
) -> Result<Value, NativeError> {
    let invalid = || {
        err(
            "CHATGPT_IDENTITY_INVALID",
            "ChatGPT identity validation failed. Start a fresh sign-in.",
            id,
        )
    };
    let parts: Vec<_> = id_token.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let header: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    let kid = header["kid"]
        .as_str()
        .filter(|s| text(s, 256))
        .ok_or_else(invalid)?;
    let jwks = bounded_json(
        client(id)?
            .get("https://auth.openai.com/.well-known/jwks.json")
            .send()
            .await
            .map_err(|_| {
                err(
                    "CHATGPT_NETWORK_FAILED",
                    "Cannot verify ChatGPT signing keys.",
                    id,
                )
            })?,
        id,
    )
    .await?;
    let key = jwks["keys"]
        .as_array()
        .and_then(|keys| keys.iter().find(|key| key["kid"].as_str() == Some(kid)))
        .ok_or_else(invalid)?;
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| invalid())?;
    let signed = format!("{}.{}", parts[0], parts[1]);
    verify_signature(&header, key, signed.as_bytes(), &signature).map_err(|_| invalid())?;
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    validate_claims(&claims, issued, nonce, now()).map_err(|_| invalid())?;
    Ok(claims)
}
fn verify_signature(
    header: &Value,
    key: &Value,
    signed: &[u8],
    signature: &[u8],
) -> Result<(), ()> {
    let invalid = || ();
    if header.get("crit").is_some() || header.get("b64").is_some() {
        return Err(());
    }
    if key.get("use").is_some_and(|v| v != "sig")
        || key.get("alg").is_some_and(|v| v != &header["alg"])
    {
        return Err(());
    }
    match header["alg"].as_str() {
        Some("RS256") if key["kty"] == "RSA" => {
            let n = URL_SAFE_NO_PAD
                .decode(key["n"].as_str().ok_or_else(invalid)?)
                .map_err(|_| invalid())?;
            let e = URL_SAFE_NO_PAD
                .decode(key["e"].as_str().ok_or_else(invalid)?)
                .map_err(|_| invalid())?;
            ring::signature::RsaPublicKeyComponents { n, e }
                .verify(
                    &ring::signature::RSA_PKCS1_2048_8192_SHA256,
                    signed,
                    signature,
                )
                .map_err(|_| invalid())?;
        }
        _ => return Err(()),
    }
    Ok(())
}
fn validate_claims(c: &Value, issued: &str, nonce: Option<&str>, time: u64) -> Result<(), ()> {
    let audience = match &c["aud"] {
        Value::String(value) => value == issued,
        Value::Array(values) => {
            !values.is_empty()
                && values.iter().all(|v| v.as_str().is_some())
                && values.iter().any(|v| v.as_str() == Some(issued))
                && (values.len() == 1 || c["azp"].as_str() == Some(issued))
        }
        _ => false,
    };
    let authorized_party = c.get("azp").is_none_or(|v| v.as_str() == Some(issued));
    if c["iss"].as_str() != Some(ISSUER)
        || !audience
        || !authorized_party
        || c["exp"]
            .as_u64()
            .is_none_or(|exp| exp.saturating_add(5) <= time)
        || c["iat"].as_u64().is_none_or(|iat| iat > time + 5)
        || c.get("nbf")
            .is_some_and(|v| v.as_u64().is_none_or(|t| t > time + 5))
        || c["sub"].as_str().is_none_or(|s| !text(s, 512))
        || nonce.is_some_and(|n| c["nonce"].as_str() != Some(n))
    {
        return Err(());
    }
    Ok(())
}
fn tokens(
    value: &Value,
    registration: Registration,
    previous: Option<&Credentials>,
    id: &str,
) -> Result<Credentials, NativeError> {
    let invalid = || {
        err(
            "CHATGPT_TOKEN_INVALID",
            "ChatGPT returned incomplete credentials or plan permissions.",
            id,
        )
    };
    let field = |name: &str| max_field(value, name, 32768).ok_or_else(invalid);
    let access = field("access_token")?;
    let refresh = field("refresh_token")?;
    let id_token = value["id_token"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| previous.map(|c| c.id_token.clone()))
        .filter(|s| text(s, 32768))
        .ok_or_else(invalid)?;
    let scope = value["scope"]
        .as_str()
        .or_else(|| previous.map(|c| c.scopes.as_str()))
        .filter(|s| permitted(s))
        .ok_or_else(invalid)?;
    let expires = value["expires_in"]
        .as_u64()
        .filter(|s| *s > 0 && *s <= 86400)
        .ok_or_else(invalid)?;
    if !value["token_type"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
    {
        return Err(invalid());
    }
    Ok(Credentials {
        registration,
        access_token: access,
        refresh_token: refresh,
        id_token,
        scopes: scope.into(),
        expires_at: now() + expires,
        earliest_refresh_at: value["earliest_refresh_at"].as_u64().unwrap_or(0),
    })
}
fn max_field(value: &Value, name: &str, max: usize) -> Option<String> {
    value[name]
        .as_str()
        .filter(|s| text(s, max))
        .map(str::to_owned)
}
async fn finish_sign_in(
    app: &tauri::AppHandle,
    p: &Pending,
    code: &str,
    issued: &str,
    id: &str,
) -> Result<Credentials, NativeError> {
    let value = bounded_json(
        client(id)?
            .post(TOKEN)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", issued),
                ("code", code),
                ("code_verifier", p.verifier.as_str()),
                ("redirect_uri", p.redirect.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| {
                err(
                    "CHATGPT_NETWORK_FAILED",
                    "ChatGPT code exchange failed. Start sign-in again.",
                    id,
                )
            })?,
        id,
    )
    .await?;
    let token = max_field(&value, "id_token", 32768).ok_or_else(|| {
        err(
            "CHATGPT_TOKEN_INVALID",
            "ChatGPT returned no identity token.",
            id,
        )
    })?;
    let claims = identity(&token, issued, Some(&p.nonce), id).await?;
    let subject = claims["sub"].as_str().unwrap();
    if p.registration
        .as_ref()
        .is_some_and(|r| r.subject != subject)
    {
        return Err(err(
            "CHATGPT_ACCOUNT_MISMATCH",
            "The signed-in account differs from its saved registration.",
            id,
        ));
    }
    let registration = Registration {
        client_id: issued.into(),
        subject: subject.into(),
        email: claims["email"]
            .as_str()
            .filter(|s| text(s, 320))
            .map(str::to_owned),
    };
    let credentials = tokens(&value, registration, None, id)?;
    let _ = app;
    Ok(credentials)
}
async fn listen(
    app: tauri::AppHandle,
    listener: TcpListener,
    p: Pending,
    generation: u64,
    id: String,
) {
    let result=tokio::time::timeout(Duration::from_secs(600),async{
        loop{
            if app.state::<ChatGptState>().session.lock().await.generation!=generation{return Err(err("CHATGPT_SIGN_IN_CANCELED","ChatGPT sign-in canceled.",&id));}
            let (mut socket,_)=match tokio::time::timeout(Duration::from_secs(1),listener.accept()).await { Ok(result)=>result.map_err(|_|err("CHATGPT_CALLBACK_FAILED","Cannot receive sign-in callback.",&id))?, Err(_)=>continue };
            let mut bytes=vec![0;16384];let mut size=0;
            let read=tokio::time::timeout(Duration::from_secs(5),async{while size<bytes.len(){let count=socket.read(&mut bytes[size..]).await?;if count==0{break;}size+=count;if bytes[..size].windows(4).any(|s|s==b"\r\n\r\n"){break;}}Ok::<(),std::io::Error>(())}).await;
            if !matches!(read,Ok(Ok(()))){continue;}
            let request=String::from_utf8_lossy(&bytes[..size]);let first=request.lines().next().unwrap_or("");let parts:Vec<_>=first.split_whitespace().collect();
            let outcome=if parts.len()==3 && parts[0]=="GET"{parse_callback(parts[1],&p)}else{Ok(None)};
            let accepted=!matches!(outcome,Ok(None));
            let body=if accepted{"<!doctype html><title>Toney sign-in</title><p>Return to Toney to see your connection status. You may close this tab.</p>"}else{"<!doctype html><title>Toney</title><p>This callback does not match an active sign-in.</p>"};
            let reply=format!("HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",if accepted{"200 OK"}else{"400 Bad Request"},body.len(),body);
            let _=tokio::time::timeout(Duration::from_secs(2),socket.write_all(reply.as_bytes())).await;
            match outcome?{Some((code,issued))=>return finish_sign_in(&app,&p,&code,&issued,&id).await,None=>continue}
        }
    }).await.unwrap_or_else(|_|Err(err("CHATGPT_SIGN_IN_TIMEOUT","ChatGPT sign-in timed out. Continue with ChatGPT to retry.",&id)));
    let state = app.state::<ChatGptState>();
    let mut s = state.session.lock().await;
    if s.generation != generation {
        return;
    }
    s.authorizing = false;
    let authenticated = result.is_ok();
    match result {
        Ok(credentials) => {
            let saved = directory(&app).and_then(|directory| {
                save(
                    &directory.join("registration.json"),
                    &credentials.registration,
                )?;
                save(&directory.join("credentials.json"), &credentials)
            });
            match saved {
                Ok(()) => {
                    s.registration = Some(credentials.registration.clone());
                    s.credentials = Some(credentials);
                    s.error = None;
                    s.models.clear();
                }
                Err(error) => s.error = Some(error),
            }
        }
        Err(error) => s.error = Some(error),
    }
    drop(s);
    if authenticated {
        if let Err(error) = refresh_models(&app, &id).await {
            let mut s = state.session.lock().await;
            if s.generation == generation && s.error.is_none() {
                s.error = Some(error);
            }
        }
    }
}
#[tauri::command]
pub async fn native_chatgpt_sign_in(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, NativeError> {
    let r = base(request)?;
    initialize(&app).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
        err(
            "CHATGPT_CALLBACK_FAILED",
            "Cannot start local sign-in listener.",
            &r.request_id,
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|_| {
            err(
                "CHATGPT_CALLBACK_FAILED",
                "Cannot resolve local callback port.",
                &r.request_id,
            )
        })?
        .port();
    let state = app.state::<ChatGptState>();
    let mut s = state.session.lock().await;
    if s.authorizing {
        return Err(err(
            "CHATGPT_SIGN_IN_ACTIVE",
            "A sign-in is already waiting. Disconnect to cancel it.",
            &r.request_id,
        ));
    }
    let p = Pending {
        state: random()?,
        nonce: random()?,
        verifier: random()?,
        redirect: format!("http://127.0.0.1:{port}/auth/callback"),
        registration: s.registration.clone(),
    };
    let url = build_authorize(&p, &s.host_id);
    s.generation += 1;
    let generation = s.generation;
    s.authorizing = true;
    s.error = None;
    drop(s);
    #[allow(deprecated)]
    if app.shell().open(url.as_str(), None).is_err() {
        let mut s = state.session.lock().await;
        s.authorizing = false;
        return Err(err(
            "CHATGPT_BROWSER_FAILED",
            "Cannot open browser for ChatGPT sign-in.",
            &r.request_id,
        ));
    }
    let output = status(&*state.session.lock().await, &r.request_id);
    tauri::async_runtime::spawn(listen(app, listener, p, generation, r.request_id));
    Ok(output)
}
#[tauri::command]
pub async fn native_chatgpt_status(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, NativeError> {
    let r = base(request)?;
    initialize(&app).await?;
    Ok(status(
        &*app.state::<ChatGptState>().session.lock().await,
        &r.request_id,
    ))
}
async fn active(app: &tauri::AppHandle, id: &str) -> Result<(Credentials, u64), NativeError> {
    initialize(app).await?;
    let state = app.state::<ChatGptState>();
    let _refresh = state.refresh.lock().await;
    let (mut c, generation) = {
        let s = state.session.lock().await;
        (
            s.credentials.clone().ok_or_else(|| {
                err(
                    "CHATGPT_NOT_CONNECTED",
                    "Continue with ChatGPT before generating a tone.",
                    id,
                )
            })?,
            s.generation,
        )
    };
    if c.expires_at <= now() + 60 && c.earliest_refresh_at <= now() {
        let value = bounded_json(
            client(id)?
                .post(TOKEN)
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", c.registration.client_id.as_str()),
                    ("refresh_token", c.refresh_token.as_str()),
                    ("resource", RESOURCE),
                ])
                .send()
                .await
                .map_err(|_| {
                    err(
                        "CHATGPT_NETWORK_FAILED",
                        "Cannot renew ChatGPT session.",
                        id,
                    )
                })?,
            id,
        )
        .await?;
        if let Some(token) = value["id_token"].as_str() {
            let claims = identity(token, &c.registration.client_id, None, id).await?;
            if claims["sub"].as_str() != Some(c.registration.subject.as_str()) {
                return Err(err(
                    "CHATGPT_ACCOUNT_MISMATCH",
                    "Refreshed session returned a different account.",
                    id,
                ));
            }
        }
        c = tokens(&value, c.registration.clone(), Some(&c), id)?;
        let mut s = state.session.lock().await;
        if s.generation != generation {
            return Err(err(
                "CHATGPT_SESSION_CHANGED",
                "Account changed during the request. Retry.",
                id,
            ));
        }
        save(&directory(app)?.join("credentials.json"), &c)?;
        s.credentials = Some(c.clone());
    }
    Ok((c, generation))
}
fn parse_models(value: &Value, id: &str) -> Result<Vec<Model>, NativeError> {
    let rows = value["models"]
        .as_array()
        .filter(|a| a.len() <= 256)
        .ok_or_else(|| {
            err(
                "CHATGPT_CATALOG_INVALID",
                "ChatGPT returned an invalid model catalog.",
                id,
            )
        })?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for row in rows.iter().filter(|r| r["visibility"] == "list") {
        let slug = max_field(row, "slug", 200).ok_or_else(|| {
            err(
                "CHATGPT_CATALOG_INVALID",
                "ChatGPT model has no identifier.",
                id,
            )
        })?;
        let display_name = max_field(row, "display_name", 200).ok_or_else(|| {
            err(
                "CHATGPT_CATALOG_INVALID",
                "ChatGPT model has no display name.",
                id,
            )
        })?;
        if !seen.insert(slug.clone()) || models.len() >= 128 {
            return Err(err(
                "CHATGPT_CATALOG_INVALID",
                "ChatGPT model catalog has duplicate or excess entries.",
                id,
            ));
        }
        models.push(Model { slug, display_name });
    }
    Ok(models)
}
async fn refresh_models(app: &tauri::AppHandle, id: &str) -> Result<(), NativeError> {
    let (c, generation) = active(app, id).await?;
    let value = bounded_json(
        client(id)?
            .get(format!("{RESOURCE}/models"))
            .bearer_auth(&c.access_token)
            .send()
            .await
            .map_err(|_| err("CHATGPT_NETWORK_FAILED", "Cannot load account models.", id))?,
        id,
    )
    .await?;
    let models = parse_models(&value, id)?;
    let state = app.state::<ChatGptState>();
    let mut s = state.session.lock().await;
    if s.generation != generation {
        return Err(err(
            "CHATGPT_SESSION_CHANGED",
            "Account changed while loading models.",
            id,
        ));
    }
    s.models = models;
    s.error = None;
    Ok(())
}
#[tauri::command]
pub async fn native_chatgpt_models(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, NativeError> {
    let r = base(request)?;
    refresh_models(&app, &r.request_id).await?;
    Ok(status(
        &*app.state::<ChatGptState>().session.lock().await,
        &r.request_id,
    ))
}
#[tauri::command]
pub async fn native_chatgpt_disconnect(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, NativeError> {
    let r = base(request)?;
    initialize(&app).await?;
    let state = app.state::<ChatGptState>();
    let _refresh = state.refresh.lock().await;
    let (c, generation) = {
        let mut s = state.session.lock().await;
        s.generation += 1;
        s.authorizing = false;
        s.models.clear();
        s.error = None;
        (s.credentials.take(), s.generation)
    };
    let path = directory(&app)?.join("credentials.json");
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(err(
                "CHATGPT_STORAGE_FAILED",
                "Cannot remove local credentials.",
                &r.request_id,
            ))
        }
    }
    if let Some(c) = c {
        let revoke = async {
            let discovery = bounded_json(
                client(&r.request_id)?
                    .get("https://auth.openai.com/.well-known/openid-configuration")
                    .send()
                    .await
                    .map_err(|_| {
                        err(
                            "CHATGPT_NETWORK_FAILED",
                            "Cannot load revocation endpoint.",
                            &r.request_id,
                        )
                    })?,
                &r.request_id,
            )
            .await?;
            let endpoint=discovery["revocation_endpoint"].as_str().and_then(|s|Url::parse(s).ok()).filter(|u|u.scheme()=="https" && u.host_str()==Some("auth.openai.com") && u.port().is_none() && u.username().is_empty() && u.password().is_none()).ok_or_else(||err("CHATGPT_REVOCATION_UNCONFIRMED","Remote revocation was not confirmed. Disconnect Toney in ChatGPT Settings.",&r.request_id))?;
            let response=client(&r.request_id)?.post(endpoint).form(&[("token",c.refresh_token.as_str()),("token_type_hint","refresh_token"),("client_id",c.registration.client_id.as_str())]).send().await.map_err(|_|err("CHATGPT_REVOCATION_UNCONFIRMED","Remote revocation was not confirmed. Disconnect Toney in ChatGPT Settings.",&r.request_id))?;
            if response.status() != reqwest::StatusCode::OK {
                return Err(err(
                    "CHATGPT_REVOCATION_UNCONFIRMED",
                    "Remote revocation was not confirmed. Disconnect Toney in ChatGPT Settings.",
                    &r.request_id,
                ));
            }
            Ok::<(), NativeError>(())
        };
        if !matches!(
            tokio::time::timeout(Duration::from_secs(15), revoke).await,
            Ok(Ok(()))
        ) {
            let mut s = state.session.lock().await;
            if s.generation == generation {
                s.error=Some(err("CHATGPT_REVOCATION_UNCONFIRMED","Signed out locally. Remote revocation was not confirmed; disconnect Toney in ChatGPT Settings.",&r.request_id));
            }
        }
    }
    let output = status(&*state.session.lock().await, &r.request_id);
    Ok(output)
}
const INTENT_PATHS: [&str; 12] = [
    "character.brightness",
    "character.warmth",
    "character.aggression",
    "character.clarity",
    "character.sustain",
    "character.width",
    "distortion.amount",
    "distortion.texture",
    "dynamics.compression",
    "dynamics.transientPreservation",
    "space.reverb",
    "space.delay",
];
fn numeric_group(names: &[&str]) -> Value {
    let properties: serde_json::Map<String, Value> = names
        .iter()
        .map(|n| {
            (
                n.to_string(),
                json!({"type":"number","minimum":0,"maximum":1}),
            )
        })
        .collect();
    json!({"type":"object","additionalProperties":false,"required":names,"properties":properties})
}
fn intent_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["intent","changedPaths","warnings","issues","explanation"],"properties":{
        "intent":{"type":"object","additionalProperties":false,"required":["character","distortion","dynamics","space","references"],"properties":{
            "character":numeric_group(&["brightness","warmth","aggression","clarity","sustain","width"]),
            "distortion":{"type":"object","additionalProperties":false,"required":["amount","texture"],"properties":{"amount":{"type":"number","minimum":0,"maximum":1},"texture":{"type":"string","enum":["clean","crunch","gritty","smooth"]}}},
            "dynamics":numeric_group(&["compression","transientPreservation"]),"space":numeric_group(&["reverb","delay"]),"references":{"type":"array","maxItems":10,"items":{"type":"string"}}}},
        "changedPaths":{"type":"array","items":{"type":"string","enum":INTENT_PATHS}},"warnings":{"type":"array","items":{"type":"string"}},"issues":{"type":"array","items":{"type":"string","enum":["muddy","harsh"]}},"explanation":{"type":"string"}}})
}
fn exact_keys(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn valid_intent(v: &Value) -> bool {
    if !exact_keys(
        v,
        &["character", "distortion", "dynamics", "space", "references"],
    ) {
        return false;
    }
    for (group, names) in [
        (
            "character",
            vec![
                "brightness",
                "warmth",
                "aggression",
                "clarity",
                "sustain",
                "width",
            ],
        ),
        ("dynamics", vec!["compression", "transientPreservation"]),
        ("space", vec!["reverb", "delay"]),
    ] {
        if !exact_keys(&v[group], &names)
            || names.iter().any(|n| {
                v[group][n]
                    .as_f64()
                    .is_none_or(|x| !(0.0..=1.0).contains(&x))
            })
        {
            return false;
        }
    }
    exact_keys(&v["distortion"], &["amount", "texture"])
        && v["distortion"]["amount"]
            .as_f64()
            .is_some_and(|x| (0.0..=1.0).contains(&x))
        && v["distortion"]["texture"]
            .as_str()
            .is_some_and(|s| ["clean", "crunch", "gritty", "smooth"].contains(&s))
        && v["references"].as_array().is_some_and(|a| {
            a.len() <= 10 && a.iter().all(|x| x.as_str().is_some_and(|s| text(s, 500)))
        })
}
fn validate_interpretation(v: &Value, id: &str) -> Result<(), NativeError> {
    let invalid = || {
        err(
            "CHATGPT_INTENT_INVALID",
            "ChatGPT returned invalid tone intent; your rig has not changed.",
            id,
        )
    };
    if !exact_keys(
        v,
        &[
            "intent",
            "changedPaths",
            "warnings",
            "issues",
            "explanation",
        ],
    ) || !valid_intent(&v["intent"])
        || v["explanation"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.encode_utf16().count() > 2000)
    {
        return Err(invalid());
    }
    for (field, max) in [("changedPaths", 12), ("issues", 2), ("warnings", 20)] {
        let rows = v[field]
            .as_array()
            .filter(|a| a.len() <= max)
            .ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        for row in rows {
            let s = row
                .as_str()
                .filter(|s| s.encode_utf16().count() <= 2000)
                .ok_or_else(invalid)?;
            if (field == "changedPaths" && !INTENT_PATHS.contains(&s))
                || (field == "issues" && !["muddy", "harsh"].contains(&s))
                || (field != "warnings" && !seen.insert(s))
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
fn interpret_request(value: Value) -> Result<InterpretRequest, NativeError> {
    let r: InterpretRequest = serde_json::from_value(value).map_err(|_| {
        failure(
            "CHATGPT_REQUEST_INVALID",
            "Invalid tone agent request.",
            None,
        )
    })?;
    check_base(r.protocol_version, &r.request_id)?;
    if !text(&r.model, 200)
        || r.prompt.trim().is_empty()
        || r.prompt.len() > 16000
        || !valid_intent(&r.baseline)
        || r.current_tone.as_ref().is_some_and(|tone| {
            !tone.is_object() || serde_json::to_vec(tone).map_or(true, |v| v.len() > 65536)
        })
    {
        return Err(err(
            "CHATGPT_REQUEST_INVALID",
            "Provide a supported model, bounded tone description and valid baseline.",
            &r.request_id,
        ));
    }
    Ok(r)
}
fn response_body(r: &InterpretRequest) -> Value {
    json!({"model":r.model,"store":false,"stream":true,
        "instructions":"You are Toney's guitar tone engineer. Translate the user's musical intent into the perceptual tone schema. Values are 0 to 1. Baseline comes from current manual controls and is authoritative. For refinement, change only requested intent fields, list exactly those fields in changedPaths, and preserve the others. Explain your tonal choices and tradeoffs concisely in at most 2000 characters. Advisory questions may return unchanged intent with empty changedPaths and a helpful explanation. Artist references are style cues, not verified rig claims. Never claim to have listened to or measured audio: this request contains text and rig descriptors only. Never invent installed equipment, available captures or physical amp knob settings. Captured NAM model controls are input/output trim; the physical captured settings are fixed. Amp EQ is post-capture EQ. The compiler handles supported DSP. Use issues muddy or harsh only when requested. Warn about ambiguity or unavailable capabilities. Return only the structured result.",
        "input":[{"role":"user","content":serde_json::to_string(&json!({"prompt":r.prompt,"baseline":r.baseline,"mode":if r.current_tone.is_some(){"refine"}else{"generate"},"currentTone":r.current_tone})).unwrap()}],
        "text":{"format":{"type":"json_schema","name":"toney_intent","strict":true,"schema":intent_schema()}}})
}
#[derive(Default)]
struct EventStream {
    pending: Vec<u8>,
    data: String,
    total: usize,
    output: String,
    complete: bool,
}
impl EventStream {
    fn feed(&mut self, chunk: &[u8], id: &str) -> Result<(), NativeError> {
        self.total += chunk.len();
        if self.total > MAX_STREAM {
            return Err(err(
                "CHATGPT_RESPONSE_TOO_LARGE",
                "ChatGPT stream exceeded its limit.",
                id,
            ));
        }
        self.pending.extend(chunk);
        while let Some(index) = self.pending.iter().position(|c| *c == b'\n') {
            let mut line = self.pending.drain(..=index).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = std::str::from_utf8(&line).map_err(|_| {
                err(
                    "CHATGPT_STREAM_INVALID",
                    "ChatGPT stream contained invalid text.",
                    id,
                )
            })?;
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = std::mem::take(&mut self.data);
                    self.event(&data, id)?;
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
            }
        }
        Ok(())
    }
    fn event(&mut self, data: &str, id: &str) -> Result<(), NativeError> {
        if data == "[DONE]" {
            return Ok(());
        }
        let v: Value = serde_json::from_str(data).map_err(|_| {
            err(
                "CHATGPT_STREAM_INVALID",
                "ChatGPT stream event was malformed.",
                id,
            )
        })?;
        match v["type"].as_str() {
            Some("response.output_text.delta") => {
                let delta = v["delta"].as_str().ok_or_else(|| {
                    err(
                        "CHATGPT_STREAM_INVALID",
                        "ChatGPT text event was malformed.",
                        id,
                    )
                })?;
                if self.output.len() + delta.len() > 65536 {
                    return Err(err(
                        "CHATGPT_RESPONSE_TOO_LARGE",
                        "Tone response exceeded its limit.",
                        id,
                    ));
                }
                self.output.push_str(delta);
            }
            Some("response.completed") => {
                if v["response"]["status"].as_str() != Some("completed") {
                    return Err(err(
                        "CHATGPT_INFERENCE_INCOMPLETE",
                        "ChatGPT did not complete its response; your rig has not changed.",
                        id,
                    ));
                }
                self.complete = true;
            }
            Some("response.failed" | "response.incomplete" | "error") => {
                return Err(err(
                    "CHATGPT_INFERENCE_FAILED",
                    "ChatGPT could not complete this tone request; retry or review plan limits.",
                    id,
                ))
            }
            Some("response.refusal.delta" | "response.refusal.done") => {
                return Err(err(
                    "CHATGPT_INFERENCE_REFUSED",
                    "ChatGPT declined this tone request. Try describing the sound differently.",
                    id,
                ))
            }
            _ => {}
        }
        Ok(())
    }
    fn finish(self, id: &str) -> Result<Value, NativeError> {
        if !self.complete || self.output.is_empty() {
            return Err(err(
                "CHATGPT_STREAM_INTERRUPTED",
                "ChatGPT stream ended before a completed tone response; your rig has not changed.",
                id,
            ));
        }
        let v = serde_json::from_str(&self.output).map_err(|_| {
            err(
                "CHATGPT_INTENT_INVALID",
                "ChatGPT returned malformed tone JSON; your rig has not changed.",
                id,
            )
        })?;
        validate_interpretation(&v, id)?;
        Ok(v)
    }
}
#[tauri::command]
pub async fn native_chatgpt_interpret(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, NativeError> {
    let r = interpret_request(request)?;
    let (c, generation) = active(&app, &r.request_id).await?;
    {
        let state = app.state::<ChatGptState>();
        let s = state.session.lock().await;
        if !s.models.iter().any(|m| m.slug == r.model) {
            return Err(err(
                "CHATGPT_MODEL_UNAVAILABLE",
                "Refresh account models and select an available model.",
                &r.request_id,
            ));
        }
    }
    let mut response = client(&r.request_id)?
        .post(format!("{RESOURCE}/responses"))
        .bearer_auth(&c.access_token)
        .json(&response_body(&r))
        .send()
        .await
        .map_err(|_| {
            err(
                "CHATGPT_NETWORK_FAILED",
                "Cannot reach ChatGPT; your rig has not changed.",
                &r.request_id,
            )
        })?;
    http_status(response.status(), &r.request_id)?;
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| s.starts_with("text/event-stream"))
    {
        return Err(err(
            "CHATGPT_STREAM_INVALID",
            "ChatGPT did not return the required event stream.",
            &r.request_id,
        ));
    }
    let mut stream = EventStream::default();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        err(
            "CHATGPT_STREAM_INTERRUPTED",
            "ChatGPT stream interrupted; your rig has not changed.",
            &r.request_id,
        )
    })? {
        if app.state::<ChatGptState>().session.lock().await.generation != generation {
            return Err(err(
                "CHATGPT_SESSION_CHANGED",
                "Account changed while generating tone; retry.",
                &r.request_id,
            ));
        }
        stream.feed(&chunk, &r.request_id)?;
    }
    if app.state::<ChatGptState>().session.lock().await.generation != generation {
        return Err(err(
            "CHATGPT_SESSION_CHANGED",
            "Account changed before tone completed; retry.",
            &r.request_id,
        ));
    }
    Ok(
        json!({"protocolVersion":1,"requestId":r.request_id,"model":r.model,"interpretation":stream.finish(&r.request_id)?}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending() -> Pending {
        Pending {
            state: "state-123".into(),
            nonce: "nonce-123".into(),
            verifier: "verifier-123".into(),
            redirect: "http://127.0.0.1:54321/auth/callback".into(),
            registration: None,
        }
    }
    fn baseline() -> Value {
        json!({"character":{"brightness":0.5,"warmth":0.5,"aggression":0.2,"clarity":0.6,"sustain":0.3,"width":0.1},"distortion":{"amount":0.2,"texture":"crunch"},"dynamics":{"compression":0.2,"transientPreservation":0.7},"space":{"reverb":0.1,"delay":0.0},"references":[]})
    }
    #[test]
    fn callback_requires_state_issued_client_and_matching_returning_registration() {
        let mut p = pending();
        assert!(parse_callback(
            "/auth/callback?state=wrong&code=secret&client_id=issued",
            &p
        )
        .unwrap()
        .is_none());
        assert!(parse_callback("/auth/callback?state=state-123&code=secret", &p).is_err());
        assert!(parse_callback(
            "/auth/callback?state=state-123&state=state-123&code=secret&client_id=issued",
            &p
        )
        .unwrap()
        .is_none());
        assert_eq!(
            parse_callback(
                "/auth/callback?state=state-123&code=secret&client_id=issued",
                &p
            )
            .unwrap()
            .unwrap()
            .1,
            "issued"
        );
        p.registration = Some(Registration {
            client_id: "issued".into(),
            subject: "subject".into(),
            email: None,
        });
        assert!(parse_callback(
            "/auth/callback?state=state-123&code=secret&client_id=other",
            &p
        )
        .is_err());
        assert!(
            parse_callback("/auth/callback?state=state-123&code=secret", &p)
                .unwrap()
                .is_some()
        );
        assert!(parse_callback("/auth/callback?state=state-123&error=access_denied", &p).is_err());
    }
    #[test]
    fn authorize_uses_bound_loopback_pkce_and_public_dynamic_registration() {
        let p = pending();
        let u = build_authorize(&p, "host-id");
        let fields: std::collections::HashMap<_, _> = u.query_pairs().collect();
        assert_eq!(fields["client_id"], "dynamic_agent_client");
        assert_eq!(fields["agent_name_hint"], "Toney");
        assert_eq!(fields["redirect_uri"], p.redirect);
        assert_eq!(fields["resource"], RESOURCE);
        assert_eq!(fields["code_challenge_method"], "S256");
        assert!(!fields.contains_key("client_secret"));
        assert!(permitted(&fields["scope"]));
    }
    #[test]
    fn jwt_signature_requires_trusted_key_payload_and_allowed_algorithm() {
        let fixture: Value =
            serde_json::from_str(include_str!("test-fixtures/chatgpt-jwt.json")).unwrap();
        let pair = ring::signature::RsaKeyPair::from_pkcs8(
            &URL_SAFE_NO_PAD
                .decode(fixture["pkcs8"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let header = json!({"alg":"RS256","kid":"test"});
        let signed = b"verified.header.and.claims";
        let mut signature = vec![0; pair.public().modulus_len()];
        pair.sign(
            &ring::signature::RSA_PKCS1_SHA256,
            &ring::rand::SystemRandom::new(),
            signed,
            &mut signature,
        )
        .unwrap();
        assert!(verify_signature(&header, &fixture["jwk"], signed, &signature).is_ok());
        assert!(
            verify_signature(&header, &fixture["jwk"], b"tampered.claims", &signature).is_err()
        );
        signature[0] ^= 1;
        assert!(verify_signature(&header, &fixture["jwk"], signed, &signature).is_err());
        assert!(verify_signature(&json!({"alg":"none"}), &fixture["jwk"], signed, &[]).is_err());
        assert!(verify_signature(&json!({"alg":"HS256"}), &fixture["jwk"], signed, &[]).is_err());
    }
    #[test]
    fn identity_claims_reject_wrong_nonce_account_expiry_and_future_issue() {
        let good =
            json!({"iss":ISSUER,"aud":"issued","sub":"person","iat":100,"exp":200,"nonce":"nonce"});
        assert!(validate_claims(&good, "issued", Some("nonce"), 150).is_ok());
        for (key, value) in [
            ("iss", json!("https://other.example")),
            ("aud", json!("other")),
            ("nonce", json!("wrong")),
            ("exp", json!(100)),
            ("iat", json!(180)),
            ("sub", json!("")),
        ] {
            let mut v = good.clone();
            v[key] = value;
            assert!(validate_claims(&v, "issued", Some("nonce"), 150).is_err());
        }
    }
    #[test]
    fn multiple_audiences_require_matching_authorized_party() {
        let mut claims = json!({"iss":ISSUER,"aud":["issued","other"],"sub":"person","iat":100,"exp":200,"nonce":"nonce"});
        assert!(validate_claims(&claims, "issued", Some("nonce"), 150).is_err());
        claims["azp"] = json!("other");
        assert!(validate_claims(&claims, "issued", Some("nonce"), 150).is_err());
        claims["azp"] = json!("issued");
        assert!(validate_claims(&claims, "issued", Some("nonce"), 150).is_ok());
        claims["aud"] = json!("issued");
        claims["azp"] = json!("other");
        assert!(validate_claims(&claims, "issued", Some("nonce"), 150).is_err());
        claims["azp"] = json!("issued");
        claims["aud"] = json!(["issued", 42]);
        assert!(validate_claims(&claims, "issued", Some("nonce"), 150).is_err());
    }
    #[test]
    fn catalog_uses_current_account_visibility_and_server_order() {
        let v = json!({"models":[{"slug":"quality","display_name":"Quality","visibility":"list"},{"slug":"hidden","visibility":"hidden"},{"slug":"fast","display_name":"Fast","visibility":"list"}]});
        let m = parse_models(&v, "request").unwrap();
        assert_eq!(
            m.iter().map(|m| m.slug.as_str()).collect::<Vec<_>>(),
            vec!["quality", "fast"]
        );
        assert!(parse_models(&json!({"models":[{"slug":"same","display_name":"One","visibility":"list"},{"slug":"same","display_name":"Two","visibility":"list"}]}),"request").is_err());
    }
    #[test]
    fn inference_payload_uses_plan_supported_transport_without_audio_or_system() {
        let r = InterpretRequest {
            protocol_version: 1,
            request_id: "request".into(),
            model: "catalog-model".into(),
            prompt: "warm jazz".into(),
            baseline: baseline(),
            current_tone: None,
        };
        let b = response_body(&r);
        assert_eq!(b["store"], false);
        assert_eq!(b["stream"], true);
        assert_eq!(b["input"][0]["role"], "user");
        assert!(b.get("max_output_tokens").is_none());
        assert!(b.get("temperature").is_none());
        let mut v=serde_json::to_value(json!({"protocolVersion":1,"requestId":"request","model":"catalog-model","prompt":"warm","baseline":baseline()})).unwrap();
        v["url"] = json!("https://other.example");
        assert!(interpret_request(v).is_err());
    }
    #[test]
    fn sse_handles_split_utf8_and_requires_completed_inference() {
        let output = json!({"intent":baseline(),"changedPaths":[],"warnings":[],"issues":[],"explanation":"Warmth with clarity — preserve picking."});
        let delta = json!({"type":"response.output_text.delta","delta":serde_json::to_string(&output).unwrap()});
        let events=format!("event: response.output_text.delta\r\ndata: {delta}\r\n\r\ndata: {{\"type\":\"response.completed\",\"response\":{{\"status\":\"completed\"}}}}\n\n");
        let mut stream = EventStream::default();
        for chunk in events.as_bytes().chunks(3) {
            stream.feed(chunk, "request").unwrap();
        }
        assert_eq!(stream.finish("request").unwrap(), output);
        let mut incomplete = EventStream::default();
        incomplete
            .feed(format!("data: {delta}\n\n").as_bytes(), "request")
            .unwrap();
        assert!(incomplete.finish("request").is_err());
        assert!(EventStream::default()
            .feed(b"data: {\"type\":\"response.failed\"}\n\n", "request")
            .is_err());
    }
    #[test]
    fn token_response_requires_granted_plan_scope_not_identity_only() {
        let value = json!({"access_token":"access","refresh_token":"refresh","id_token":"id","token_type":"Bearer","expires_in":3600,"scope":"openid profile email"});
        let r = Registration {
            client_id: "issued".into(),
            subject: "person".into(),
            email: None,
        };
        assert!(tokens(&value, r, None, "request").is_err());
    }
    #[test]
    fn protected_storage_is_atomic_private_and_rejects_symlinks() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("credential.json");
        save(&path, &"secret").unwrap();
        assert_eq!(read::<String>(&path).unwrap().unwrap(), "secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let link = d.path().join("link.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(read::<String>(&link).is_err());
        }
    }
}
