#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;
mod worker;

use std::sync::Arc;
use tauri::{Manager, RunEvent};
use worker::MediaWorker;

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let worker = MediaWorker::start(app.handle())?;
            app.manage(Arc::new(worker));
            if std::env::var_os("KADR_TAURI_HEADLESS").is_none() {
                app.get_webview_window("main")
                    .ok_or("Missing editor window")?
                    .show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project::pick_paths,
            project::read_project,
            project::write_project,
            project::autosave_project,
            project::read_user_store,
            project::write_user_store,
            project::read_text_file,
            project::write_text_file,
            project::stat_file,
            worker::media_request,
            worker::media_bytes
        ])
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, RunEvent::Exit) {
                handle.state::<Arc<MediaWorker>>().close();
            }
        }),
        Err(error) => {
            eprintln!("Kadr failed to start: {error}");
            std::process::exit(1);
        }
    }
}
