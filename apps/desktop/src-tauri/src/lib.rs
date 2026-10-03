mod assets;
mod chatgpt;
mod tone3000;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use std::{
    io::{Read, Write},
    path::Path,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const MAX_ENGINE_BYTES: usize = 256 * 1024;
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OLLAMA_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

fn failure(code: &str, message: impl Into<String>, request_id: Option<&str>) -> NativeError {
    NativeError {
        code: code.into(),
        message: message.into(),
        request_id: request_id.filter(|id| id.len() <= 128).map(str::to_owned),
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EngineRequest {
    protocol_version: u32,
    request_id: String,
    command: EngineCommand,
    #[serde(skip_serializing_if = "Option::is_none")]
    tone: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    render: Option<RenderPaths>,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset: Option<assets::TrustedAssetPath>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderPaths {
    input_path: String,
    output_path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    assets: Vec<assets::TrustedAssetPath>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum EngineCommand {
    GetEngineInfo,
    GetAudioDevices,
    ValidateToneSpec,
    RenderAudio,
    InspectAsset,
}

fn validate_engine_request(value: Value) -> Result<EngineRequest, NativeError> {
    let id = value.get("requestId").and_then(Value::as_str);
    if matches!(
        value.get("command").and_then(Value::as_str),
        Some("render_audio" | "inspect_asset")
    ) || value.get("render").is_some()
        || value.get("asset").is_some()
        || value.get("path").is_some()
    {
        return Err(failure(
            "ENGINE_REQUEST_FORBIDDEN",
            "Rendering and asset inspection are available only through dedicated native commands.",
            id,
        ));
    }
    if serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_ENGINE_BYTES) {
        return Err(failure(
            "ENGINE_REQUEST_TOO_LARGE",
            "Native engine request exceeds 256 KiB.",
            id,
        ));
    }
    let request: EngineRequest = serde_json::from_value(value.clone()).map_err(|_| {
        failure(
            "ENGINE_REQUEST_INVALID",
            "Invalid native engine request fields or command.",
            id,
        )
    })?;
    if request.protocol_version != 1 {
        return Err(failure(
            "ENGINE_PROTOCOL_UNSUPPORTED",
            "Native engine protocol must be version 1.",
            id,
        ));
    }
    validate_request_id(&request.request_id)?;
    match request.command {
        EngineCommand::ValidateToneSpec if !request.tone.as_ref().is_some_and(Value::is_object) => {
            return Err(failure(
                "ENGINE_TONE_MISSING",
                "Tone validation requires a ToneSpec object.",
                id,
            ));
        }
        EngineCommand::GetEngineInfo | EngineCommand::GetAudioDevices if request.tone.is_some() => {
            return Err(failure(
                "ENGINE_TONE_UNEXPECTED",
                "This engine command does not accept a tone.",
                id,
            ));
        }
        _ => {}
    }
    Ok(request)
}

fn validate_engine_response(bytes: &[u8], request: &EngineRequest) -> Result<Value, NativeError> {
    let id = Some(request.request_id.as_str());
    if bytes.len() > MAX_ENGINE_BYTES {
        return Err(failure(
            "ENGINE_RESPONSE_TOO_LARGE",
            "Native engine response exceeds 256 KiB.",
            id,
        ));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        failure(
            "ENGINE_RESPONSE_INVALID",
            "Native engine returned malformed JSON.",
            id,
        )
    })?;
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || value.get("requestId").and_then(Value::as_str) != id
    {
        return Err(failure(
            "ENGINE_RESPONSE_MISMATCH",
            "Native engine response version or request ID did not match.",
            id,
        ));
    }
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            let expected = match request.command {
                EngineCommand::GetEngineInfo => "engine-info",
                EngineCommand::GetAudioDevices => "audio-devices",
                EngineCommand::ValidateToneSpec => "rig-valid",
                EngineCommand::RenderAudio => "audio-render",
                EngineCommand::InspectAsset => "asset-info",
            };
            if value.pointer("/result/kind").and_then(Value::as_str) != Some(expected) {
                return Err(failure(
                    "ENGINE_RESPONSE_INVALID",
                    "Native engine returned an unexpected result kind.",
                    id,
                ));
            }
        }
        Some(false)
            if value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .is_some()
                && value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .is_some() => {}
        _ => {
            return Err(failure(
                "ENGINE_RESPONSE_INVALID",
                "Native engine returned an invalid result envelope.",
                id,
            ))
        }
    }
    Ok(value)
}

#[tauri::command]
async fn native_engine_request(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, NativeError> {
    run_engine_request(
        app,
        validate_engine_request(request)?,
        Duration::from_secs(10),
    )
    .await
}

async fn run_engine_request<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: EngineRequest,
    deadline: Duration,
) -> Result<Value, NativeError> {
    let id = Some(request.request_id.as_str());
    let command = app
        .shell()
        .sidecar("toney-engine")
        .map_err(|error| failure("ENGINE_UNAVAILABLE", error.to_string(), id))?;
    let (mut events, mut child) = command
        .set_raw_out(true)
        .spawn()
        .map_err(|error| failure("ENGINE_START_FAILED", error.to_string(), id))?;
    let mut input = serde_json::to_vec(&request)
        .map_err(|error| failure("ENGINE_REQUEST_INVALID", error.to_string(), id))?;
    input.push(b'\n');
    if let Err(error) = child.write(&input) {
        let _ = child.kill();
        return Err(failure("ENGINE_WRITE_FAILED", error.to_string(), id));
    }
    let response = tokio::time::timeout(deadline, async {
        let mut output_bytes = 0usize;
        let mut stdout = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    output_bytes = output_bytes.saturating_add(bytes.len());
                    if output_bytes > MAX_ENGINE_BYTES {
                        return Err(failure(
                            "ENGINE_RESPONSE_TOO_LARGE",
                            "Native engine output exceeds 256 KiB.",
                            id,
                        ));
                    }
                    // Raw chunks avoid an unbounded line allocation inside the shell plugin.
                    stdout.extend_from_slice(&bytes);
                    if let Some(end) = stdout.iter().position(|byte| *byte == b'\n') {
                        return validate_engine_response(&stdout[..end], &request);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    output_bytes = output_bytes.saturating_add(bytes.len());
                    if output_bytes > MAX_ENGINE_BYTES {
                        return Err(failure(
                            "ENGINE_RESPONSE_TOO_LARGE",
                            "Native engine output exceeds 256 KiB.",
                            id,
                        ));
                    }
                }
                CommandEvent::Error(error) => {
                    return Err(failure("ENGINE_PROCESS_ERROR", error, id))
                }
                CommandEvent::Terminated(status) => {
                    return Err(failure(
                        "ENGINE_EXITED",
                        format!(
                            "Native engine exited without a response (code {:?}).",
                            status.code
                        ),
                        id,
                    ))
                }
                _ => {}
            }
        }
        Err(failure(
            "ENGINE_NO_RESPONSE",
            "Native engine closed without a response.",
            id,
        ))
    })
    .await;
    // Ensure a broken helper cannot remain running after a response or timeout.
    let _ = child.kill();
    response.unwrap_or_else(|_| {
        Err(failure(
            "ENGINE_TIMEOUT",
            format!(
                "Native engine did not respond within {} seconds.",
                deadline.as_secs()
            ),
            id,
        ))
    })
}

