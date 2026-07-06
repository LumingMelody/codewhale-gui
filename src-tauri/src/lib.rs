mod sidecar;

use sidecar::SidecarState;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::get_runtime_info,
            sidecar::restart_sidecar,
            sidecar::run_doctor,
            sidecar::set_api_key,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::start(handle.clone()).await {
                    eprintln!("sidecar start failed: {e}");
                    let _ = handle.emit("sidecar-crashed", e);
                }
            });
            // SIGTERM/SIGINT 也要清掉引擎进程树（RunEvent::Exit 只覆盖正常退出）
            let signal_handle = app.handle().clone();
            ctrlc::set_handler(move || {
                sidecar::shutdown(&signal_handle);
                std::process::exit(0);
            })
            .expect("install signal handler");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::shutdown(app);
            }
        });
}
