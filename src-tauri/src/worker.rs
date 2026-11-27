use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::Path,
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{async_runtime::spawn_blocking, ipc::InvokeBody, AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

pub struct MediaWorker {
    input: Mutex<Option<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Message {
    Reply {
        id: u64,
        result: Option<Value>,
        error: Option<String>,
    },
    Event {
        name: String,
        payload: Value,
    },
}

fn read_messages(app: AppHandle, stdout: impl std::io::Read, pending: Pending) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        match serde_json::from_str(&line) {
            Ok(Message::Reply { id, result, error }) => {
                let waiter = pending
                    .lock()
                    .ok()
                    .and_then(|mut requests| requests.remove(&id));
                if let Some(waiter) = waiter {
                    let _ =
                        waiter.send(error.map_or_else(|| Ok(result.unwrap_or(Value::Null)), Err));
                }
            }
            Ok(Message::Event { name, payload }) => {
                if matches!(
                    name.as_str(),
                    "kadr-export-progress" | "kadr-proxy-progress" | "kadr-reverse-progress"
                ) {
                    let _ = app.emit_to("main", &name, payload);
                }
            }
            Err(error) => eprintln!("Invalid media worker reply: {error}"),
        }
    }
    if let Ok(mut pending) = pending.lock() {
        for (_, reply) in pending.drain() {
            let _ = reply.send(Err("The Kadr media worker exited".into()));
        }
    }
}

impl MediaWorker {
    pub fn start(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let resources = app.path().resource_dir()?;
        let current_exe = std::env::current_exe()?;
        let bin = current_exe
            .parent()
            .ok_or("Missing Kadr executable directory")?;
        let cache = crate::project::data_dir(app)?.join("media");
        std::fs::create_dir_all(&cache)?;
        let mut child = Command::new(bin.join("kadr-node.exe"))
            .arg(resources.join("media-worker.cjs"))
            .env("KADR_FFMPEG", bin.join("ffmpeg.exe"))
            .env("KADR_FFPROBE", bin.join("ffprobe.exe"))
            .env("KADR_TAURI_CACHE", &cache)
            .env(
                "KADR_TAURI_DOWNLOADS",
                app.path().download_dir().unwrap_or_else(|_| cache.clone()),
            )
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let input = child.stdin.take().ok_or("Missing media worker stdin")?;
        let stdout = child.stdout.take().ok_or("Missing media worker stdout")?;
        let pending = Pending::default();
        let reader_pending = pending.clone();
        let reader_app = app.clone();
        std::thread::Builder::new()
            .name("kadr-media-replies".into())
            .spawn(move || {
                read_messages(reader_app, stdout, reader_pending);
                let _ = child.wait();
            })?;
        Ok(Self {
            input: Mutex::new(Some(input)),
            pending,
            next_id: AtomicU64::new(1),
        })
    }

    pub fn close(&self) {
        if let Ok(mut input) = self.input.lock() {
            input.take();
        }
    }

    fn send(
        &self,
        method: String,
        args: Vec<Value>,
        bytes: &[u8],
    ) -> Result<oneshot::Receiver<Reply>, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let header = json!({ "id": id, "method": method, "args": args, "bytes": bytes.len() });
        let (tx, rx) = oneshot::channel();
        let mut lock = self.input.lock().map_err(|error| error.to_string())?;
        let input = lock.as_mut().ok_or("The Kadr media worker is closed")?;
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, tx);
        let write = writeln!(input, "{header}").and_then(|_| input.write_all(bytes));
        if let Err(error) = write {
            if let Ok(mut requests) = self.pending.lock() {
                requests.remove(&id);
            }
            return Err(format!("Could not send the media request: {error}"));
        }
        Ok(rx)
    }
}

async fn call(worker: Arc<MediaWorker>, method: String, args: Vec<Value>, bytes: Vec<u8>) -> Reply {
    let reply = spawn_blocking(move || worker.send(method, args, &bytes))
        .await
        .map_err(|error| error.to_string())??;
    reply
        .await
        .map_err(|_| "The media worker closed the request".to_owned())?
}

#[tauri::command]
pub async fn media_request(
    app: AppHandle,
    worker: State<'_, Arc<MediaWorker>>,
    method: String,
    args: Vec<Value>,
) -> Reply {
    let source = if method == "probeMedia" {
        args.first().and_then(Value::as_str).map(str::to_owned)
    } else {
        None
    };
    let yields_file = matches!(
        method.as_str(),
        "requestProxy" | "requestDecoded" | "reverseMedia"
    );
    let result = call(worker.inner().clone(), method, args, Vec::new()).await?;
    if let Some(path) = source
        .as_deref()
        .or_else(|| yields_file.then(|| result.as_str()).flatten())
    {
        crate::project::allow_media(&app, Path::new(path))?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn media_bytes(
    app: AppHandle,
    worker: State<'_, Arc<MediaWorker>>,
    request: tauri::ipc::Request<'_>,
) -> Reply {
    let method = request
        .headers()
        .get("x-kadr-method")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing binary operation")?
        .to_owned();
    if !matches!(
        method.as_str(),
        "rawEncodeFrame" | "exportVideoChunk" | "saveBlobMedia" | "saveSnapshot"
    ) {
        return Err("Unsupported binary operation".into());
    }
    let args = request
        .headers()
        .get("x-kadr-args")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("[]");
    let args = percent_encoding::percent_decode_str(args)
        .decode_utf8()
        .map_err(|error| error.to_string())?;
    let args = serde_json::from_str(&args).map_err(|error| error.to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a binary media packet".into());
    };
    if bytes.is_empty() {
        return Err("Empty binary media packet".into());
    }
    let yields_file = matches!(method.as_str(), "saveBlobMedia" | "saveSnapshot");
    let result = call(worker.inner().clone(), method, args, bytes.clone()).await?;
    if yields_file {
        if let Some(path) = result.as_str() {
            crate::project::allow_media(&app, Path::new(path))?;
        }
    }
    Ok(result)
}
