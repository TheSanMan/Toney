//! User-selected TONE3000 downloads. OAuth secrets remain in native memory.
use super::{
    assets::{self, AssetKind, AssetSource, StoredAsset},
    failure, validate_request_id, NativeError,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use url::Url;

const CLIENT_ID: &str = "t3k_pub_RRl-FnMtNQXyn4GNHiAgwg0SeyTcvpFb";
pub(super) const REDIRECT_URI: &str = "toney://tone3000/callback";
const API: &str = "https://www.tone3000.com/api/v1";
const MAX_JSON: usize = 2 * 1024 * 1024;
const MAX_ID: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(super) struct Tone3000State(Mutex<Session>);
#[derive(Default)]
struct Session {
    generation: u64,
    phase: Phase,
    kind: Option<AssetKind>,
    pending: Option<Pending>,
    tokens: Option<Tokens>,
    selection: Option<Selection>,
    error: Option<NativeError>,
    downloading: bool,
}
#[derive(Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Authorizing,
    Loading,
    Ready,
    Error,
}
struct Pending {
    state: String,
    verifier: String,
    deadline: Instant,
}
#[derive(Clone)]
struct Tokens {
    access: String,
    refresh: String,
    expires: Instant,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    id: u64,
    name: String,
    #[serde(skip)]
    download_url: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    tone_id: u64,
    name: String,
    creator: String,
    license: String,
    url: String,
    models: Vec<Model>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectRequest {
    protocol_version: u32,
    request_id: String,
    kind: AssetKind,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadRequest {
    protocol_version: u32,
    request_id: String,
    model_id: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadOutput {
    protocol_version: u32,
    request_id: String,
    descriptor: StoredAsset,
}

fn error(code: &str, message: &str) -> NativeError {
    failure(code, message, None)
}
fn validate_request(version: u32, id: &str) -> Result<(), NativeError> {
    validate_request_id(id)?;
    if version != 1 {
        return Err(failure(
            "TONE3000_PROTOCOL_INVALID",
            "TONE3000 protocol must be version 1.",
            Some(id),
        ));
    }
    Ok(())
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, NativeError> {
    let id = value.get("requestId").and_then(Value::as_str);
    serde_json::from_value(value.clone()).map_err(|_| {
        failure(
            "TONE3000_REQUEST_INVALID",
            "Invalid TONE3000 request fields.",
            id,
        )
    })
}
fn lock(state: &Tone3000State) -> Result<std::sync::MutexGuard<'_, Session>, NativeError> {
    state.0.lock().map_err(|_| {
        error(
            "TONE3000_SESSION_FAILED",
            "Cannot access the TONE3000 session.",
        )
    })
}
fn status(session: &mut Session, request_id: &str) -> Value {
    if session
        .pending
        .as_ref()
        .is_some_and(|pending| Instant::now() >= pending.deadline)
    {
        session.pending = None;
        session.tokens = None;
        session.selection = None;
        session.phase = Phase::Error;
        session.error = Some(error(
            "TONE3000_AUTH_EXPIRED",
            "Selection expired. Browse a tone again.",
        ));
    }
    let phase = match session.phase {
        Phase::Idle => "idle",
        Phase::Authorizing => "authorizing",
        Phase::Loading => "loading",
        Phase::Ready => "ready",
        Phase::Error => "error",
    };
    let mut output = json!({"protocolVersion":1,"requestId":request_id,"status":phase});
    if let Some(kind) = session.kind {
        output["kind"] = json!(kind);
    }
    if let Some(selection) = &session.selection {
        output["selection"] = json!(selection);
    }
    if let Some(failure) = &session.error {
        output["error"] = json!({"code":failure.code,"message":failure.message});
    }
    output
}
fn random() -> Result<String, NativeError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| {
        error(
            "TONE3000_AUTH_FAILED",
            "Cannot generate a secure authorization request.",
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn authorization(kind: AssetKind) -> Result<(Url, Pending), NativeError> {
    let verifier = random()?;
    let pending = Pending {
        state: random()?,
        verifier,
        deadline: Instant::now() + Duration::from_secs(600),
    };
    let mut url = Url::parse(&format!("{API}/oauth/authorize")).expect("fixed API URL");
    url.query_pairs_mut().extend_pairs([
        ("client_id", CLIENT_ID),
        ("redirect_uri", REDIRECT_URI),
        ("response_type", "code"),
        ("code_challenge_method", "S256"),
        ("state", &pending.state),
        (
            "code_challenge",
            &URL_SAFE_NO_PAD.encode(Sha256::digest(pending.verifier.as_bytes())),
        ),
        ("prompt", "select_tone"),
        ("menubar", "true"),
        ("preview", "true"),
        ("gears", if kind == AssetKind::Nam { "amp" } else { "cab" }),
        ("format", if kind == AssetKind::Nam { "nam" } else { "ir" }),
    ]);
    if kind == AssetKind::Nam {
        url.query_pairs_mut().append_pair("architecture", "1");
    }
    Ok((url, pending))
}
#[tauri::command]
pub(super) async fn native_tone3000_select(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, NativeError> {
    let request: SelectRequest = decode(request)?;
    validate_request(request.protocol_version, &request.request_id)?;
    let (url, pending) = authorization(request.kind)?;
    let generation = {
        let state = app.state::<Tone3000State>();
        let mut session = lock(&state)?;
        if session.downloading
            || session.phase == Phase::Loading
            || session.phase == Phase::Authorizing
        {
            return Err(failure(
                "TONE3000_BUSY",
                "Finish or close the current selection first.",
                Some(&request.request_id),
            ));
        }
        let generation = session.generation.wrapping_add(1);
        *session = Session {
            generation,
            phase: Phase::Authorizing,
            kind: Some(request.kind),
            pending: Some(pending),
            ..Session::default()
        };
        generation
    };
    // Only a generated, fixed-origin OAuth URL reaches the existing native shell plugin.
    #[allow(deprecated)]
    let opened = app.shell().open(url.as_str(), None);
    if opened.is_err() {
        let state = app.state::<Tone3000State>();
        let mut session = lock(&state)?;
        if session.generation == generation {
            session.pending = None;
            session.phase = Phase::Error;
            session.error = Some(error(
                "TONE3000_BROWSER_FAILED",
                "Cannot open your browser. Close this selection and try again.",
            ));
        }
    }
    let state = app.state::<Tone3000State>();
    let mut session = lock(&state)?;
    Ok(status(&mut session, &request.request_id))
}
#[tauri::command]
pub(super) async fn native_tone3000_status(
    state: tauri::State<'_, Tone3000State>,
    request: Value,
) -> Result<Value, NativeError> {
    let request: Request = decode(request)?;
    validate_request(request.protocol_version, &request.request_id)?;
    let mut session = lock(&state)?;
    Ok(status(&mut session, &request.request_id))
}
#[tauri::command]
pub(super) async fn native_tone3000_cancel(
    state: tauri::State<'_, Tone3000State>,
    request: Value,
) -> Result<Value, NativeError> {
    let request: Request = decode(request)?;
    validate_request(request.protocol_version, &request.request_id)?;
    let mut session = lock(&state)?;
    let generation = session.generation.wrapping_add(1);
    *session = Session {
        generation,
        ..Session::default()
    };
    Ok(status(&mut session, &request.request_id))
}
struct Callback {
    state: String,
    code: Option<String>,
    tone_id: Option<u64>,
    canceled: bool,
    denied: bool,
}
fn callback(url: &Url) -> Result<Callback, NativeError> {
    if url.as_str().len() > 8192
        || url.scheme() != "toney"
        || url.host_str() != Some("tone3000")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(error(
            "TONE3000_CALLBACK_INVALID",
            "Invalid authorization callback.",
        ));
    }
    let mut parameters = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if !matches!(
            key.as_ref(),
            "state" | "code" | "tone_id" | "canceled" | "error" | "error_description"
        ) || parameters
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(error(
                "TONE3000_CALLBACK_INVALID",
                "Invalid authorization callback fields.",
            ));
        }
    }
    let state = parameters
        .remove("state")
        .filter(|s| s.len() == 43)
        .ok_or_else(|| error("TONE3000_STATE_INVALID", "Missing authorization state."))?;
    let code = parameters.remove("code");
    if code.as_ref().is_some_and(|code| {
        code.is_empty() || code.len() > 4096 || code.chars().any(char::is_control)
    }) {
        return Err(error(
            "TONE3000_CALLBACK_INVALID",
            "Invalid authorization code.",
        ));
    }
    let tone_id = parameters
        .remove("tone_id")
        .map(|id| id.parse::<u64>())
        .transpose()
        .map_err(|_| error("TONE3000_CALLBACK_INVALID", "Invalid selected tone ID."))?;
    if tone_id.is_some_and(|id| id == 0 || id > MAX_ID) {
        return Err(error(
            "TONE3000_CALLBACK_INVALID",
            "Invalid selected tone ID.",
        ));
    }
    let canceled = parameters
        .get("canceled")
        .is_some_and(|value| value == "true");
    let denied = parameters.contains_key("error");
    if !canceled && !denied && (code.is_none() || tone_id.is_none()) {
        return Err(error(
            "TONE3000_CALLBACK_INVALID",
            "No selected tone was returned.",
        ));
    }
    Ok(Callback {
        state,
        code,
        tone_id,
        canceled,
        denied,
    })
}
struct AuthorizationGrant {
    generation: u64,
    kind: AssetKind,
    code: String,
    verifier: String,
    tone_id: u64,
}
fn consume_callback(
    session: &mut Session,
    returned: Callback,
) -> Result<Option<AuthorizationGrant>, NativeError> {
    let pending = session
        .pending
        .as_ref()
        .ok_or_else(|| error("TONE3000_STATE_INVALID", "No pending selection."))?;
    if pending.state != returned.state || Instant::now() >= pending.deadline {
        return Err(error(
            "TONE3000_STATE_INVALID",
            "Authorization state does not match the pending selection.",
        ));
    }
    let pending = session.pending.take().expect("checked pending");
    if returned.canceled || returned.denied {
        let generation = session.generation.wrapping_add(1);
        *session = Session {
            generation,
            ..Session::default()
        };
        return Ok(None);
    }
    let kind = session
        .kind
        .ok_or_else(|| error("TONE3000_SESSION_FAILED", "Selection has no target kind."))?;
    session.phase = Phase::Loading;
    Ok(Some(AuthorizationGrant {
        generation: session.generation,
        kind,
        code: returned.code.expect("checked code"),
        verifier: pending.verifier,
        tone_id: returned.tone_id.expect("checked tone id"),
    }))
}
fn client() -> Result<reqwest::Client, NativeError> {
    reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| {
            error(
                "TONE3000_NETWORK_FAILED",
                "Cannot initialize the online connection.",
            )
        })
}
fn delivery_url(value: &str) -> Result<Url, NativeError> {
    let url = Url::parse(value).map_err(|_| {
        error(
            "TONE3000_URL_INVALID",
            "TONE3000 supplied an invalid download address.",
        )
    })?;
    if value.len() > 4096
        || value.trim() != value
        || value.chars().any(char::is_control)
        || url.scheme() != "https"
        || url.host_str() != Some("www.tone3000.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/api/v1/")
    {
        return Err(error("TONE3000_URL_UNSUPPORTED", "This download address is outside the supported TONE3000 API. Choose another model or report this error."));
    }
    Ok(url)
}
fn http_status(status: reqwest::StatusCode) -> Result<(), NativeError> {
    if status.is_success() {
        return Ok(());
    }
    Err(match status.as_u16() {
        401 => error("TONE3000_AUTH_REQUIRED", "Account authorization expired. Close the selection and browse again."),
        403 => error("TONE3000_ACCESS_DENIED", "Your account cannot access this model."),
        429 => error("TONE3000_RATE_LIMITED", "TONE3000 is rate limiting requests. Wait a minute and try again."),
        300..=399 => error("TONE3000_REDIRECT_UNSUPPORTED", "TONE3000 changed its file delivery address. Report this error so the new delivery origin can be verified."),
        _ => error("TONE3000_HTTP_FAILED", "TONE3000 could not complete this request. Try again later."),
    })
}
fn append_bounded(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), NativeError> {
    if chunk.len() > limit.saturating_sub(bytes.len()) {
        return Err(error(
            "TONE3000_RESPONSE_TOO_LARGE",
            "TONE3000 response exceeds the supported size limit.",
        ));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
async fn response_bytes(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, NativeError> {
    http_status(response.status())?;
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(error(
            "TONE3000_RESPONSE_TOO_LARGE",
            "TONE3000 response exceeds the supported size limit.",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        error(
            "TONE3000_NETWORK_FAILED",
            "The download was interrupted. Try again.",
        )
    })? {
        append_bounded(&mut bytes, &chunk, limit)?;
    }
    if bytes.is_empty() {
        return Err(error(
            "TONE3000_RESPONSE_INVALID",
            "TONE3000 returned an empty response.",
        ));
    }
    Ok(bytes)
}
async fn json_request(request: reqwest::RequestBuilder) -> Result<Value, NativeError> {
    let response = request.send().await.map_err(|_| {
        error(
            "TONE3000_NETWORK_FAILED",
            "Cannot reach TONE3000. Check your internet connection and try again.",
        )
    })?;
    let bytes = response_bytes(response, MAX_JSON).await?;
    serde_json::from_slice(&bytes).map_err(|_| {
        error(
            "TONE3000_RESPONSE_INVALID",
            "TONE3000 returned invalid metadata.",
        )
    })
}
fn parse_tokens(value: Value) -> Result<Tokens, NativeError> {
    let text = |key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| {
                !text.is_empty() && text.len() <= 8192 && !text.chars().any(char::is_control)
            })
            .map(str::to_owned)
    };
    let access = text("access_token").ok_or_else(|| {
        error(
            "TONE3000_TOKEN_INVALID",
            "TONE3000 returned invalid account authorization.",
        )
    })?;
    let refresh = text("refresh_token").ok_or_else(|| {
        error(
            "TONE3000_TOKEN_INVALID",
            "TONE3000 returned invalid account authorization.",
        )
    })?;
    let seconds = value
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0 && *v <= 86400)
        .ok_or_else(|| {
            error(
                "TONE3000_TOKEN_INVALID",
                "TONE3000 returned invalid account authorization.",
            )
        })?;
    if !value
        .get("token_type")
        .and_then(Value::as_str)
        .is_some_and(|v| v.eq_ignore_ascii_case("bearer"))
    {
        return Err(error(
            "TONE3000_TOKEN_INVALID",
            "Unsupported account authorization type.",
        ));
    }
    Ok(Tokens {
        access,
        refresh,
        expires: Instant::now() + Duration::from_secs(seconds),
    })
}
async fn exchange(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
) -> Result<Tokens, NativeError> {
    parse_tokens(
        json_request(client.post(format!("{API}/oauth/token")).form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", CLIENT_ID),
        ]))
        .await?,
    )
}
async fn refresh(client: &reqwest::Client, tokens: Tokens) -> Result<Tokens, NativeError> {
    if Instant::now() + Duration::from_secs(30) < tokens.expires {
        return Ok(tokens);
    }
    parse_tokens(
        json_request(client.post(format!("{API}/oauth/token")).form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &tokens.refresh),
            ("client_id", CLIENT_ID),
        ]))
        .await?,
    )
}
fn safe_text(value: &Value, field: &str) -> Result<String, NativeError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|v| {
            !v.trim().is_empty()
                && v.encode_utf16().count() <= 200
                && !v.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            error(
                "TONE3000_RESPONSE_INVALID",
                "TONE3000 returned missing or overlong display metadata.",
            )
        })
}
fn parse_selection(
    tone_id: u64,
    kind: AssetKind,
    tone: Value,
    models: Value,
) -> Result<Selection, NativeError> {
    let format = if kind == AssetKind::Nam { "nam" } else { "ir" };
    let gear = if kind == AssetKind::Nam { "amp" } else { "cab" };
    if tone.get("id").and_then(Value::as_u64) != Some(tone_id)
        || tone.get("format").and_then(Value::as_str) != Some(format)
        || tone.get("gear").and_then(Value::as_str) != Some(gear)
    {
        return Err(error(
            "TONE3000_MODEL_INCOMPATIBLE",
            "Choose an amp NAM A1 capture or cabinet IR matching this signal block.",
        ));
    }
    let name = safe_text(&tone, "title")?;
    let creator = safe_text(
        tone.get("user")
            .ok_or_else(|| error("TONE3000_RESPONSE_INVALID", "Creator metadata is missing."))?,
        "username",
    )?;
    let license = safe_text(&tone, "license")?;
    let url = tone
        .get("url")
        .and_then(Value::as_str)
        .filter(|v| assets::valid_source_url(v))
        .ok_or_else(|| error("TONE3000_RESPONSE_INVALID", "Tone source URL is invalid."))?
        .to_owned();
    let data = models
        .get("data")
        .and_then(Value::as_array)
        .filter(|v| v.len() <= 128)
        .ok_or_else(|| {
            error(
                "TONE3000_RESPONSE_INVALID",
                "The model list exceeds the supported bounds.",
            )
        })?;
    let mut variants = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for model in data {
        let architecture = model.get("architecture_version");
        let compatible = if kind == AssetKind::Nam {
            architecture.is_some_and(|v| v.as_str() == Some("1") || v.as_u64() == Some(1))
        } else {
            architecture.is_some_and(Value::is_null)
        };
        if !compatible {
            continue;
        }
        let id = model
            .get("id")
            .and_then(Value::as_u64)
            .filter(|v| *v > 0 && *v <= MAX_ID)
            .ok_or_else(|| error("TONE3000_RESPONSE_INVALID", "Invalid model ID."))?;
        if model.get("tone_id").and_then(Value::as_u64) != Some(tone_id) || !ids.insert(id) {
            return Err(error(
                "TONE3000_RESPONSE_INVALID",
                "The model list does not match the selected tone.",
            ));
        }
        let download_url = model
            .get("model_url")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                error(
                    "TONE3000_RESPONSE_INVALID",
                    "Model download address is missing.",
                )
            })?;
        delivery_url(download_url)?;
        variants.push(Model {
            id,
            name: safe_text(model, "name")?,
            download_url: download_url.into(),
        });
    }
    if variants.is_empty() {
        return Err(error(
            "TONE3000_MODEL_INCOMPATIBLE",
            "This tone has no compatible model variants. Browse another tone.",
        ));
    }
    Ok(Selection {
        tone_id,
        name,
        creator,
        license,
        url,
        models: variants,
    })
}
async fn fetch_selection(
    client: &reqwest::Client,
    tokens: &Tokens,
    kind: AssetKind,
    tone_id: u64,
) -> Result<Selection, NativeError> {
    let tone = json_request(
        client
            .get(format!("{API}/tones/{tone_id}"))
            .bearer_auth(&tokens.access),
    )
    .await?;
    let mut url = Url::parse(&format!("{API}/models")).expect("fixed URL");
    url.query_pairs_mut().extend_pairs([
        ("tone_id", tone_id.to_string()),
        ("page", "1".into()),
        ("page_size", "128".into()),
    ]);
    if kind == AssetKind::Nam {
        url.query_pairs_mut().append_pair("architecture", "1");
    }
    let models = json_request(client.get(url).bearer_auth(&tokens.access)).await?;
    parse_selection(tone_id, kind, tone, models)
}
pub(super) async fn handle_callback(app: tauri::AppHandle, url: Url) {
    let Ok(returned) = callback(&url) else {
        return;
    };
    let operation = {
        let state = app.state::<Tone3000State>();
        let Ok(mut session) = lock(&state) else {
            return;
        };
        let Ok(operation) = consume_callback(&mut session, returned) else {
            return;
        };
        operation
    };
    let Some(AuthorizationGrant {
        generation,
        kind,
        code,
        verifier,
        tone_id,
    }) = operation
    else {
        return;
    };
    let result = async {
        let client = client()?;
        let tokens = exchange(&client, &code, &verifier).await?;
        let selection = fetch_selection(&client, &tokens, kind, tone_id).await?;
        Ok::<_, NativeError>((tokens, selection))
    }
    .await;
    let state = app.state::<Tone3000State>();
    if let Ok(mut session) = lock(&state) {
        if session.generation != generation {
            return;
        }
        match result {
            Ok((tokens, selection)) => {
                session.tokens = Some(tokens);
                session.selection = Some(selection);
                session.phase = Phase::Ready;
            }
            Err(failure) => {
                session.tokens = None;
                session.selection = None;
                session.phase = Phase::Error;
                session.error = Some(failure);
            }
        }
    };
}
fn filename(name: &str, kind: AssetKind) -> String {
    let mut result: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '.') {
                '_'
            } else {
                c
            }
        })
        .take(90)
        .collect();
    if result.trim().is_empty() {
        result = "TONE3000 model".into();
    }
    format!(
        "{}.{}",
        result.trim(),
        if kind == AssetKind::Nam { "nam" } else { "wav" }
    )
}
#[tauri::command]
pub(super) async fn native_tone3000_download(
    app: tauri::AppHandle,
    request: Value,
) -> Result<DownloadOutput, NativeError> {
    let request: DownloadRequest = decode(request)?;
    validate_request(request.protocol_version, &request.request_id)?;
    let (generation, kind, selection, model, tokens) = {
        let state = app.state::<Tone3000State>();
        let mut session = lock(&state)?;
        if session.phase != Phase::Ready || session.downloading {
            return Err(failure(
                "TONE3000_SELECTION_REQUIRED",
                "Choose a tone and finish any current download first.",
                Some(&request.request_id),
            ));
        }
        let selection = session
            .selection
            .clone()
            .ok_or_else(|| error("TONE3000_SELECTION_REQUIRED", "Choose a tone first."))?;
        let model = selection
            .models
            .iter()
            .find(|m| m.id == request.model_id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    "TONE3000_MODEL_FORBIDDEN",
                    "Download a variant from the current user selection.",
                    Some(&request.request_id),
                )
            })?;
        let tokens = session
            .tokens
            .take()
            .ok_or_else(|| error("TONE3000_AUTH_REQUIRED", "Connect your account again."))?;
        session.downloading = true;
        (
            session.generation,
            session.kind.expect("ready kind"),
            selection,
            model,
            tokens,
        )
    };
    let result = async {
        let client = client()?;
        let tokens = refresh(&client, tokens).await?;
        {
            let state = app.state::<Tone3000State>();
            let mut session = lock(&state)?;
            if session.generation != generation {
                return Err(error("TONE3000_CANCELED", "The selection was closed."));
            }
            session.tokens = Some(tokens.clone());
        }
        let response = client
            .get(delivery_url(&model.download_url)?)
            .bearer_auth(&tokens.access)
            .send()
            .await
            .map_err(|_| {
                error(
                    "TONE3000_NETWORK_FAILED",
                    "Cannot download this model. Check your connection and try again.",
                )
            })?;
        let bytes = response_bytes(response, kind.limit()).await?;
        {
            let state = app.state::<Tone3000State>();
            let session = lock(&state)?;
            if session.generation != generation {
                return Err(error("TONE3000_CANCELED", "The selection was closed."));
            }
        }
        let source = AssetSource {
            provider: "tone3000".into(),
            tone_id: selection.tone_id,
            model_id: model.id,
            tone_name: selection.name,
            creator: selection.creator,
            license: selection.license,
            url: selection.url,
        };
        // Return credentials to native memory before helper inspection, including on helper failure.
        {
            let state = app.state::<Tone3000State>();
            let mut session = lock(&state)?;
            if session.generation != generation {
                return Err(error("TONE3000_CANCELED", "The selection was closed."));
            }
            session.tokens = Some(tokens);
        }
        assets::import_downloaded_asset(
            app.clone(),
            request.request_id.clone(),
            kind,
            filename(&model.name, kind),
            bytes,
            source,
        )
        .await
    }
    .await;
    {
        let state = app.state::<Tone3000State>();
        let mut session = lock(&state)?;
        if session.generation == generation {
            session.downloading = false;
            if session.tokens.is_none() {
                session.phase = Phase::Error;
                session.selection = None;
                session.error = Some(error(
                    "TONE3000_RECONNECT_REQUIRED",
                    "Close this selection and browse again to reconnect.",
                ));
            }
        }
    }
    result
        .map(|descriptor| DownloadOutput {
            protocol_version: 1,
            request_id: request.request_id.clone(),
            descriptor,
        })
        .map_err(|mut failure| {
            failure.request_id = Some(request.request_id);
            failure
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_session() -> Session {
        let (_, pending) = authorization(AssetKind::Nam).unwrap();
        Session {
            generation: 4,
            kind: Some(AssetKind::Nam),
            phase: Phase::Authorizing,
            pending: Some(pending),
            ..Session::default()
        }
    }
    fn return_url(state: &str) -> Url {
        Url::parse(&format!(
            "{REDIRECT_URI}?state={state}&code=fixture-code&tone_id=12"
        ))
        .unwrap()
    }
    fn metadata() -> (Value, Value) {
        (
            json!({"id":12,"title":"Studio amp","user":{"username":"creator"},"gear":"amp","format":"nam","license":"cc-by","url":"https://www.tone3000.com/tones/studio-amp"}),
            json!({"data":[{"id":34,"tone_id":12,"name":"Clean","architecture_version":"1","model_url":"https://www.tone3000.com/api/v1/models/34/download"}]}),
        )
    }
    #[test]
    fn pkce_is_random_and_catalog_constraints_match_engine_target() {
        let (amp, pending) = authorization(AssetKind::Nam).unwrap();
        let (_, other) = authorization(AssetKind::Nam).unwrap();
        assert_ne!(pending.state, other.state);
        assert_ne!(pending.verifier, other.verifier);
        assert_eq!(pending.verifier.len(), 43);
        let query: BTreeMap<_, _> = amp
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(
            query["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(pending.verifier.as_bytes()))
        );
        assert_eq!(query["prompt"], "select_tone");
        assert_eq!(query["architecture"], "1");
        assert_eq!(query["gears"], "amp");
        assert!(!amp.as_str().contains(&pending.verifier));
        let (cab, _) = authorization(AssetKind::Ir).unwrap();
        let cab_query: BTreeMap<_, _> = cab.query_pairs().collect();
        assert_eq!(cab_query.get("format").unwrap(), "ir");
        assert_eq!(cab_query.get("gears").unwrap(), "cab");
        assert!(!cab_query.contains_key("architecture"));
    }
    #[test]
    fn callbacks_are_single_use_state_bound_and_cancellation_clears_credentials() {
        let mut session = pending_session();
        let state = session.pending.as_ref().unwrap().state.clone();
        assert!(consume_callback(
            &mut session,
            callback(&return_url(&"x".repeat(43))).unwrap()
        )
        .is_err());
        assert!(session.pending.is_some());
        let returned = return_url(&state);
        assert!(consume_callback(&mut session, callback(&returned).unwrap())
            .unwrap()
            .is_some());
        assert!(session.phase == Phase::Loading);
        assert!(session.pending.is_none());
        assert!(consume_callback(&mut session, callback(&returned).unwrap()).is_err());
        let mut session = pending_session();
        let state = session.pending.as_ref().unwrap().state.clone();
        let closed = Url::parse(&format!(
            "{REDIRECT_URI}?state={state}&canceled=true&code=fixture-code"
        ))
        .unwrap();
        assert!(consume_callback(&mut session, callback(&closed).unwrap())
            .unwrap()
            .is_none());
        assert_eq!(
            status(&mut session, "fixture"),
            json!({"protocolVersion":1,"requestId":"fixture","status":"idle"})
        );
    }
    #[test]
    fn callback_rejects_ambiguous_destinations_duplicate_fields_and_stale_requests() {
        for value in [
            "toney://elsewhere/callback?state=x", "https://tone3000.com/callback?state=x", "toney://user@tone3000/callback?state=x",
            "toney://tone3000/callback?state=x&state=y", "toney://tone3000/callback?state=x#code", "toney://tone3000/callback?state=x&tone_id=0",
            "toney://tone3000/callback?state=x&code=secret&tone_id=1&download_url=https://evil.test",
        ] { assert!(callback(&Url::parse(value).unwrap()).is_err()); }
        let mut session = pending_session();
        session.pending.as_mut().unwrap().deadline = Instant::now() - Duration::from_secs(1);
        let state = session.pending.as_ref().unwrap().state.clone();
        assert!(consume_callback(&mut session, callback(&return_url(&state)).unwrap()).is_err());
        let expired = status(&mut session, "fixture");
        assert_eq!(expired["status"], "error");
        assert!(session.pending.is_none());
        assert!(!expired.to_string().contains(&state));
    }
    #[test]
    fn bearer_delivery_is_restricted_to_official_api_origin() {
        assert!(delivery_url("https://www.tone3000.com/api/v1/models/34/download").is_ok());
        for url in [
            "http://www.tone3000.com/api/v1/models/34",
            "https://www.tone3000.com.evil.test/api/v1/model",
            "https://user@www.tone3000.com/api/v1/model",
            "https://www.tone3000.com:444/api/v1/model",
            "https://127.0.0.1/api/v1/model",
            "https://www.tone3000.com/settings",
            "https://cdn.example.test/model.nam",
            "https://www.tone3000.com/api/v1/model#token",
        ] {
            assert!(delivery_url(url).is_err(), "unexpectedly accepted {url}");
        }
        assert_eq!(
            http_status(reqwest::StatusCode::FOUND).unwrap_err().code,
            "TONE3000_REDIRECT_UNSUPPORTED"
        );
        assert_eq!(
            http_status(reqwest::StatusCode::TOO_MANY_REQUESTS)
                .unwrap_err()
                .code,
            "TONE3000_RATE_LIMITED"
        );
    }
    #[test]
    fn selected_models_match_tone_and_only_compatible_variants_enter_public_status() {
        let (tone, models) = metadata();
        let selected = parse_selection(12, AssetKind::Nam, tone.clone(), models.clone()).unwrap();
        let public = serde_json::to_string(&selected).unwrap();
        assert!(!public.contains("download"));
        assert!(public.contains("creator"));
        assert!(public.contains("cc-by"));
        let mut wrong = models.clone();
        wrong["data"][0]["tone_id"] = json!(99);
        assert!(parse_selection(12, AssetKind::Nam, tone.clone(), wrong).is_err());
        let mut advanced = models.clone();
        advanced["data"][0]["architecture_version"] = json!("2");
        assert!(parse_selection(12, AssetKind::Nam, tone.clone(), advanced).is_err());
        let mut duplicate = models.clone();
        duplicate["data"]
            .as_array_mut()
            .unwrap()
            .push(models["data"][0].clone());
        assert!(parse_selection(12, AssetKind::Nam, tone.clone(), duplicate).is_err());
        let mut unsafe_url = models;
        unsafe_url["data"][0]["model_url"] = json!("https://evil.test/model");
        assert!(parse_selection(12, AssetKind::Nam, tone.clone(), unsafe_url).is_err());
        assert!(parse_selection(12, AssetKind::Ir, tone, json!({"data":[]})).is_err());
    }
    #[test]
    fn bounded_responses_and_tokens_cannot_leak_through_status_or_errors() {
        let mut bytes = vec![1, 2];
        assert!(append_bounded(&mut bytes, &[3, 4], 4).is_ok());
        assert!(append_bounded(&mut bytes, &[5], 4).is_err());
        assert_eq!(bytes, vec![1, 2, 3, 4]);
        let tokens = parse_tokens(json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"bearer","expires_in":3600})).unwrap();
        let mut session = pending_session();
        session.tokens = Some(tokens);
        let output = status(&mut session, "fixture").to_string();
        assert!(!output.contains("fixture-access"));
        assert!(!output.contains("fixture-refresh"));
        let invalid = parse_tokens(
            json!({"access_token":"secret-value","refresh_token":"refresh","token_type":"basic","expires_in":3600}),
        );
        let error = invalid.err().unwrap();
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("secret-value"));
        let rejected: Result<DownloadRequest, _> = decode(
            json!({"protocolVersion":1,"requestId":"fixture","modelId":34,"url":"https://evil.test"}),
        );
        assert!(rejected.is_err());
    }
    #[test]
    fn downloaded_names_have_no_paths_and_remain_within_asset_bounds() {
        assert_eq!(
            filename("../My/amp.nam", AssetKind::Nam),
            "___My_amp_nam.nam"
        );
        assert_eq!(filename("  ", AssetKind::Ir), "TONE3000 model.wav");
        assert!(
            filename(&"🎸".repeat(200), AssetKind::Nam)
                .encode_utf16()
                .count()
                < 200
        );
    }
}
