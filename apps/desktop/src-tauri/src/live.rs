//! The live helper is a session, never a frontend-controlled process or path.
use crate::{assets, failure, validate_request_id, NativeError, MAX_ENGINE_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::Mutex as AsyncMutex,
};

const MAX_LIVE_BYTES: usize = 1024 * 1024;
const LIVE_DEADLINE: Duration = Duration::from_secs(30);
type ChildSlot = Arc<Mutex<Option<Child>>>;

#[derive(Default)]
pub(super) struct LiveState {
    session: AsyncMutex<Option<Session>>,
    child: ChildSlot,
    exiting: AtomicBool,
    generation: AtomicU64,
}

fn kill_child(slot: &ChildSlot) {
    if let Ok(mut child) = slot.lock() {
        if let Some(mut child) = child.take() {
            let _ = child.start_kill();
            // kill_on_drop provides a second safeguard; Tokio reaps the process.
        }
    }
}

impl LiveState {
    pub(super) fn shutdown(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        kill_child(&self.child);
    }
}

impl Drop for LiveState {
    fn drop(&mut self) {
        kill_child(&self.child);
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartConfig {
    input_device_id: String,
    output_device_id: String,
    input_channel: u32,
    sample_rate: u32,
    buffer_size: u32,
    input_gain_db: f64,
    output_gain_db: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateConfig {
    input_gain_db: f64,
    output_gain_db: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToneRequest<C> {
    protocol_version: u32,
    request_id: String,
    tone: Value,
    live: C,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusRequest {
    protocol_version: u32,
    request_id: String,
}

fn check_base(version: u32, id: &str) -> Result<(), NativeError> {
    validate_request_id(id)?;
    if version != 1 {
        return Err(failure(
            "ENGINE_PROTOCOL_UNSUPPORTED",
            "Native engine protocol must be version 1.",
            Some(id),
        ));
    }
    Ok(())
}

fn check_gains(input: f64, output: f64, id: &str) -> Result<(), NativeError> {
    if !input.is_finite()
        || !output.is_finite()
        || !(-24.0..=24.0).contains(&input)
        || !(-60.0..=0.0).contains(&output)
    {
        return Err(failure(
            "LIVE_CONFIG_INVALID",
            "Input trim must be −24 to +24 dB and output level −60 to 0 dB.",
            Some(id),
        ));
    }
    Ok(())
}

fn parse_tone<C: serde::de::DeserializeOwned>(value: Value) -> Result<ToneRequest<C>, NativeError> {
    let id = value.get("requestId").and_then(Value::as_str);
    if serde_json::to_vec(&value).map_or(true, |v| v.len() > MAX_ENGINE_BYTES) {
        return Err(failure(
            "LIVE_REQUEST_TOO_LARGE",
            "Live request exceeds 256 KiB.",
            id,
        ));
    }
    let request: ToneRequest<C> = serde_json::from_value(value.clone()).map_err(|_| failure("LIVE_REQUEST_INVALID", "Live audio requires version, request ID, tone, and device or gain settings without paths or additional fields.", id))?;
    check_base(request.protocol_version, &request.request_id)?;
    if !request.tone.is_object() {
        return Err(failure(
            "LIVE_TONE_INVALID",
            "Live audio requires a ToneSpec object.",
            Some(&request.request_id),
        ));
    }
    Ok(request)
}

fn parse_status(value: Value) -> Result<StatusRequest, NativeError> {
    let id = value.get("requestId").and_then(Value::as_str);
    let request: StatusRequest = serde_json::from_value(value.clone()).map_err(|_| {
        failure(
            "LIVE_REQUEST_INVALID",
            "Live status/stop accepts only protocol version and request ID.",
            id,
        )
    })?;
    check_base(request.protocol_version, &request.request_id)?;
    Ok(request)
}

fn check_start(config: &StartConfig, id: &str) -> Result<(), NativeError> {
    check_gains(config.input_gain_db, config.output_gain_db, id)?;
    if config.input_device_id.is_empty()
        || config.output_device_id.is_empty()
        || config.input_device_id.len() > 1024
        || config.output_device_id.len() > 1024
        || config.input_device_id.chars().any(char::is_control)
        || config.output_device_id.chars().any(char::is_control)
        || config.input_channel > 31
        || ![44100, 48000, 96000].contains(&config.sample_rate)
        || ![64, 128, 256, 512].contains(&config.buffer_size)
    {
        return Err(failure("LIVE_CONFIG_INVALID", "Choose explicit input/output devices, channel 1–32, a supported sample rate, and a 64–512 sample buffer.", Some(id)));
    }
    Ok(())
}

fn stopped(id: &str) -> Value {
    json!({"protocolVersion":1,"requestId":id,"ok":true,"result":{
        "kind":"live-status","state":"stopped","toneId":"","revision":0,
        "sampleRate":0,"bufferSize":0,"inputDeviceId":"","outputDeviceId":"","inputChannel":0,
        "inputChannels":0,"outputChannels":0,"inputPeak":0,"outputPeak":0,"callbackCount":0,
        "overruns":0,"cpuLoad":0,"latencyMs":0,"errorCode":"","errorMessage":""
    }})
}

fn validate_response(bytes: &[u8], id: &str) -> Result<Value, NativeError> {
    if bytes.len() > MAX_LIVE_BYTES {
        return Err(failure(
            "LIVE_RESPONSE_TOO_LARGE",
            "Live helper response exceeds 1 MiB.",
            Some(id),
        ));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        failure(
            "LIVE_RESPONSE_INVALID",
            "Live helper returned malformed JSON.",
            Some(id),
        )
    })?;
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || value.get("requestId").and_then(Value::as_str) != Some(id)
    {
        return Err(failure(
            "LIVE_RESPONSE_MISMATCH",
            "Live helper response version or request ID did not match.",
            Some(id),
        ));
    }
    match value.get("ok").and_then(Value::as_bool) {
        Some(false)
            if value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .is_some()
                && value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .is_some() => {}
        Some(true)
            if value.pointer("/result/kind").and_then(Value::as_str) == Some("live-status")
                && matches!(
                    value.pointer("/result/state").and_then(Value::as_str),
                    Some("stopped" | "running" | "error")
                ) =>
        {
            let result = &value["result"];
            for field in [
                "toneId",
                "inputDeviceId",
                "outputDeviceId",
                "errorCode",
                "errorMessage",
            ] {
                if !result[field].is_string() {
                    return Err(failure(
                        "LIVE_RESPONSE_INVALID",
                        "Live helper returned invalid status fields.",
                        Some(id),
                    ));
                }
            }
            for field in [
                "revision",
                "bufferSize",
                "inputChannel",
                "inputChannels",
                "outputChannels",
                "callbackCount",
                "overruns",
            ] {
                if result[field].as_u64().is_none() {
                    return Err(failure(
                        "LIVE_RESPONSE_INVALID",
                        "Live helper returned invalid status counters.",
                        Some(id),
                    ));
                }
            }
            for field in [
                "sampleRate",
                "inputPeak",
                "outputPeak",
                "cpuLoad",
                "latencyMs",
            ] {
                if !result[field]
                    .as_f64()
                    .is_some_and(|number| number.is_finite() && number >= 0.0)
                {
                    return Err(failure(
                        "LIVE_RESPONSE_INVALID",
                        "Live helper returned invalid status measurements.",
                        Some(id),
                    ));
                }
            }
        }
        _ => {
            return Err(failure(
                "LIVE_RESPONSE_INVALID",
                "Live helper returned an invalid status envelope.",
                Some(id),
            ))
        }
    }
    Ok(value)
}

// Mirror the shell plugin's executable-relative sidecar resolution, including tests.
fn helper_path() -> Result<PathBuf, NativeError> {
    let executable = std::env::current_exe()
        .map_err(|error| failure("ENGINE_UNAVAILABLE", error.to_string(), None))?;
    let mut directory = executable.parent().ok_or_else(|| {
        failure(
            "ENGINE_UNAVAILABLE",
            "Cannot resolve the native helper directory.",
            None,
        )
    })?;
    if directory.ends_with("deps") {
        directory = directory.parent().unwrap_or(directory);
    }
    Ok(directory.join(if cfg!(windows) {
        "toney-engine.exe"
    } else {
        "toney-engine"
    }))
}

struct Session {
    child: ChildSlot,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<()>,
    staging: Option<tempfile::TempDir>,
}

impl Drop for Session {
    fn drop(&mut self) {
        kill_child(&self.child);
        self.stderr.abort();
        // Staged assets are dropped only after the process has been signalled.
    }
}

impl Session {
    fn spawn(path: &Path, slot: ChildSlot) -> Result<Self, NativeError> {
        let mut child = tokio::process::Command::new(path)
            .arg("--live")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| failure("LIVE_START_FAILED", error.to_string(), None))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| failure("LIVE_START_FAILED", "Live helper has no input pipe.", None))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failure("LIVE_START_FAILED", "Live helper has no output pipe.", None))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| failure("LIVE_START_FAILED", "Live helper has no error pipe.", None))?;
        *slot
            .lock()
            .map_err(|_| failure("LIVE_START_FAILED", "Live helper state lock failed.", None))? =
            Some(child);
        let errors_slot = slot.clone();
        let process_id = slot
            .lock()
            .ok()
            .and_then(|child| child.as_ref().and_then(Child::id));
        let errors = tokio::spawn(async move {
            let mut count = 0usize;
            let mut buffer = [0u8; 4096];
            while let Ok(size) = stderr.read(&mut buffer).await {
                if size == 0 {
                    break;
                }
                count = count.saturating_add(size);
                if count > MAX_LIVE_BYTES {
                    if let Ok(mut child) = errors_slot.lock() {
                        if child.as_ref().and_then(Child::id) == process_id {
                            if let Some(mut child) = child.take() {
                                let _ = child.start_kill();
                            }
                        }
                    }
                    break;
                }
            }
        });
        Ok(Self {
            child: slot,
            stdin,
            stdout: BufReader::new(stdout),
            stderr: errors,
            staging: None,
        })
    }

