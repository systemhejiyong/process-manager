use procman_core::{
    is_elevated, kill_many, list_processes, platform_elevate_label, related_processes,
    search_by_name, search_by_port, watch_respawn, KillResult, ProcessInfo, RelatedProcess,
    RespawnWatch,
};
use serde::Serialize;

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

#[tauri::command]
fn get_related(pid: u32) -> Vec<RelatedProcess> {
    let all = list_processes();
    let Some(sel) = all.iter().find(|p| p.pid == pid) else {
        return vec![];
    };
    related_processes(sel, &all)
}

#[tauri::command]
fn kill_pids(pids: Vec<u32>, watch_secs: u64) -> (Vec<KillResult>, Vec<RespawnWatch>) {
    let before = list_processes();
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