fn validate_request_id(id: &str) -> Result<(), NativeError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    {
        return Err(failure(
            "ENGINE_REQUEST_ID_INVALID",
            "Request ID must be 1–128 ASCII letters, digits, or -_.:.",
            None,
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderRequest {
    protocol_version: u32,
    request_id: String,
    tone: Value,
    data: Vec<u8>,
}

fn validate_render_request(value: Value) -> Result<RenderRequest, NativeError> {
    let id = value
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let request: RenderRequest = serde_json::from_value(value)
        .map_err(|_| failure("RENDER_REQUEST_INVALID", "Audio rendering requires version, request ID, tone, and WAV bytes without additional fields.", id.as_deref()))?;
    validate_render_bounds(&request)?;
    Ok(request)
}

fn validate_render_bounds(request: &RenderRequest) -> Result<(), NativeError> {
    let id = Some(request.request_id.as_str());
    validate_request_id(&request.request_id)?;
    if request.protocol_version != 1 {
        return Err(failure(
            "ENGINE_PROTOCOL_UNSUPPORTED",
            "Native engine protocol must be version 1.",
            id,
        ));
    }
    if !request.tone.is_object() {
        return Err(failure(
            "RENDER_TONE_INVALID",
            "Audio rendering requires a ToneSpec object.",
            id,
        ));
    }
    if serde_json::to_vec(&request.tone).map_or(true, |bytes| bytes.len() > MAX_ENGINE_BYTES) {
        return Err(failure(
            "RENDER_TONE_TOO_LARGE",
            "Render tone exceeds 256 KiB.",
            id,
        ));
    }
    if request.data.is_empty() || request.data.len() > MAX_EXPORT_BYTES {
        return Err(failure(
            "RENDER_INPUT_TOO_LARGE",
            "Render input must contain WAV bytes and be at most 32 MiB.",
            id,
        ));
    }
    Ok(())
}

fn stage_render(data: &[u8]) -> std::io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("toney-render-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder.tempdir()?;
    std::fs::write(directory.path().join("input.wav"), data)?;
    Ok(directory)
}

fn read_render_output(directory: &Path, id: &str) -> Result<Vec<u8>, NativeError> {
    let path = directory.join("output.wav");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| failure("RENDER_OUTPUT_MISSING", error.to_string(), Some(id)))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(failure(
            "RENDER_OUTPUT_INVALID",
            "Native render output must be a regular WAV file.",
            Some(id),
        ));
    }
    if metadata.len() > MAX_EXPORT_BYTES as u64 {
        return Err(failure(
            "RENDER_OUTPUT_TOO_LARGE",
            "Rendered output exceeds 32 MiB.",
            Some(id),
        ));
    }
    let file = std::fs::File::open(path)
        .map_err(|error| failure("RENDER_OUTPUT_MISSING", error.to_string(), Some(id)))?;
    let mut data = Vec::new();
    file.take(MAX_EXPORT_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|error| failure("RENDER_OUTPUT_READ_FAILED", error.to_string(), Some(id)))?;
    if data.len() > MAX_EXPORT_BYTES {
        return Err(failure(
            "RENDER_OUTPUT_TOO_LARGE",
            "Rendered output exceeds 32 MiB.",
            Some(id),
        ));
    }
    if data.len() < 44 || &data[..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(failure(
            "RENDER_OUTPUT_INVALID",
            "Native engine did not produce a RIFF/WAVE file.",
            Some(id),
        ));
    }
    Ok(data)
}

#[derive(Serialize)]
struct RenderOutput {
    response: Value,
    data: Vec<u8>,
}

#[tauri::command]
async fn native_render_audio(
    app: tauri::AppHandle,
    request: Value,
) -> Result<RenderOutput, NativeError> {
    let request = validate_render_request(request)?;
    let request_id = request.request_id;
    let id = Some(request_id.as_str());
    let library = assets::library_path(&app)?;
    let staged_tone = request.tone.clone();
    let staging_id = request_id.clone();
    let (directory, resolved_assets) = tauri::async_runtime::spawn_blocking(move || {
        let directory = stage_render(&request.data).map_err(|error| {
            failure(
                "RENDER_STAGING_FAILED",
                error.to_string(),
                Some(&staging_id),
            )
        })?;
        let resolved =
            assets::stage_tone_assets(&library, &staged_tone, directory.path(), &staging_id)?;
        Ok::<_, NativeError>((directory, resolved))
    })
    .await
    .map_err(|error| failure("RENDER_STAGING_FAILED", error.to_string(), id))??;
    let engine_request = EngineRequest {
        protocol_version: 1,
        request_id: request_id.clone(),
        command: EngineCommand::RenderAudio,
        tone: Some(request.tone),
        render: Some(RenderPaths {
            input_path: directory
                .path()
                .join("input.wav")
                .to_string_lossy()
                .into_owned(),
            output_path: directory
                .path()
                .join("output.wav")
                .to_string_lossy()
                .into_owned(),
            assets: resolved_assets,
        }),
        asset: None,
    };
    let response = run_engine_request(app, engine_request, Duration::from_secs(60)).await?;
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        return Ok(RenderOutput {
            response,
            data: Vec::new(),
        });
    }
    let output_id = request_id.clone();
    let data = tauri::async_runtime::spawn_blocking(move || {
        read_render_output(directory.path(), &output_id)
    })
    .await
    .map_err(|error| {
        failure(
            "RENDER_OUTPUT_READ_FAILED",
            error.to_string(),
            Some(&request_id),
        )
    })??;
    Ok(RenderOutput { response, data })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportRequest {
    name: String,
    data: Vec<u8>,
}

fn validate_export(request: &ExportRequest) -> Result<&'static str, NativeError> {
    let extension = match request.name.as_str() {
        "toney-preset.json" | "toney-diagnostics.json" => "json",
        "toney-preview.wav" => "wav",
        _ => {
            return Err(failure(
                "EXPORT_NAME_INVALID",
                "Unsupported Toney export name.",
                None,
            ))
        }
    };
    if request.data.len() > MAX_EXPORT_BYTES {
        return Err(failure(
            "EXPORT_TOO_LARGE",
            "Toney exports must be at most 32 MiB.",
            None,
        ));
    }
    Ok(extension)
}

