//! Shared process / port query and kill helpers for Win + Linux.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProcError {
    #[error("{0}")]
    Message(String),
    #[error("拒绝结束系统关键进程 PID {0}")]
    Protected(u32),
    #[error("进程不存在: {0}")]
    NotFound(u32),
    #[error("权限不足，无法结束 PID {0}: {1}")]
    Permission(u32, String),
}

pub type Result<T> = std::result::Result<T, ProcError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub ports: Vec<u16>,
    pub project_dir: Option<String>,
    pub project_dir_note: Option<String>,
    pub parent_pid: Option<u32>,
    pub parent_name: Option<String>,
    pub cmdline: String,
    pub exe_path: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelatedProcess {
    pub relation: String,
    pub pid: u32,
    pub name: String,
    pub exe_path: Option<String>,
    pub service: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillResult {
    pub pid: u32,
    pub name: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RespawnWatch {
    pub name: String,
    pub respawned: bool,
    pub new_pids: Vec<u32>,
}

const PROJECT_MARKERS: &[&str] = &[
    "package.json",
    "pubspec.yaml",
    "Cargo.toml",
    ".git",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
];

pub fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        // Best-effort: assume non-admin unless we can prove otherwise later.
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        libc_geteuid() == 0
    }
}

#[cfg(not(target_os = "windows"))]
fn libc_geteuid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() }
}

pub fn platform_elevate_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "以管理员身份重新启动"
    } else {
        "提权重新启动"
    }
}

fn protected_pid(pid: u32) -> bool {
    pid == 0 || pid == 1
}

fn protected_name(name: &str) -> bool {
    let n = name.to_lowercase();
    let n = n.strip_suffix(".exe").unwrap_or(&n);
    const LINUX: &[&str] = &["systemd", "init", "kthreadd"];
    const WINDOWS: &[&str] = &[
        "system", "registry", "smss", "csrss", "wininit", "services", "lsass", "winlogon",
    ];
    LINUX.iter().chain(WINDOWS.iter()).any(|x| n == *x)
}

/// Windows explorer.exe needs strong confirm but is not hard-blocked.
pub fn needs_strong_confirm(name: &str) -> bool {
    let n = name.to_lowercase();
    n == "explorer.exe" || n == "explorer"
}

fn looks_like_project_root(path: &Path) -> bool {
    PROJECT_MARKERS.iter().any(|m| path.join(m).exists())
}

