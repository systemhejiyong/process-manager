use procman_core::{
    is_elevated, kill_many, list_processes, list_processes_lite, platform_elevate_label,
    related_processes, search_by_name, search_by_port, watch_respawn, KillResult, ProcessInfo,
    RelatedProcess, RespawnWatch,
};
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
struct Meta {
    elevated: bool,
    elevate_label: String,
    version: String,
}

#[tauri::command]
fn get_meta() -> Meta {
    Meta {
        elevated: is_elevated(),
        elevate_label: platform_elevate_label().into(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

#[tauri::command]
fn list_all() -> Vec<ProcessInfo> {
    list_processes()
}

#[tauri::command]
fn find_by_name(query: String) -> Vec<ProcessInfo> {
    search_by_name(&query)
}

#[tauri::command]
fn find_by_port(port: u16) -> Vec<ProcessInfo> {
    search_by_port(port)
}

/// Prefer `process` snapshot from UI so parent/exe/project_dir are already known.
/// Uses lite listing (no ports / no project-dir filesystem walks) for matching.
#[tauri::command]
fn get_related(pid: u32, process: Option<ProcessInfo>) -> Vec<RelatedProcess> {
    let all = list_processes_lite();
    let sel = match process {
        Some(p) if p.pid == pid => p,
        _ => match all.iter().find(|p| p.pid == pid) {
            Some(p) => p.clone(),
            None => return vec![],
        },
    };
    related_processes(&sel, &all)
}

#[tauri::command]
fn kill_pids(pids: Vec<u32>, watch_secs: u64) -> (Vec<KillResult>, Vec<RespawnWatch>) {
    let before = list_processes_lite();
    let names: Vec<String> = pids
        .iter()
        .filter_map(|pid| before.iter().find(|p| p.pid == *pid).map(|p| p.name.clone()))
        .collect();
    let results = kill_many(&pids);
    let watch = if watch_secs > 0 {
        watch_respawn(&names, &pids, watch_secs)
    } else {
        vec![]
    };
    (results, watch)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_meta,
            list_all,
            find_by_name,
            find_by_port,
            get_related,
            kill_pids
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Disable WebView2 default context menu (返回/刷新/另存为…).
                // Do NOT reload here — reload during setup blanks the Tauri asset frontend on Windows.
                let _ = window.with_webview(|webview| {
                    #[cfg(windows)]
                    unsafe {
                        let controller = webview.controller();
                        if let Ok(core) = controller.CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                let _ = settings.SetAreDefaultContextMenusEnabled(false);
                            }
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = &webview;
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