    async fn exchange(
        &mut self,
        request: &Value,
        deadline: Duration,
    ) -> Result<Value, NativeError> {
        let id = request["requestId"].as_str().unwrap_or("");
        let mut bytes = serde_json::to_vec(request)
            .map_err(|error| failure("LIVE_REQUEST_INVALID", error.to_string(), Some(id)))?;
        if bytes.len() > MAX_LIVE_BYTES {
            return Err(failure(
                "LIVE_REQUEST_TOO_LARGE",
                "Live helper request exceeds 1 MiB.",
                Some(id),
            ));
        }
        bytes.push(b'\n');
        let result = tokio::time::timeout(deadline, async {
            self.stdin
                .write_all(&bytes)
                .await
                .map_err(|error| failure("LIVE_WRITE_FAILED", error.to_string(), Some(id)))?;
            self.stdin
                .flush()
                .await
                .map_err(|error| failure("LIVE_WRITE_FAILED", error.to_string(), Some(id)))?;
            let mut output = Vec::with_capacity(4096);
            // Reading one bounded byte at a time avoids an unbounded line allocation or
            // accepting unsolicited replies that can desynchronise the next request.
            loop {
                let byte =
                    self.stdout.read_u8().await.map_err(|error| {
                        failure("LIVE_HELPER_EXITED", error.to_string(), Some(id))
                    })?;
                if byte == b'\n' {
                    return validate_response(&output, id);
                }
                if output.len() >= MAX_LIVE_BYTES {
                    return Err(failure(
                        "LIVE_RESPONSE_TOO_LARGE",
                        "Live helper response exceeds 1 MiB.",
                        Some(id),
                    ));
                }
                output.push(byte);
            }
        })
        .await
        .unwrap_or_else(|_| {
            Err(failure(
                "LIVE_TIMEOUT",
                "Live helper did not respond before the session deadline.",
                Some(id),
            ))
        });
        if result.is_err() {
            kill_child(&self.child);
        }
        result
    }
}