fn walk_up_for_project(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    for _ in 0..8 {
        if looks_like_project_root(&cur) {
            return Some(cur);
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

fn infer_project_dir(cwd: Option<&Path>, cmdline: &[String], exe: Option<&Path>) -> (Option<String>, Option<String>) {
    if let Some(c) = cwd {
        if let Some(root) = walk_up_for_project(c) {
            return (Some(root.display().to_string()), None);
        }
        if c.exists() {
            // cwd exists but no markers — still useful as working dir
            if looks_like_project_root(c) {
                return (Some(c.display().to_string()), None);
            }
        }
    }

    for arg in cmdline.iter().skip(1) {
        let p = PathBuf::from(arg.trim_matches('"'));
        if p.is_absolute() {
            let base = if p.is_file() {
                p.parent().map(|x| x.to_path_buf())
            } else if p.is_dir() {
                Some(p)
            } else {
                None
            };
            if let Some(b) = base {
                if let Some(root) = walk_up_for_project(&b) {
                    return (Some(root.display().to_string()), None);
                }
            }
        }
        if let Some(rest) = arg.strip_prefix("--cwd=") {
            let p = PathBuf::from(rest);
            if let Some(root) = walk_up_for_project(&p) {
                return (Some(root.display().to_string()), None);
            }
        }
    }

    if let Some(e) = exe {
        if let Some(dir) = e.parent() {
            return (
                Some(dir.display().to_string()),
                Some("仅可执行目录".into()),
            );
        }
    }
    (None, None)
}

fn collect_listening_ports() -> HashMap<u32, Vec<u16>> {
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();

    #[cfg(target_os = "linux")]
    {
        // Prefer `ss` for pid mapping.
        if let Ok(out) = Command::new("ss").args(["-tulnpH"]).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    if let Some((port, pid)) = parse_ss_line(line) {
                        map.entry(pid).or_default().push(port);
                    }
                }
                for v in map.values_mut() {
                    v.sort_unstable();
                    v.dedup();
                }
                return map;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = Command::new("netstat").args(["-ano", "-p", "tcp"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let parts: Vec<_> = line.split_whitespace().collect();
                if parts.len() >= 5 && parts[3].eq_ignore_ascii_case("LISTENING") {
                    if let (Some(port), Ok(pid)) = (parse_host_port(parts[1]), parts[4].parse::<u32>()) {
                        map.entry(pid).or_default().push(port);
                    }
                }
            }
            for v in map.values_mut() {
                v.sort_unstable();
                v.dedup();
            }
            return map;
        }
    }

    map
}

#[cfg(target_os = "linux")]
fn parse_ss_line(line: &str) -> Option<(u16, u32)> {
    // Example: tcp LISTEN 0 511 *:5173 users:(("node",pid=1234,fd=23))
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let local = parts.get(4).or_else(|| parts.get(3))?;
    let port = parse_host_port(local)?;
    let pid = line
        .split("pid=")
        .nth(1)?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some((port, pid))
}

fn parse_host_port(addr: &str) -> Option<u16> {
    // *:5173 or 0.0.0.0:5173 or [::]:5173 or 127.0.0.1:5173
    if let Some(i) = addr.rfind(':') {
        addr[i + 1..].parse().ok()
    } else {
        None
    }
}

pub fn list_processes() -> Vec<ProcessInfo> {
    let ports = collect_listening_ports();
    let mut sys = System::new_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut by_pid: HashMap<u32, String> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        by_pid.insert(pid.as_u32(), proc_.name().to_string_lossy().into_owned());
    }

    let mut out = Vec::new();
    for (pid, proc_) in sys.processes() {
        let pid_u = pid.as_u32();
        let name = proc_.name().to_string_lossy().into_owned();
        let cmdline_vec: Vec<String> = proc_
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        let cmdline = if cmdline_vec.is_empty() {
            name.clone()
        } else {
            cmdline_vec.join(" ")
        };
        let exe = proc_.exe().map(|p| p.to_path_buf());
        let cwd = proc_.cwd().map(|p| p.to_path_buf());
        let parent = proc_.parent().map(|p| p.as_u32());
        let parent_name = parent.and_then(|p| by_pid.get(&p).cloned());
        let (project_dir, project_dir_note) =
            infer_project_dir(cwd.as_deref(), &cmdline_vec, exe.as_deref());

        out.push(ProcessInfo {
            pid: pid_u,
            name,
            ports: ports.get(&pid_u).cloned().unwrap_or_default(),
            project_dir,
            project_dir_note,
            parent_pid: parent,
            parent_name,
            cmdline,
            exe_path: exe.map(|p| p.display().to_string()),
            cwd: cwd.map(|p| p.display().to_string()),
        });
    }
    out.sort_by_key(|p| p.pid);
    out
}

pub fn search_by_name(query: &str) -> Vec<ProcessInfo> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return list_processes();
    }
    // Match process *name* only (case-insensitive). Do not search cmdline/exe —
    // otherwise `procman find --name foo` matches itself via argv.
    list_processes()
        .into_iter()
        .filter(|p| p.name.to_lowercase().contains(&q))
        .collect()
}

fn current_pid() -> u32 {
    std::process::id()
}

pub fn search_by_port(port: u16) -> Vec<ProcessInfo> {
    list_processes()
        .into_iter()
        .filter(|p| p.ports.contains(&port))
        .collect()
}

