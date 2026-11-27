use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Deserialize;
use serde_json::Value;
use tauri::{async_runtime::spawn_blocking, AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KADR_TAURI_DATA") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())
}

pub fn allow_media(app: &AppHandle, path: &Path) -> Result<(), String> {
    if path.is_absolute() && path.is_file() {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing output directory")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    file.write_all(data).map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn write_json(path: &Path, data: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
    atomic_write(path, &bytes)
}

#[tauri::command]
pub async fn read_project(app: AppHandle, path: PathBuf) -> Result<Value, String> {
    spawn_blocking(move || {
        let project = read_json(&path)?;
        if project.get("version").and_then(Value::as_i64) != Some(1)
            || !project.get("tracks").is_some_and(Value::is_array)
        {
            return Err("Invalid Kadr project".into());
        }
        if let Some(assets) = project.get("assets").and_then(Value::as_array) {
            for asset in assets {
                for field in ["path", "proxyPath"] {
                    if let Some(path) = asset.get(field).and_then(Value::as_str) {
                        allow_media(&app, Path::new(path))?;
                    }
                }
            }
        }
        Ok(project)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_project(path: PathBuf, project: Value) -> Result<(), String> {
    spawn_blocking(move || write_json(&path, &project))
        .await
        .map_err(|error| error.to_string())?
}

fn safe_name(name: &str) -> String {
    let name = name
        .trim()
        .trim_matches('.')
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    if name.is_empty() {
        "Untitled".into()
    } else {
        name
    }
}

#[tauri::command]
pub async fn autosave_project(
    app: AppHandle,
    project: Value,
    main_path: Option<PathBuf>,
) -> Result<PathBuf, String> {
    spawn_blocking(move || {
        let path = match main_path {
            Some(path) => {
                let stem = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("Untitled");
                path.with_file_name(format!("{stem}.autosave.kadr"))
            }
            None => {
                let name = safe_name(
                    project
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Untitled"),
                );
                app.path()
                    .download_dir()
                    .map_err(|error| error.to_string())?
                    .join(format!("{name}.autosave.kadr"))
            }
        };
        write_json(&path, &project)?;
        Ok(path)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn user_store(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid settings name".into());
    }
    Ok(data_dir(app)?.join(format!("{name}.json")))
}

#[tauri::command]
pub async fn read_user_store(app: AppHandle, name: String) -> Result<Value, String> {
    spawn_blocking(move || {
        let path = user_store(&app, &name)?;
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Value::Null),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_user_store(app: AppHandle, name: String, data: Value) -> Result<(), String> {
    spawn_blocking(move || {
        let path = user_store(&app, &name)?;
        fs::create_dir_all(data_dir(&app)?).map_err(|error| error.to_string())?;
        write_json(&path, &data)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_text_file(path: PathBuf) -> Result<Option<String>, String> {
    spawn_blocking(move || match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_text_file(path: PathBuf, content: String) -> Result<(), String> {
    spawn_blocking(move || atomic_write(&path, content.as_bytes()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stat_file(path: PathBuf) -> Result<Option<u64>, String> {
    spawn_blocking(move || match fs::metadata(path) {
        Ok(info) => Ok(info
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|time| u64::try_from(time.as_millis()).ok())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DialogKind {
    Import,
    OpenProject,
    SaveProject,
    Export,
    Directory,
}

#[tauri::command]
pub async fn pick_paths(
    app: AppHandle,
    kind: DialogKind,
    name: Option<String>,
    extension: Option<String>,
) -> Result<Vec<PathBuf>, String> {
    spawn_blocking(move || {
        let dialog = app.dialog().file();
        let paths = match kind {
            DialogKind::Import => dialog
                .add_filter(
                    "Media",
                    &[
                        "mp4", "mov", "mkv", "avi", "webm", "m4v", "ts", "wav", "mp3", "aac",
                        "flac", "m4a", "ogg", "opus", "png", "jpg", "jpeg", "webp", "gif", "bmp",
                        "srt", "txt",
                    ],
                )
                .add_filter("All files", &["*"])
                .blocking_pick_files()
                .unwrap_or_default(),
            DialogKind::OpenProject => dialog
                .add_filter("Kadr", &["kadr"])
                .blocking_pick_file()
                .into_iter()
                .collect(),
            DialogKind::SaveProject | DialogKind::Export => {
                let ext = match kind {
                    DialogKind::SaveProject => "kadr".to_owned(),
                    _ => extension.unwrap_or_else(|| "mp4".to_owned()),
                };
                if ext.is_empty() || !ext.bytes().all(|c| c.is_ascii_alphanumeric()) {
                    return Err("Invalid file extension".into());
                }
                let name = safe_name(name.as_deref().unwrap_or("Untitled"));
                dialog
                    .add_filter(ext.to_ascii_uppercase(), &[ext.as_str()])
                    .set_file_name(format!("{name}.{ext}"))
                    .blocking_save_file()
                    .into_iter()
                    .collect()
            }
            DialogKind::Directory => {
                let dialog = if let Some(title) = name {
                    dialog.set_title(title)
                } else {
                    dialog
                };
                dialog.blocking_pick_folder().into_iter().collect()
            }
        };
        paths
            .into_iter()
            .map(|path| path.into_path().map_err(|error| error.to_string()))
            .collect()
    })
    .await
    .map_err(|error| error.to_string())?
}
