use super::{
    failure, run_engine_request, validate_request_id, EngineCommand, EngineRequest, NativeError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;

const MAX_ENTRIES: usize = 128;
const MAX_DESCRIPTOR: usize = 16 * 1024;
static LIBRARY_ACCESS: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum AssetKind {
    Ir,
    Nam,
}
impl AssetKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Ir => "wav",
            Self::Nam => "nam",
        }
    }
    fn limit(self) -> usize {
        match self {
            Self::Ir => 8 * 1024 * 1024,
            Self::Nam => 32 * 1024 * 1024,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Ir => "ir",
            Self::Nam => "nam",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AssetRef {
    id: String,
    kind: AssetKind,
    name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StoredAsset {
    asset: AssetRef,
    info: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TrustedAssetPath {
    id: String,
    kind: AssetKind,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    protocol_version: u32,
    request_id: String,
    kind: AssetKind,
    name: String,
    data: Vec<u8>,
}

#[derive(Serialize)]
pub(super) struct ImportOutput {
    response: Value,
    asset: AssetRef,
    info: Value,
}
#[derive(Debug, Serialize)]
struct AssetDiagnostic {
    id: String,
    code: String,
    message: String,
}
#[derive(Debug, Serialize)]
pub(super) struct LibraryOutput {
    assets: Vec<StoredAsset>,
    diagnostics: Vec<AssetDiagnostic>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.encode_utf16().count() <= 200
        && name != "."
        && !name.contains("..")
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}
fn content_id(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn validate_ref(asset: &AssetRef) -> Result<(), NativeError> {
    if !valid_id(&asset.id) || !valid_name(&asset.name) {
        return Err(failure(
            "ASSET_REFERENCE_INVALID",
            "Asset references require a lowercase SHA-256 ID and a basename of 1–200 characters.",
            None,
        ));
    }
    Ok(())
}
fn validate_import(value: Value) -> Result<ImportRequest, NativeError> {
    let id = value
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let request: ImportRequest = serde_json::from_value(value).map_err(|_| failure("ASSET_IMPORT_INVALID", "Import requires version, request ID, kind, basename, and byte array without extra fields.", id.as_deref()))?;
    validate_import_bounds(&request)?;
    Ok(request)
}
fn validate_import_bounds(request: &ImportRequest) -> Result<(), NativeError> {
    validate_request_id(&request.request_id)?;
    let id = Some(request.request_id.as_str());
    if request.protocol_version != 1 {
        return Err(failure(
            "ENGINE_PROTOCOL_UNSUPPORTED",
            "Asset import protocol must be version 1.",
            id,
        ));
    }
    if !valid_name(&request.name) {
        return Err(failure(
            "ASSET_NAME_INVALID",
            "Choose a basename of 1–200 characters without path syntax or control characters.",
            id,
        ));
    }
    if request.data.is_empty() || request.data.len() > request.kind.limit() {
        return Err(failure(
            "ASSET_TOO_LARGE",
            "IR assets must be 1 byte–8 MiB; NAM assets must be 1 byte–32 MiB.",
            id,
        ));
    }
    Ok(())
}
fn validate_info(info: &Value, asset: &AssetRef) -> Result<(), NativeError> {
    let invalid = || {
        failure(
            "ASSET_INSPECTION_INVALID",
            format!(
                "Inspection metadata for asset {} is invalid or does not match its reference.",
                asset.id
            ),
            None,
        )
    };
    let Some(object) = info.as_object() else {
        return Err(invalid());
    };
    if object.keys().any(|key| {
        ![
            "kind",
            "id",
            "assetKind",
            "sampleRate",
            "channels",
            "frames",
            "architecture",
            "modelVersion",
        ]
        .contains(&key.as_str())
    }) || info.get("kind").and_then(Value::as_str) != Some("asset-info")
        || info.get("id").and_then(Value::as_str) != Some(asset.id.as_str())
        || info.get("assetKind").and_then(Value::as_str) != Some(asset.kind.label())
        || !info
            .get("sampleRate")
            .and_then(Value::as_f64)
            .is_some_and(|n| n.is_finite() && (8000.0..=96000.0).contains(&n))
    {
        return Err(invalid());
    }
    match asset.kind {
        AssetKind::Ir => {
            let Some(channels) = info.get("channels").and_then(Value::as_u64) else {
                return Err(invalid());
            };
            let Some(frames) = info.get("frames").and_then(Value::as_u64) else {
                return Err(invalid());
            };
            if !(1..=2).contains(&channels)
                || frames == 0
                || frames as f64 > info["sampleRate"].as_f64().unwrap() * 2.0
                || info.get("architecture").is_some()
                || info.get("modelVersion").is_some()
            {
                return Err(invalid());
            }
        }
        AssetKind::Nam => {
            if info.get("channels").and_then(Value::as_u64) != Some(1)
                || !matches!(
                    info.get("architecture").and_then(Value::as_str),
                    Some("WaveNet" | "LSTM")
                )
                || !info
                    .get("modelVersion")
                    .and_then(Value::as_str)
                    .is_some_and(|v| matches!(v, "0.5.0" | "0.5.1" | "0.5.2" | "0.5.3" | "0.5.4"))
                || info.get("frames").is_some()
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

pub(super) fn library_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, NativeError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("assets"))
        .map_err(|_| {
            failure(
                "ASSET_LIBRARY_UNAVAILABLE",
                "Cannot locate the Toney application data folder.",
                None,
            )
        })
}
fn regular_file_bytes(path: &Path, limit: usize, id: &str) -> Result<Vec<u8>, NativeError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        failure(
            "ASSET_MISSING",
            format!("Asset {id} is missing. Import the original file again."),
            None,
        )
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > limit as u64
    {
        return Err(failure(
            "ASSET_CORRUPT",
            format!("Asset {id} has an invalid file or exceeds its size limit."),
            None,
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| failure("ASSET_CORRUPT", format!("Cannot read asset {id}."), None))?;
    if bytes.len() > limit {
        return Err(failure(
            "ASSET_CORRUPT",
            format!("Asset {id} exceeds its size limit."),
            None,
        ));
    }
    Ok(bytes)
}
fn asset_directory(root: &Path, id: &str) -> Result<PathBuf, NativeError> {
    if !valid_id(id) {
        return Err(failure(
            "ASSET_REFERENCE_INVALID",
            "Invalid content-addressed asset ID.",
            None,
        ));
    }
    let root_metadata = std::fs::symlink_metadata(root).map_err(|_| {
        failure(
            "ASSET_MISSING",
            format!("Asset {id} is missing. Import the original file again."),
            None,
        )
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(failure(
            "ASSET_LIBRARY_UNAVAILABLE",
            "Toney asset library must be a local directory.",
            None,
        ));
    }
    let path = root.join(id);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
        failure(
            "ASSET_MISSING",
            format!("Asset {id} is missing. Import the original file again."),
            None,
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure(
            "ASSET_CORRUPT",
            format!("Asset {id} directory is invalid."),
            None,
        ));
    }
    Ok(path)
}
fn read_descriptor(root: &Path, id: &str) -> Result<StoredAsset, NativeError> {
    let path = asset_directory(root, id)?;
    let bytes = regular_file_bytes(&path.join("descriptor.json"), MAX_DESCRIPTOR, id)?;
    let stored: StoredAsset = serde_json::from_slice(&bytes)
        .map_err(|_| failure("ASSET_DESCRIPTOR_INVALID", format!("Asset {id} descriptor is corrupt. Restore its original descriptor or remove its library entry and reimport."), None))?;
    validate_ref(&stored.asset)?;
    if stored.asset.id != id {
        return Err(failure(
            "ASSET_DESCRIPTOR_INVALID",
            format!("Asset {id} descriptor has a mismatched ID."),
            None,
        ));
    }
    validate_info(&stored.info, &stored.asset)?;
    Ok(stored)
}
fn verified_bytes(root: &Path, asset: &AssetRef) -> Result<Vec<u8>, NativeError> {
    let stored = read_descriptor(root, &asset.id)?;
    if stored.asset.kind != asset.kind {
        return Err(failure(
            "ASSET_CORRUPT",
            format!("Asset {} has a mismatched kind.", asset.id),
            None,
        ));
    }
    let path = asset_directory(root, &asset.id)?.join(format!("asset.{}", asset.kind.extension()));
    let bytes = regular_file_bytes(&path, asset.kind.limit(), &asset.id)?;
    if content_id(&bytes) != asset.id {
        return Err(failure(
            "ASSET_CORRUPT",
            format!(
                "Asset {} bytes no longer match their hash. Restore the original imported file.",
                asset.id
            ),
            None,
        ));
    }
    Ok(bytes)
}
fn ensure_library(root: &Path) -> Result<(), NativeError> {
    std::fs::create_dir_all(root).map_err(|_| {
        failure(
            "ASSET_LIBRARY_UNAVAILABLE",
            "Cannot create the Toney asset library.",
            None,
        )
    })?;
    let metadata = std::fs::symlink_metadata(root).map_err(|_| {
        failure(
            "ASSET_LIBRARY_UNAVAILABLE",
            "Cannot access the Toney asset library.",
            None,
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure(
            "ASSET_LIBRARY_UNAVAILABLE",
            "Toney asset library must be a local directory.",
            None,
        ));
    }
    Ok(())
}
fn persist_asset(
    root: &Path,
    stored: StoredAsset,
    bytes: &[u8],
) -> Result<StoredAsset, NativeError> {
    let _lock = LIBRARY_ACCESS.lock().map_err(|_| {
        failure(
            "ASSET_LIBRARY_UNAVAILABLE",
            "Asset library lock failed.",
            None,
        )
    })?;
    ensure_library(root)?;
    validate_ref(&stored.asset)?;
    validate_info(&stored.info, &stored.asset)?;
    if bytes.len() > stored.asset.kind.limit() || content_id(bytes) != stored.asset.id {
        return Err(failure(
            "ASSET_CORRUPT",
            "Imported content does not match its verified asset ID.",
            None,
        ));
    }
    let destination = root.join(&stored.asset.id);
    if destination.exists() {
        verified_bytes(root, &stored.asset)?;
        let original = read_descriptor(root, &stored.asset.id)?;
        if original.info != stored.info {
            return Err(failure("ASSET_DESCRIPTOR_INVALID", "Existing metadata disagrees with inspection of its bytes. Restore the original library entry or remove it and reimport.", None));
        }
        return Ok(original);
    }
    if std::fs::read_dir(root)
        .map_err(|_| {
            failure(
                "ASSET_LIBRARY_UNAVAILABLE",
                "Cannot read the Toney asset library.",
                None,
            )
        })?
        .take(MAX_ENTRIES)
        .count()
        >= MAX_ENTRIES
    {
        return Err(failure("ASSET_LIBRARY_FULL", "Toney supports up to 128 asset library entries. Remove unused entries before importing another asset.", None));
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix(".import-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder.tempdir_in(root).map_err(|_| {
        failure(
            "ASSET_IMPORT_FAILED",
            "Cannot stage the persistent asset entry.",
            None,
        )
    })?;
    let descriptor = serde_json::to_vec(&stored).map_err(|_| {
        failure(
            "ASSET_DESCRIPTOR_INVALID",
            "Cannot encode asset metadata.",
            None,
        )
    })?;
    for (name, data) in [
        (format!("asset.{}", stored.asset.kind.extension()), bytes),
        ("descriptor.json".into(), descriptor.as_slice()),
    ] {
        let mut file = std::fs::File::create(directory.path().join(name)).map_err(|_| {
            failure(
                "ASSET_IMPORT_FAILED",
                "Cannot create asset library files.",
                None,
            )
        })?;
        file.write_all(data)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all())
            .map_err(|_| {
                failure(
                    "ASSET_IMPORT_FAILED",
                    "Cannot write complete asset library files.",
                    None,
                )
            })?;
    }
    if std::fs::rename(directory.path(), &destination).is_err() {
        if destination.exists() {
            verified_bytes(root, &stored.asset)?;
            return read_descriptor(root, &stored.asset.id);
        }
        return Err(failure(
            "ASSET_IMPORT_FAILED",
            "Cannot atomically install the asset library entry.",
            None,
        ));
    }
    Ok(stored)
}
fn list_library(root: &Path) -> Result<LibraryOutput, NativeError> {
    let _lock = LIBRARY_ACCESS.lock().map_err(|_| {
        failure(
            "ASSET_LIBRARY_UNAVAILABLE",
            "Asset library lock failed.",
            None,
        )
    })?;
    if !root.exists() {
        return Ok(LibraryOutput {
            assets: Vec::new(),
            diagnostics: Vec::new(),
        });
    }
    ensure_library(root)?;
    let mut output = LibraryOutput {
        assets: Vec::new(),
        diagnostics: Vec::new(),
    };
    let entries = std::fs::read_dir(root).map_err(|_| {
        failure(
            "ASSET_LIBRARY_UNAVAILABLE",
            "Cannot read Toney asset library entries.",
            None,
        )
    })?;
    for (index, entry) in entries.take(MAX_ENTRIES + 1).enumerate() {
        if index == MAX_ENTRIES {
            output.diagnostics.push(AssetDiagnostic {
                id: "library".into(),
                code: "ASSET_LIBRARY_LIMIT".into(),
                message:
                    "Library listing stopped at 128 entries. Remove unused or invalid entries."
                        .into(),
            });
            break;
        }
        let entry = entry.map_err(|_| {
            failure(
                "ASSET_LIBRARY_UNAVAILABLE",
                "Cannot read a Toney library entry.",
                None,
            )
        })?;
        let id = entry.file_name().to_string_lossy().into_owned();
        match read_descriptor(root, &id) {
            Ok(stored) => {
                let path = root
                    .join(&stored.asset.id)
                    .join(format!("asset.{}", stored.asset.kind.extension()));
                match std::fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() > 0 && metadata.len() <= stored.asset.kind.limit() as u64 => output.assets.push(stored),
                    _ => output.diagnostics.push(AssetDiagnostic {id, code: "ASSET_MISSING_OR_CORRUPT".into(), message: "Library asset bytes are missing, invalid, or too large. Restore the original library entry or remove it and reimport.".into()}),
                }
            }
            Err(error) => output.diagnostics.push(AssetDiagnostic {
                id: id.chars().take(200).collect(),
                code: error.code,
                message: error.message,
            }),
        }
    }
    output.assets.sort_by(|a, b| {
        a.asset
            .name
            .cmp(&b.asset.name)
            .then(a.asset.id.cmp(&b.asset.id))
    });
    Ok(output)
}

pub(super) fn stage_tone_assets(
    root: &Path,
    tone: &Value,
    staging: &Path,
    request_id: &str,
) -> Result<Vec<TrustedAssetPath>, NativeError> {
    let mut refs = BTreeMap::new();
    let Some(chain) = tone.get("chain").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    if chain.len() > 32 {
        return Err(failure(
            "ASSET_REFERENCE_INVALID",
            "A tone cannot contain more than 32 nodes.",
            Some(request_id),
        ));
    }
    for node in chain {
        if node.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let model = node.get("model").and_then(Value::as_str);
        let expected = match model {
            Some("cab_ir") => Some(AssetKind::Ir),
            Some("nam") => Some(AssetKind::Nam),
            _ => None,
        };
        if expected.is_none() && node.get("asset").is_none() {
            continue;
        }
        if tone.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
            return Err(failure(
                "ASSET_REFERENCE_INVALID",
                "External assets require ToneSpec schema 2.",
                Some(request_id),
            ));
        }
        let asset: AssetRef = node
            .get("asset")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .ok_or_else(|| {
                failure(
                    "ASSET_REFERENCE_INVALID",
                    "Enabled external models require valid asset references.",
                    Some(request_id),
                )
            })?;
        validate_ref(&asset).map_err(|mut error| {
            error.request_id = Some(request_id.into());
            error
        })?;
        if expected != Some(asset.kind) {
            return Err(failure(
                "ASSET_REFERENCE_INVALID",
                "Tone asset kind does not match its external model.",
                Some(request_id),
            ));
        }
        refs.insert(asset.id.clone(), asset);
    }
    refs.into_values()
        .map(|asset| {
            let bytes = verified_bytes(root, &asset).map_err(|mut error| {
                error.request_id = Some(request_id.into());
                error
            })?;
            let path = staging.join(format!("{}.{}", asset.id, asset.kind.extension()));
            std::fs::write(&path, bytes).map_err(|_| {
                failure(
                    "ASSET_STAGING_FAILED",
                    format!("Cannot stage asset {}.", asset.id),
                    Some(request_id),
                )
            })?;
            Ok(TrustedAssetPath {
                id: asset.id,
                kind: asset.kind,
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

#[tauri::command]
pub(super) async fn native_import_asset(
    app: tauri::AppHandle,
    request: Value,
) -> Result<ImportOutput, NativeError> {
    let root = library_path(&app)?;
    import_asset(app, validate_import(request)?, root).await
}

async fn import_asset<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: ImportRequest,
    root: PathBuf,
) -> Result<ImportOutput, NativeError> {
    let request_id = request.request_id;
    let id = Some(request_id.as_str());
    let asset = AssetRef {
        id: content_id(&request.data),
        kind: request.kind,
        name: request.name,
    };
    let asset_copy = asset.clone();
    let (directory, bytes) = tauri::async_runtime::spawn_blocking(move || {
        let directory = super::stage_render(&request.data)?;
        let path = directory
            .path()
            .join(format!("asset.{}", asset_copy.kind.extension()));
        std::fs::rename(directory.path().join("input.wav"), &path)?;
        Ok::<_, std::io::Error>((directory, request.data))
    })
    .await
    .map_err(|_| failure("ASSET_STAGING_FAILED", "Asset staging task failed.", id))?
    .map_err(|_| {
        failure(
            "ASSET_STAGING_FAILED",
            "Cannot create private asset staging files.",
            id,
        )
    })?;
    let response = run_engine_request(
        app,
        EngineRequest {
            protocol_version: 1,
            request_id: request_id.clone(),
            command: EngineCommand::InspectAsset,
            tone: None,
            render: None,
            asset: Some(TrustedAssetPath {
                id: asset.id.clone(),
                kind: asset.kind,
                path: directory
                    .path()
                    .join(format!("asset.{}", asset.kind.extension()))
                    .to_string_lossy()
                    .into_owned(),
            }),
        },
        Duration::from_secs(60),
    )
    .await?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(failure(
            response
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("ASSET_INVALID"),
            response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Asset inspection failed."),
            id,
        ));
    }
    let info = response.get("result").cloned().ok_or_else(|| {
        failure(
            "ASSET_INSPECTION_INVALID",
            "Asset inspection returned no metadata.",
            id,
        )
    })?;
    validate_info(&info, &asset).map_err(|mut error| {
        error.request_id = Some(request_id.clone());
        error
    })?;
    let stored = StoredAsset { asset, info };
    let saved = tauri::async_runtime::spawn_blocking(move || persist_asset(&root, stored, &bytes))
        .await
        .map_err(|_| failure("ASSET_IMPORT_FAILED", "Asset persistence task failed.", id))?
        .map_err(|mut error| {
            error.request_id = Some(request_id.clone());
            error
        })?;
    drop(directory);
    Ok(ImportOutput {
        response,
        asset: saved.asset,
        info: saved.info,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListRequest {
    protocol_version: u32,
    request_id: String,
}

fn validate_list_request(value: Value) -> Result<ListRequest, NativeError> {
    let request: ListRequest = serde_json::from_value(value).map_err(|_| {
        failure(
            "ASSET_LIST_INVALID",
            "Library listing requires only protocol version and request ID.",
            None,
        )
    })?;
    validate_request_id(&request.request_id)?;
    if request.protocol_version != 1 {
        return Err(failure(
            "ENGINE_PROTOCOL_UNSUPPORTED",
            "Asset listing protocol must be version 1.",
            Some(&request.request_id),
        ));
    }
    Ok(request)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListOutput {
    protocol_version: u32,
    request_id: String,
    #[serde(flatten)]
    library: LibraryOutput,
}

#[tauri::command]
pub(super) async fn native_list_assets(
    app: tauri::AppHandle,
    request: Value,
) -> Result<ListOutput, NativeError> {
    let request = validate_list_request(request)?;
    let root = library_path(&app)?;
    let library = tauri::async_runtime::spawn_blocking(move || list_library(&root))
        .await
        .map_err(|_| {
            failure(
                "ASSET_LIBRARY_UNAVAILABLE",
                "Library listing task failed.",
                Some(&request.request_id),
            )
        })?
        .map_err(|mut error| {
            error.request_id = Some(request.request_id.clone());
            error
        })?;
    Ok(ListOutput {
        protocol_version: 1,
        request_id: request.request_id,
        library,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stored(data: &[u8], name: &str) -> StoredAsset {
        let asset = AssetRef {
            id: content_id(data),
            kind: AssetKind::Ir,
            name: name.into(),
        };
        let info = json!({"kind":"asset-info","id":asset.id,"assetKind":"ir","sampleRate":48000,"channels":1,"frames":16});
        StoredAsset { asset, info }
    }
    fn tone(asset: &AssetRef, enabled: bool) -> Value {
        json!({"schemaVersion":2,"chain":[{"type":"cab","model":"cab_ir","enabled":enabled,"asset":asset}]})
    }

    #[test]
    fn real_helper_import_persist_restart_and_ir_render_use_trusted_paths() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut wave = super::super::tests::test_wav();
        wave[4..8].copy_from_slice(&40u32.to_le_bytes());
        wave[40..44].copy_from_slice(&4u32.to_le_bytes());
        wave.extend_from_slice(&16384i16.to_le_bytes());
        wave.extend_from_slice(&0i16.to_le_bytes());
        let request = ImportRequest {
            protocol_version: 1,
            request_id: "bridge-import-123".into(),
            kind: AssetKind::Ir,
            name: "real-impulse.wav".into(),
            data: wave.clone(),
        };
        let imported = tauri::async_runtime::block_on(import_asset(
            app.handle().clone(),
            request,
            root.path().to_owned(),
        ))
        .unwrap();
        assert_eq!(imported.response["requestId"], "bridge-import-123");
        assert_eq!(imported.info["frames"], 2);
        assert_eq!(
            list_library(root.path()).unwrap().assets[0].asset.id,
            content_id(&wave)
        );
        let staging = super::super::stage_render(&wave).unwrap();
        let tone = json!({"schemaVersion":2,"id":"bridge-tone","name":"IR bridge test","revision":1,"chain":[{"id":"cab","type":"cab","model":"cab_ir","enabled":true,"asset":imported.asset,"parameters":{"brightness":0.5,"resonance":0.35}}],"metadata":{"createdAt":"2026-10-03T00:00:00.000Z","updatedAt":"2026-10-03T00:00:00.000Z","source":"manual"}});
        let resolved =
            stage_tone_assets(root.path(), &tone, staging.path(), "bridge-render-123").unwrap();
        let request = EngineRequest {
            protocol_version: 1,
            request_id: "bridge-render-123".into(),
            command: EngineCommand::RenderAudio,
            tone: Some(tone),
            asset: None,
            render: Some(super::super::RenderPaths {
                input_path: staging
                    .path()
                    .join("input.wav")
                    .to_string_lossy()
                    .into_owned(),
                output_path: staging
                    .path()
                    .join("output.wav")
                    .to_string_lossy()
                    .into_owned(),
                assets: resolved,
            }),
        };
        let response = tauri::async_runtime::block_on(run_engine_request(
            app.handle().clone(),
            request,
            Duration::from_secs(60),
        ))
        .unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["result"]["kind"], "audio-render");
        assert!(
            !super::super::read_render_output(staging.path(), "bridge-render-123")
                .unwrap()
                .is_empty()
        );
        let invalid_root = tempfile::tempdir().unwrap();
        let invalid = ImportRequest {
            protocol_version: 1,
            request_id: "bridge-invalid-123".into(),
            kind: AssetKind::Ir,
            name: "invalid.wav".into(),
            data: b"not a wave".to_vec(),
        };
        let error = tauri::async_runtime::block_on(import_asset(
            app.handle().clone(),
            invalid,
            invalid_root.path().to_owned(),
        ))
        .err()
        .unwrap();
        assert_eq!(error.code, "ASSET_INVALID");
        assert_eq!(error.request_id.as_deref(), Some("bridge-invalid-123"));
        assert_eq!(std::fs::read_dir(invalid_root.path()).unwrap().count(), 0);
    }

    fn nam_fixture() -> PathBuf {
        let build = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../engine/audio/build");
        let mut sources: Vec<PathBuf> = std::env::var_os("NAM_PATH")
            .map(PathBuf::from)
            .into_iter()
            .collect();
        if let Ok(cache) = std::fs::read_to_string(build.join("CMakeCache.txt")) {
            for line in cache.lines() {
                if let Some(source) = line
                    .strip_prefix("NAM_PATH:PATH=")
                    .or_else(|| line.strip_prefix("toney_nam_SOURCE_DIR:STATIC="))
                {
                    if !source.is_empty() {
                        sources.push(PathBuf::from(source));
                    }
                }
            }
        }
        sources.push(build.join("_deps/toney_nam-src"));
        sources.into_iter().map(|source| source.join("example_models/lstm.nam")).find(|path| path.is_file())
            .expect("Build the native helper first or set NAM_PATH to the pinned official NAM core checkout; its LSTM example is required for the real bridge test.")
    }

    #[test]
    fn real_helper_imports_official_nam_and_renders_after_library_restart() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        let data = std::fs::read(nam_fixture()).unwrap();
        let request = ImportRequest {
            protocol_version: 1,
            request_id: "nam-import-123".into(),
            kind: AssetKind::Nam,
            name: "official-lstm.nam".into(),
            data: data.clone(),
        };
        let imported = tauri::async_runtime::block_on(import_asset(
            app.handle().clone(),
            request,
            root.path().to_owned(),
        ))
        .unwrap();
        assert_eq!(imported.asset.id, content_id(&data));
        assert_eq!(imported.info["architecture"], "LSTM");
        assert_eq!(imported.info["modelVersion"], "0.5.4");
        assert_eq!(imported.response["requestId"], "nam-import-123");
        assert_eq!(
            list_library(root.path()).unwrap().assets[0].asset.id,
            imported.asset.id
        );
        let mut wave = super::super::tests::test_wav();
        wave[4..8].copy_from_slice(&40u32.to_le_bytes());
        wave[40..44].copy_from_slice(&4u32.to_le_bytes());
        wave.extend_from_slice(&8192i16.to_le_bytes());
        wave.extend_from_slice(&0i16.to_le_bytes());
        let staging = super::super::stage_render(&wave).unwrap();
        let tone = json!({"schemaVersion":2,"id":"nam-bridge-tone","name":"NAM bridge test","revision":1,"chain":[{"id":"amp","type":"amp","model":"nam","enabled":true,"asset":imported.asset,"parameters":{"gain":0.25,"bass":0.5,"mid":0.55,"treble":0.5,"master":0.65}}],"metadata":{"createdAt":"2026-10-03T00:00:00.000Z","updatedAt":"2026-10-03T00:00:00.000Z","source":"manual"}});
        let resolved =
            stage_tone_assets(root.path(), &tone, staging.path(), "nam-render-123").unwrap();
        let request = EngineRequest {
            protocol_version: 1,
            request_id: "nam-render-123".into(),
            command: EngineCommand::RenderAudio,
            tone: Some(tone),
            asset: None,
            render: Some(super::super::RenderPaths {
                input_path: staging
                    .path()
                    .join("input.wav")
                    .to_string_lossy()
                    .into_owned(),
                output_path: staging
                    .path()
                    .join("output.wav")
                    .to_string_lossy()
                    .into_owned(),
                assets: resolved,
            }),
        };
        let response = tauri::async_runtime::block_on(run_engine_request(
            app.handle().clone(),
            request,
            Duration::from_secs(60),
        ))
        .unwrap();
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["requestId"], "nam-render-123");
        assert!(response["result"]["peak"].as_f64().unwrap() > 0.0);
        assert!(
            !super::super::read_render_output(staging.path(), "nam-render-123")
                .unwrap()
                .is_empty()
        );
        let mut unsupported: Value = serde_json::from_slice(&data).unwrap();
        unsupported["version"] = json!("0.5.5");
        let request = ImportRequest {
            protocol_version: 1,
            request_id: "nam-version-123".into(),
            kind: AssetKind::Nam,
            name: "unsupported.nam".into(),
            data: serde_json::to_vec(&unsupported).unwrap(),
        };
        let error = tauri::async_runtime::block_on(import_asset(
            app.handle().clone(),
            request,
            root.path().to_owned(),
        ))
        .err()
        .unwrap();
        assert_eq!(error.code, "ASSET_UNSUPPORTED");
        assert_eq!(list_library(root.path()).unwrap().assets.len(), 1);
    }

    #[test]
    fn list_requests_are_versioned_and_cannot_select_library_paths() {
        assert!(validate_list_request(json!({"protocolVersion":1,"requestId":"list-123"})).is_ok());
        assert!(validate_list_request(
            json!({"protocolVersion":1,"requestId":"list-123","path":"/private/other"})
        )
        .is_err());
        assert!(
            validate_list_request(json!({"protocolVersion":2,"requestId":"list-123"})).is_err()
        );
    }

    #[test]
    fn import_rejects_paths_extra_fields_kinds_and_size_overflow() {
        let request = json!({"protocolVersion":1,"requestId":"asset-123","kind":"ir","name":"cab.wav","data":[1]});
        assert!(validate_import(request.clone()).is_ok());
        for (key, value) in [
            ("name", json!("../cab.wav")),
            ("name", json!("folder\\cab.wav")),
            ("path", json!("/private/file.wav")),
            ("kind", json!("onnx")),
            ("requestId", json!("../id")),
            ("protocolVersion", json!(2)),
        ] {
            let mut invalid = request.clone();
            invalid[key] = value;
            assert!(validate_import(invalid).is_err());
        }
        let mut request = validate_import(request).unwrap();
        request.data = vec![0; AssetKind::Ir.limit() + 1];
        assert_eq!(
            validate_import_bounds(&request).unwrap_err().code,
            "ASSET_TOO_LARGE"
        );
        request.kind = AssetKind::Nam;
        assert!(validate_import_bounds(&request).is_ok());
        request.data = vec![0; AssetKind::Nam.limit() + 1];
        assert!(validate_import_bounds(&request).is_err());
        assert_eq!(
            content_id(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn inspection_metadata_must_match_content_id_kind_and_supported_details() {
        let data = stored(b"ir", "cab.wav");
        assert!(validate_info(&data.info, &data.asset).is_ok());
        for (key, value) in [
            ("id", json!("0".repeat(64))),
            ("assetKind", json!("nam")),
            ("channels", json!(3)),
            ("frames", json!(96001)),
            ("path", json!("/private/file.wav")),
        ] {
            let mut info = data.info.clone();
            info[key] = value;
            assert!(validate_info(&info, &data.asset).is_err());
        }
        let asset = AssetRef {
            id: content_id(b"nam"),
            kind: AssetKind::Nam,
            name: "amp.nam".into(),
        };
        let info = json!({"kind":"asset-info","id":asset.id,"assetKind":"nam","sampleRate":48000,"channels":1,"architecture":"WaveNet","modelVersion":"0.5.4"});
        assert!(validate_info(&info, &asset).is_ok());
        for version in ["0.5.5", "0.5.04", "0.6.0", "0.5.4-extra"] {
            let mut unsupported = info.clone();
            unsupported["modelVersion"] = json!(version);
            assert!(validate_info(&unsupported, &asset).is_err());
        }
        let mut unsupported = info;
        unsupported["architecture"] = json!("Transformer");
        assert!(validate_info(&unsupported, &asset).is_err());
    }

    #[test]
    fn immutable_content_library_survives_restart_and_preserves_first_name() {
        let root = tempfile::tempdir().unwrap();
        let data = b"fixture impulse bytes";
        let first = persist_asset(root.path(), stored(data, "first.wav"), data).unwrap();
        let repeated = persist_asset(root.path(), stored(data, "renamed.wav"), data).unwrap();
        assert_eq!(repeated.asset.name, "first.wav");
        assert_eq!(repeated.asset.id, first.asset.id);
        assert_eq!(verified_bytes(root.path(), &first.asset).unwrap(), data);
        let reopened = list_library(root.path()).unwrap();
        assert_eq!(reopened.assets.len(), 1);
        assert!(reopened.diagnostics.is_empty());
        assert_eq!(reopened.assets[0].asset.name, "first.wav");
        let serialized = serde_json::to_string(&reopened).unwrap();
        assert!(!serialized.contains(root.path().to_str().unwrap()));
        assert!(!serialized.contains("path"));
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn rendering_stages_verified_enabled_assets_and_rejects_missing_or_modified_bytes() {
        let root = tempfile::tempdir().unwrap();
        let staging = super::super::stage_render(b"audio").unwrap();
        let stored = stored(b"fixture impulse bytes", "cab.wav");
        let active = tone(&stored.asset, true);
        let bypassed = tone(&stored.asset, false);
        assert!(
            stage_tone_assets(root.path(), &bypassed, staging.path(), "render-123")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            stage_tone_assets(root.path(), &active, staging.path(), "render-123")
                .unwrap_err()
                .code,
            "ASSET_MISSING"
        );
        let saved = persist_asset(root.path(), stored, b"fixture impulse bytes").unwrap();
        let resolved =
            stage_tone_assets(root.path(), &active, staging.path(), "render-123").unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(
            std::fs::read(&resolved[0].path).unwrap(),
            b"fixture impulse bytes"
        );
        assert!(Path::new(&resolved[0].path).starts_with(staging.path()));
        std::fs::write(
            root.path().join(&saved.asset.id).join("asset.wav"),
            b"modified bytes",
        )
        .unwrap();
        let error =
            stage_tone_assets(root.path(), &active, staging.path(), "render-123").unwrap_err();
        assert_eq!(error.code, "ASSET_CORRUPT");
        assert_eq!(error.request_id.as_deref(), Some("render-123"));
        let staging_path = staging.path().to_owned();
        drop(staging);
        assert!(!staging_path.exists());
    }

    #[test]
    fn corrupt_descriptor_is_reported_without_losing_other_library_entries() {
        let root = tempfile::tempdir().unwrap();
        let one = persist_asset(root.path(), stored(b"one", "one.wav"), b"one").unwrap();
        persist_asset(root.path(), stored(b"two", "two.wav"), b"two").unwrap();
        std::fs::write(
            root.path().join(&one.asset.id).join("descriptor.json"),
            b"malformed",
        )
        .unwrap();
        let listed = list_library(root.path()).unwrap();
        assert_eq!(listed.assets.len(), 1);
        assert_eq!(listed.diagnostics.len(), 1);
        assert_eq!(listed.diagnostics[0].id, one.asset.id);
        assert_eq!(listed.diagnostics[0].code, "ASSET_DESCRIPTOR_INVALID");
        assert!(persist_asset(root.path(), stored(b"one", "override.wav"), b"one").is_err());
        assert_eq!(
            std::fs::read(root.path().join(&one.asset.id).join("descriptor.json")).unwrap(),
            b"malformed"
        );
    }

    #[test]
    fn library_listing_and_import_are_bounded_and_asset_paths_cannot_escape() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..=MAX_ENTRIES {
            std::fs::create_dir(root.path().join(format!("{index:064x}"))).unwrap();
        }
        let listed = list_library(root.path()).unwrap();
        assert_eq!(listed.diagnostics.len(), MAX_ENTRIES + 1);
        assert_eq!(
            listed.diagnostics.last().unwrap().code,
            "ASSET_LIBRARY_LIMIT"
        );
        assert_eq!(
            persist_asset(root.path(), stored(b"new", "new.wav"), b"new")
                .unwrap_err()
                .code,
            "ASSET_LIBRARY_FULL"
        );
        assert!(asset_directory(root.path(), "../escape").is_err());
        let staging = tempfile::tempdir().unwrap();
        let ref_value = json!({"id":"../escape","kind":"ir","name":"cab.wav"});
        let injected = json!({"schemaVersion":2,"chain":[{"enabled":true,"model":"cab_ir","asset":ref_value}]});
        assert!(stage_tone_assets(root.path(), &injected, staging.path(), "render-123").is_err());
        #[cfg(unix)]
        {
            let fake_id = content_id(b"symlink");
            std::os::unix::fs::symlink(staging.path(), root.path().join(&fake_id)).unwrap();
            assert_eq!(
                asset_directory(root.path(), &fake_id).unwrap_err().code,
                "ASSET_CORRUPT"
            );
        }
    }
}