fn atomic_save(path: &Path, data: &[u8]) -> std::io::Result<()> {
    atomic_save_with(path, |file| file.write_all(data))
}

fn atomic_save_with(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    // Keep the temporary file on the destination filesystem. A failed write or
    // rename drops it, while the original destination remains untouched.
    let mut temporary = tempfile::Builder::new()
        .prefix(".toney-export-")
        .tempfile_in(parent)?;
    write(temporary.as_file_mut())?;
    temporary.as_file_mut().flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[tauri::command]
async fn native_export_file(app: tauri::AppHandle, request: Value) -> Result<Value, NativeError> {
    let request: ExportRequest = serde_json::from_value(request).map_err(|_| {
        failure(
            "EXPORT_INVALID",
            "An export requires a supported name and byte array.",
            None,
        )
    })?;
    let extension = validate_export(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = app
            .dialog()
            .file()
            .set_title("Export from Toney")
            .set_file_name(&request.name)
            .add_filter("Toney export", &[extension])
            .blocking_save_file();
        let Some(chosen) = chosen else {
            return Ok(json!({ "saved": false }));
        };
        let path = chosen.into_path().map_err(|_| {
            failure(
                "EXPORT_PATH_INVALID",
                "The selected destination is not a local file.",
                None,
            )
        })?;
        atomic_save(&path, &request.data)
            .map_err(|error| failure("EXPORT_WRITE_FAILED", error.to_string(), None))?;
        Ok(json!({ "saved": true, "path": path.to_string_lossy() }))
    })
    .await
    .map_err(|error| failure("EXPORT_TASK_FAILED", error.to_string(), None))?
}