async fn stage<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tone: Value,
    id: String,
) -> Result<(tempfile::TempDir, Vec<assets::TrustedAssetPath>), NativeError> {
    let library = assets::library_path(app)?;
    let error_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = tempfile::Builder::new();
        builder.prefix("toney-live-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let directory = builder
            .tempdir()
            .map_err(|error| failure("LIVE_STAGING_FAILED", error.to_string(), Some(&id)))?;
        let assets = assets::stage_tone_assets(&library, &tone, directory.path(), &id)?;
        Ok((directory, assets))
    })
    .await
    .map_err(|error| failure("LIVE_STAGING_FAILED", error.to_string(), Some(&error_id)))?
}

#[tauri::command]
pub(super) async fn native_live_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, LiveState>,
    request: Value,
) -> Result<Value, NativeError> {
    let request: ToneRequest<StartConfig> = parse_tone(request)?;
    check_start(&request.live, &request.request_id)?;
    let generation = state.generation.load(Ordering::SeqCst);
    let mut session = state.session.lock().await;
    if state.exiting.load(Ordering::SeqCst) {
        return Err(failure(
            "LIVE_APP_EXITING",
            "Toney is closing.",
            Some(&request.request_id),
        ));
    }
    if session.is_some() {
        return Err(failure(
            "LIVE_ALREADY_RUNNING",
            "Stop the current live session before changing devices.",
            Some(&request.request_id),
        ));
    }
    let (directory, assets) = stage(&app, request.tone.clone(), request.request_id.clone()).await?;
    if state.exiting.load(Ordering::SeqCst) {
        return Err(failure(
            "LIVE_APP_EXITING",
            "Toney is closing.",
            Some(&request.request_id),
        ));
    }
    let mut config = serde_json::to_value(request.live).map_err(|error| {
        failure(
            "LIVE_REQUEST_INVALID",
            error.to_string(),
            Some(&request.request_id),
        )
    })?;
    config["assets"] = serde_json::to_value(assets).map_err(|error| {
        failure(
            "LIVE_REQUEST_INVALID",
            error.to_string(),
            Some(&request.request_id),
        )
    })?;
    if generation != state.generation.load(Ordering::SeqCst) {
        return Ok(stopped(&request.request_id));
    }
    let mut helper = Session::spawn(&helper_path()?, state.child.clone())?;
    // Close races with Stop or synchronous app shutdown occurring during spawn.
    if generation != state.generation.load(Ordering::SeqCst) {
        kill_child(&state.child);
        return Ok(stopped(&request.request_id));
    }
    if state.exiting.load(Ordering::SeqCst) {
        state.shutdown();
        return Err(failure(
            "LIVE_APP_EXITING",
            "Toney is closing.",
            Some(&request.request_id),
        ));
    }
    let response = helper.exchange(&json!({"protocolVersion":1,"requestId":request.request_id,"command":"start_live","tone":request.tone,"live":config}), LIVE_DEADLINE).await?;
    if generation != state.generation.load(Ordering::SeqCst) || state.exiting.load(Ordering::SeqCst)
    {
        return Ok(stopped(&request.request_id));
    }
    if response["ok"].as_bool() == Some(true)
        && response["result"]["state"].as_str() == Some("running")
    {
        helper.staging = Some(directory);
        *session = Some(helper);
    }
    Ok(response)
}