pub fn related_processes(selected: &ProcessInfo, all: &[ProcessInfo]) -> Vec<RelatedProcess> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(selected.pid);

    let push = |out: &mut Vec<RelatedProcess>, seen: &mut HashSet<u32>, relation: &str, p: &ProcessInfo| {
        if seen.insert(p.pid) {
            out.push(RelatedProcess {
                relation: relation.into(),
                pid: p.pid,
                name: p.name.clone(),
                exe_path: p.exe_path.clone(),
                service: None,
            });
        }
    };

    if let Some(pp) = selected.parent_pid {
        if let Some(p) = all.iter().find(|x| x.pid == pp) {
            push(&mut out, &mut seen, "父进程", p);
        }
    }
    for p in all {
        if p.parent_pid == Some(selected.pid) {
            push(&mut out, &mut seen, "子进程", p);
        }
    }
    if let Some(ref path) = selected.exe_path {
        for p in all {
            if p.exe_path.as_ref() == Some(path) && p.pid != selected.pid {
                push(&mut out, &mut seen, "同路径", p);
            }
        }
    }
    if let Some(ref dir) = selected.project_dir {
        if selected.project_dir_note.is_none() {
            for p in all {
                if p.project_dir.as_ref() == Some(dir) && p.pid != selected.pid {
                    push(&mut out, &mut seen, "同项目", p);
                }
            }
        }
    }
    out
}

pub fn kill_process(pid: u32) -> Result<()> {
    if protected_pid(pid) {
        return Err(ProcError::Protected(pid));
    }
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let Some(proc_) = sys.process(Pid::from_u32(pid)) else {
        return Err(ProcError::NotFound(pid));
    };
    let name = proc_.name().to_string_lossy().into_owned();
    if protected_name(&name) {
        return Err(ProcError::Message(format!(
            "拒绝结束系统关键进程 {name} (PID {pid})"
        )));
    }
    if proc_.kill() {
        Ok(())
    } else {
        Err(ProcError::Permission(
            pid,
            "kill 返回失败（可能权限不足）".into(),
        ))
    }
}

pub fn kill_many(pids: &[u32]) -> Vec<KillResult> {
    let all = list_processes();
    let self_pid = current_pid();
    let name_of = |pid: u32| {
        all.iter()
            .find(|p| p.pid == pid)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "?".into())
    };
    pids.iter()
        .map(|&pid| {
            if pid == self_pid {
                return KillResult {
                    pid,
                    name: name_of(pid),
                    ok: false,
                    error: Some("拒绝结束正在运行的 procman 自身".into()),
                };
            }
            match kill_process(pid) {
                Ok(()) => KillResult {
                    pid,
                    name: name_of(pid),
                    ok: true,
                    error: None,
                },
                Err(e) => KillResult {
                    pid,
                    name: name_of(pid),
                    ok: false,
                    error: Some(e.to_string()),
                },
            }
        })
        .collect()
}

/// After kill, watch up to `secs` for same process name to reappear with new PIDs.
pub fn watch_respawn(names: &[String], killed_pids: &[u32], secs: u64) -> Vec<RespawnWatch> {
    let killed: HashSet<u32> = killed_pids.iter().copied().collect();
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut result: HashMap<String, Vec<u32>> = HashMap::new();
    for n in names {
        result.insert(n.clone(), Vec::new());
    }
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(400));
        let live = list_processes();
        for n in names {
            for p in &live {
                if p.name.eq_ignore_ascii_case(n) && !killed.contains(&p.pid) {
                    let entry = result.entry(n.clone()).or_default();
                    if !entry.contains(&p.pid) {
                        entry.push(p.pid);
                    }
                }
            }
        }
    }
    result
        .into_iter()
        .map(|(name, new_pids)| RespawnWatch {
            respawned: !new_pids.is_empty(),
            name,
            new_pids,
        })
        .collect()
}