fn validate_ollama_payload(payload: &Value) -> Result<(), NativeError> {
    let invalid = || {
        failure("OLLAMA_REQUEST_INVALID", "Local inference requires a bounded model, text messages, JSON format, stream:false, and temperature option.", None)
    };
    let Some(object) = payload.as_object() else {
        return Err(invalid());
    };
    if object
        .keys()
        .any(|key| !["model", "messages", "format", "stream", "options"].contains(&key.as_str()))
        || serde_json::to_vec(payload).map_or(true, |bytes| bytes.len() > MAX_ENGINE_BYTES)
        || payload.get("stream").and_then(Value::as_bool) != Some(false)
    {
        return Err(invalid());
    }
    let Some(model) = payload.get("model").and_then(Value::as_str) else {
        return Err(invalid());
    };
    if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err(invalid());
    }
    let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
        return Err(invalid());
    };
    if messages.is_empty() || messages.len() > 16 {
        return Err(invalid());
    }
    for message in messages {
        let Some(fields) = message.as_object() else {
            return Err(invalid());
        };
        if fields.len() != 2
            || !matches!(
                message.get("role").and_then(Value::as_str),
                Some("system" | "user" | "assistant")
            )
            || !message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|text| text.len() <= 65536)
        {
            return Err(invalid());
        }
    }
    let Some(format) = payload.get("format") else {
        return Err(invalid());
    };
    if !(format.is_object() || format.as_str() == Some("json"))
        || serde_json::to_vec(format).map_or(true, |bytes| bytes.len() > 65536)
    {
        return Err(invalid());
    }
    let Some(options) = payload.get("options").and_then(Value::as_object) else {
        return Err(invalid());
    };
    if options.len() != 1
        || !options
            .get("temperature")
            .and_then(Value::as_f64)
            .is_some_and(|n| (0.0..=2.0).contains(&n))
    {
        return Err(invalid());
    }
    Ok(())
}