#[tauri::command]
pub(super) async fn native_live_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, LiveState>,
    request: Value,
) -> Result<Value, NativeError> {
    let request: ToneRequest<UpdateConfig> = parse_tone(request)?;
    check_gains(
        request.live.input_gain_db,
        request.live.output_gain_db,
        &request.request_id,
    )?;
    let mut session = state.session.lock().await;
    let helper = session.as_mut().ok_or_else(|| {
        failure(
            "LIVE_NOT_RUNNING",
            "Start live guitar input before applying a rig.",
            Some(&request.request_id),
        )
    })?;
    let (directory, assets) = stage(&app, request.tone.clone(), request.request_id.clone()).await?;
    let response = helper.exchange(&json!({"protocolVersion":1,"requestId":request.request_id,"command":"update_live","tone":request.tone,"live":{"inputGainDb":request.live.input_gain_db,"outputGainDb":request.live.output_gain_db,"assets":assets}}), LIVE_DEADLINE).await;
    match response {
        Ok(response) => {
            if response["result"]["state"].as_str() == Some("error") {
                *session = None;
            } else if response["ok"].as_bool() == Some(true) {
                helper.staging = Some(directory);
            }
            Ok(response)
        }
        Err(error) => {
            *session = None;
            Err(error)
        }
    }
}

