use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use std::{io::Write, path::Path};
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
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum EngineCommand {
    GetEngineInfo,
    GetAudioDevices,
    ValidateToneSpec,
}

fn validate_engine_request(value: Value) -> Result<EngineRequest, NativeError> {
    let id = value.get("requestId").and_then(Value::as_str);
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
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    {
        return Err(failure(
            "ENGINE_REQUEST_ID_INVALID",
            "Request ID must be 1–128 ASCII letters, digits, or -_.:.",
            None,
        ));
    }
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
    let request = validate_engine_request(request)?;
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
    let response = tokio::time::timeout(Duration::from_secs(10), async {
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
            "Native engine did not respond within 10 seconds.",
            id,
        ))
    })
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
        .invoke_handler(tauri::generate_handler![
            native_engine_request,
            native_export_file,
            native_ollama_chat
        ])
        .run(tauri::generate_context!())
        .expect("Toney desktop failed to start");
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