#[tauri::command]
async fn native_ollama_chat(payload: Value) -> Result<Value, NativeError> {
    validate_ollama_payload(&payload)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| failure("OLLAMA_CLIENT_FAILED", error.to_string(), None))?;
    let mut response = client.post("http://127.0.0.1:11434/api/chat").json(&payload).send().await
        .map_err(|error| failure(if error.is_timeout() { "OLLAMA_TIMEOUT" } else { "OLLAMA_UNAVAILABLE" }, "Cannot complete local Ollama inference. Ensure Ollama is running and the model is installed.", None))?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| failure("OLLAMA_RESPONSE_FAILED", error.to_string(), None))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_OLLAMA_RESPONSE_BYTES {
            return Err(failure(
                "OLLAMA_RESPONSE_TOO_LARGE",
                "Local Ollama response exceeds 2 MiB.",
                None,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| {
        failure(
            "OLLAMA_RESPONSE_INVALID",
            "Local Ollama returned malformed JSON.",
            None,
        )
    })?;
    Ok(json!({ "status": status, "body": body }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(tone3000::Tone3000State::default())
        .manage(chatgpt::ChatGptState::default())
        .invoke_handler(tauri::generate_handler![
            native_engine_request,
            native_export_file,
            native_render_audio,
            assets::native_import_asset,
            assets::native_list_assets,
            tone3000::native_tone3000_select,
            tone3000::native_tone3000_status,
            tone3000::native_tone3000_cancel,
            tone3000::native_tone3000_download,
            chatgpt::native_chatgpt_sign_in,
            chatgpt::native_chatgpt_status,
            chatgpt::native_chatgpt_disconnect,
            chatgpt::native_chatgpt_models,
            chatgpt::native_chatgpt_interpret,
            native_ollama_chat
        ])
        .build(tauri::generate_context!())
        .expect("Toney desktop failed to start")
        .run(|app, event| {
            // Handle OAuth links in Rust. The deep-link plugin's default event emitter
            // broadcasts callback codes to webviews, so we use the native OS event.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    tauri::async_runtime::spawn(tone3000::handle_callback(app.clone(), url));
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_request() -> Value {
        json!({"protocolVersion":1,"requestId":"trace-123","command":"get_engine_info"})
    }

    #[test]
    fn engine_requests_enforce_version_command_correlation_and_tone_presence() {
        assert!(validate_engine_request(engine_request()).is_ok());
        for value in [
            json!({"protocolVersion":2,"requestId":"trace-123","command":"get_engine_info"}),
            json!({"protocolVersion":1,"requestId":"trace-123","command":"start_audio"}),
            json!({"protocolVersion":1,"requestId":"../file","command":"get_engine_info"}),
            json!({"protocolVersion":1,"requestId":"trace-123","command":"validate_tone_spec"}),
            json!({"protocolVersion":1,"requestId":"trace-123","command":"get_engine_info","tone":{}}),
        ] {
            assert!(validate_engine_request(value).is_err());
        }
    }

    #[test]
    fn engine_responses_require_matching_id_version_kind_and_envelope() {
        let request = validate_engine_request(engine_request()).unwrap();
        let valid = json!({"protocolVersion":1,"requestId":"trace-123","ok":true,"result":{"kind":"engine-info"}});
        assert!(validate_engine_response(&serde_json::to_vec(&valid).unwrap(), &request).is_ok());
        for (key, value) in [
            ("requestId", json!("wrong")),
            ("protocolVersion", json!(2)),
            ("ok", json!("true")),
            ("result", json!({"kind":"audio-devices"})),
        ] {
            let mut malformed = valid.clone();
            malformed[key] = value;
            assert!(
                validate_engine_response(&serde_json::to_vec(&malformed).unwrap(), &request)
                    .is_err()
            );
        }
        assert!(validate_engine_response(b"not json", &request).is_err());
    }

    #[test]
    fn exports_allow_only_supported_names_and_bounded_bytes() {
        for name in [
            "toney-preset.json",
            "toney-preview.wav",
            "toney-diagnostics.json",
        ] {
            assert!(validate_export(&ExportRequest {
                name: name.into(),
                data: vec![0]
            })
            .is_ok());
        }
        assert!(validate_export(&ExportRequest {
            name: "../other.json".into(),
            data: vec![]
        })
        .is_err());
        assert!(validate_export(&ExportRequest {
            name: "toney-preview.wav".into(),
            data: vec![0; MAX_EXPORT_BYTES + 1]
        })
        .is_err());
    }

    #[test]
    fn atomic_export_replaces_an_existing_file_after_complete_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("toney-preset.json");
        std::fs::write(&path, b"original preset").unwrap();
        atomic_save_with(&path, |file| {
            file.write_all(b"new preset")?;
            assert_eq!(std::fs::read(&path).unwrap(), b"original preset");
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new preset");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_export_preserves_original_after_partial_write_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("toney-preset.json");
        std::fs::write(&path, b"original preset").unwrap();
        let result = atomic_save_with(&path, |file| {
            file.write_all(b"partial replacement")?;
            Err(std::io::Error::other("injected disk write failure"))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original preset");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_export_rejects_directory_destination_and_cleans_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("folder");
        std::fs::create_dir(&destination).unwrap();
        let existing = destination.join("existing-preset.json");
        std::fs::write(&existing, b"original preset").unwrap();
        assert!(atomic_save(&destination, b"replacement").is_err());
        assert_eq!(std::fs::read(&existing).unwrap(), b"original preset");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        assert!(atomic_save(&destination.join("missing/preview.wav"), b"preview").is_err());
    }

    fn render_request() -> Value {
        json!({"protocolVersion":1,"requestId":"render-123","tone":{"schemaVersion":1},"data":[82,73,70,70]})
    }

    pub(super) fn test_wav() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&36u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&48000u32.to_le_bytes());
        bytes.extend_from_slice(&96000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes
    }

    #[test]
    fn render_requests_reject_versions_ids_paths_and_extra_fields() {
        assert!(validate_render_request(render_request()).is_ok());
        for (key, value) in [
            ("protocolVersion", json!(2)),
            ("requestId", json!("../audio")),
            ("tone", json!(null)),
            ("inputPath", json!("/private/file.wav")),
            ("outputPath", json!("/private/file.wav")),
            (
                "render",
                json!({"inputPath":"/private/file.wav","outputPath":"/private/output.wav"}),
            ),
        ] {
            let mut malformed = render_request();
            malformed[key] = value;
            assert!(validate_render_request(malformed).is_err());
        }
        let mut missing = render_request();
        missing.as_object_mut().unwrap().remove("data");
        assert!(validate_render_request(missing).is_err());
    }

    #[test]
    fn render_bounds_reject_oversized_audio_tone_and_empty_audio() {
        let mut request = validate_render_request(render_request()).unwrap();
        request.data = vec![0; MAX_EXPORT_BYTES + 1];
        assert_eq!(
            validate_render_bounds(&request).unwrap_err().code,
            "RENDER_INPUT_TOO_LARGE"
        );
        request.data.clear();
        assert!(validate_render_bounds(&request).is_err());
        request.data = test_wav();
        request.tone = json!({"name":"x".repeat(MAX_ENGINE_BYTES)});
        assert_eq!(
            validate_render_bounds(&request).unwrap_err().code,
            "RENDER_TONE_TOO_LARGE"
        );
    }

    #[test]
    fn general_engine_command_cannot_inject_render_paths_or_start_rendering() {
        for value in [
            json!({"protocolVersion":1,"requestId":"render-123","command":"render_audio","tone":{}}),
            json!({"protocolVersion":1,"requestId":"render-123","command":"get_engine_info","render":{"inputPath":"/private/file.wav","outputPath":"/private/output.wav"}}),
            json!({"protocolVersion":1,"requestId":"render-123","command":"get_engine_info","render":null}),
            json!({"protocolVersion":1,"requestId":"asset-123","command":"inspect_asset","asset":{"id":"0".repeat(64),"kind":"ir","path":"/private/file.wav"}}),
            json!({"protocolVersion":1,"requestId":"asset-123","command":"get_engine_info","asset":null}),
            json!({"protocolVersion":1,"requestId":"asset-123","command":"get_engine_info","path":"/private/file.wav"}),
        ] {
            assert_eq!(
                validate_engine_request(value).unwrap_err().code,
                "ENGINE_REQUEST_FORBIDDEN"
            );
        }
    }

    #[test]
    fn render_staging_is_private_and_cleans_up_on_success_or_read_failure() {
        let input = test_wav();
        let directory = stage_render(&input).unwrap();
        let path = directory.path().to_owned();
        assert!(path.is_absolute());
        assert_eq!(std::fs::read(path.join("input.wav")).unwrap(), input);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::write(path.join("output.wav"), &input).unwrap();
        assert_eq!(read_render_output(&path, "render-123").unwrap(), input);
        drop(directory);
        assert!(!path.exists());
        let failed = stage_render(&input).unwrap();
        let failed_path = failed.path().to_owned();
        assert_eq!(
            read_render_output(&failed_path, "render-123")
                .unwrap_err()
                .code,
            "RENDER_OUTPUT_MISSING"
        );
        drop(failed);
        assert!(!failed_path.exists());
    }

    #[test]
    fn rendered_output_requires_known_regular_bounded_riff_wave_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("output.wav");
        for data in [vec![0; 10], vec![0; 44]] {
            std::fs::write(&path, data).unwrap();
            assert_eq!(
                read_render_output(directory.path(), "render-123")
                    .unwrap_err()
                    .code,
                "RENDER_OUTPUT_INVALID"
            );
        }
        let mut incorrect_wave = test_wav();
        incorrect_wave[8] = b'X';
        std::fs::write(&path, incorrect_wave).unwrap();
        assert!(read_render_output(directory.path(), "render-123").is_err());
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_EXPORT_BYTES as u64 + 1)
            .unwrap();
        assert_eq!(
            read_render_output(directory.path(), "render-123")
                .unwrap_err()
                .code,
            "RENDER_OUTPUT_TOO_LARGE"
        );
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(directory.path().join("input.wav"), &path).unwrap();
            assert_eq!(
                read_render_output(directory.path(), "render-123")
                    .unwrap_err()
                    .code,
                "RENDER_OUTPUT_INVALID"
            );
        }
    }

    #[test]
    fn local_inference_rejects_endpoints_streaming_and_audio_attachments() {
        let payload = json!({"model":"qwen2.5:3b","stream":false,"format":{},"options":{"temperature":0},"messages":[{"role":"user","content":"warm tone"}]});
        assert!(validate_ollama_payload(&payload).is_ok());
        for (key, value) in [
            ("url", json!("https://example.com")),
            ("stream", json!(true)),
            ("model", json!("")),
            (
                "messages",
                json!([{"role":"user","content":"warm tone","images":["data"]}]),
            ),
        ] {
            let mut malformed = payload.clone();
            malformed[key] = value;
            assert!(validate_ollama_payload(&malformed).is_err());
        }
    }
}