#[tauri::command]
pub(super) async fn native_live_status(
    state: tauri::State<'_, LiveState>,
    request: Value,
) -> Result<Value, NativeError> {
    let request = parse_status(request)?;
    let mut session = state.session.lock().await;
    let Some(helper) = session.as_mut() else {
        return Ok(stopped(&request.request_id));
    };
    match helper.exchange(&json!({"protocolVersion":1,"requestId":request.request_id,"command":"get_live_status"}), Duration::from_secs(5)).await {
        Ok(response) => {
            if response["result"]["state"].as_str() == Some("error") { *session = None; }
            Ok(response)
        },
        Err(error) => { *session = None; Err(error) }
    }
}

#[tauri::command]
pub(super) async fn native_live_stop(
    state: tauri::State<'_, LiveState>,
    request: Value,
) -> Result<Value, NativeError> {
    let request = parse_status(request)?;
    // Stop does not queue behind model loading, a stalled reply, or an update.
    state.generation.fetch_add(1, Ordering::SeqCst);
    kill_child(&state.child);
    *state.session.lock().await = None;
    Ok(stopped(&request.request_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Value {
        json!({"protocolVersion":1,"requestId":"live-123","tone":{},"live":{
            "inputDeviceId":"CoreAudio:input:0:Interface","outputDeviceId":"CoreAudio:output:0:Interface",
            "inputChannel":0,"sampleRate":48000,"bufferSize":128,"inputGainDb":0,"outputGainDb":-12
        }})
    }

    #[test]
    fn live_boundary_rejects_paths_extra_fields_unsafe_gains_and_device_settings() {
        let valid: ToneRequest<StartConfig> = parse_tone(request()).unwrap();
        check_start(&valid.live, &valid.request_id).unwrap();
        for (field, value) in [
            ("assets", json!([])),
            ("path", json!("/tmp/private")),
            ("sampleRate", json!(32000)),
            ("bufferSize", json!(4096)),
            ("inputChannel", json!(32)),
            ("outputGainDb", json!(12)),
            ("inputDeviceId", json!("")),
        ] {
            let mut value_request = request();
            value_request["live"][field] = value;
            let rejected = parse_tone::<StartConfig>(value_request)
                .and_then(|parsed| check_start(&parsed.live, &parsed.request_id));
            assert!(rejected.is_err(), "Accepted {field}");
        }
        let mut value = request();
        value["command"] = json!("render_audio");
        assert!(parse_tone::<StartConfig>(value).is_err());
        assert!(
            parse_status(json!({"protocolVersion":1,"requestId":"live-123","tone":{}})).is_err()
        );
        assert!(parse_status(json!({"protocolVersion":1,"requestId":"../x"})).is_err());
        assert!(parse_status(json!({"protocolVersion":2,"requestId":"live-123"})).is_err());
    }

    #[test]
    fn live_responses_require_correlation_measurements_and_error_envelopes() {
        let valid = stopped("live-123");
        assert!(validate_response(&serde_json::to_vec(&valid).unwrap(), "live-123").is_ok());
        assert_eq!(
            validate_response(&serde_json::to_vec(&valid).unwrap(), "another")
                .unwrap_err()
                .code,
            "LIVE_RESPONSE_MISMATCH"
        );
        for field in ["callbackCount", "latencyMs", "errorCode", "state"] {
            let mut broken = valid.clone();
            broken["result"][field] = Value::Null;
            assert!(validate_response(&serde_json::to_vec(&broken).unwrap(), "live-123").is_err());
        }
        let failure = json!({"protocolVersion":1,"requestId":"live-123","ok":false,"error":{"code":"LIVE_SAMPLE_RATE_UNSUPPORTED","message":"Choose 48 kHz"}});
        assert!(validate_response(&serde_json::to_vec(&failure).unwrap(), "live-123").is_ok());
        assert!(validate_response(&vec![b'x'; MAX_LIVE_BYTES + 1], "live-123").is_err());
    }

    #[cfg(unix)]
    fn mock_helper(script: &str) -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("helper");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (directory, path)
    }

    #[cfg(unix)]
    #[test]
    fn persistent_session_replies_repeatedly_and_drop_kills_and_cleans_staging() {
        let response = serde_json::to_string(&stopped("live-123")).unwrap();
        let (_mock, path) = mock_helper(&format!(
            "while IFS= read -r request; do printf '%s\\n' '{response}'; done"
        ));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let slot: ChildSlot = Arc::new(Mutex::new(None));
            let mut session = Session::spawn(&path, slot.clone()).unwrap();
            let staging = tempfile::tempdir().unwrap();
            let staging_path = staging.path().to_owned();
            session.staging = Some(staging);
            let request =
                json!({"protocolVersion":1,"requestId":"live-123","command":"get_live_status"});
            for _ in 0..2 {
                assert!(session
                    .exchange(&request, Duration::from_secs(1))
                    .await
                    .unwrap()["ok"]
                    .as_bool()
                    .unwrap());
            }
            drop(session);
            assert!(slot.lock().unwrap().is_none());
            assert!(!staging_path.exists());
        });
    }

    #[cfg(unix)]
    #[test]
    fn stalled_and_mismatched_helpers_are_killed_without_leaking_session() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for (script, expected) in [
            (
                "IFS= read -r request; IFS= read -r request".to_owned(),
                "LIVE_TIMEOUT",
            ),
            (
                format!(
                    "IFS= read -r request; printf '%s\\n' '{}'; IFS= read -r request",
                    serde_json::to_string(&stopped("wrong-id")).unwrap()
                ),
                "LIVE_RESPONSE_MISMATCH",
            ),
            (
                "IFS= read -r request; printf '%1048577s\\n' x".to_owned(),
                "LIVE_RESPONSE_TOO_LARGE",
            ),
        ] {
            let (_mock, path) = mock_helper(&script);
            runtime.block_on(async {
                let slot: ChildSlot = Arc::new(Mutex::new(None));
                let mut session = Session::spawn(&path, slot.clone()).unwrap();
                let request =
                    json!({"protocolVersion":1,"requestId":"live-123","command":"get_live_status"});
                let deadline = if expected == "LIVE_TIMEOUT" {
                    Duration::from_millis(30)
                } else {
                    Duration::from_secs(5)
                };
                assert_eq!(
                    session.exchange(&request, deadline).await.unwrap_err().code,
                    expected
                );
                assert!(slot.lock().unwrap().is_none());
            });
        }
    }
}
