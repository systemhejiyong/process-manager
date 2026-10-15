use clap::{Parser, Subcommand};
use procman_core::{
    kill_many, list_processes, related_processes, search_by_name, search_by_port, watch_respawn,
    ProcessInfo,
};
use std::io::{self, Write};
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "procman", version, about = "进程查找关闭工具 — Linux CLI")]
struct Cli {
    #[command(subcommand)]
    cmd: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 按进程名或端口查找
    Find {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        json: bool,
    },
    /// 列出进程（可过滤）
    List {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        json: bool,
    },
    /// 列出相关进程
    Related {
        pid: u32,
        #[arg(long)]
        json: bool,
    },
    /// 结束进程
    Kill {
        pids: Vec<u32>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        with_related: bool,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        no_watch: bool,
        #[arg(long, default_value_t = 4)]
        watch: u64,
    },
}

fn print_table(rows: &[ProcessInfo]) {
    println!(
        "{:<8} {:<16} {:<14} {:<28} {:<18} {}",
        "PID", "NAME", "PORTS", "PROJECT", "PARENT", "CMDLINE"
    );
    for p in rows {
        let ports = if p.ports.is_empty() {
            "—".into()
        } else {
            p.ports.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
        };
        let project = p.project_dir.as_deref().unwrap_or("—");
        let parent = match (p.parent_name.as_ref(), p.parent_pid) {
            (Some(n), Some(id)) => format!("{n} ({id})"),
            (_, Some(id)) => id.to_string(),
            _ => "—".into(),
        };
        let cmd = truncate(&p.cmdline, 50);
        println!(
            "{:<8} {:<16} {:<14} {:<28} {:<18} {}",
            p.pid,
            truncate(&p.name, 16),
            ports,
            truncate(project, 28),
            truncate(&parent, 18),
            cmd
        );
    }
    eprintln!("共 {} 条", rows.len());
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{t}…")
    }
}

fn confirm(msg: &str) -> bool {
    eprint!("{msg} [y/N] ");
    let _ = io::stderr().flush();
    let mut buf = String::new();
    if io::stdin().read_line(&mut buf).is_err() {
        return false;
    }
    matches!(buf.trim(), "y" | "Y" | "yes" | "YES")
}

fn emit(rows: &[ProcessInfo], json: bool) {
    if json {
        println!("{}", serde_json::to_string_pretty(rows).unwrap());
    } else {
        print_table(rows);
    }
}

fn filtered(name: Option<&str>, port: Option<u16>) -> Vec<ProcessInfo> {
    match (name, port) {
        (Some(n), Some(p)) => search_by_name(n)
            .into_iter()
            .filter(|x| x.ports.contains(&p))
            .collect(),
        (Some(n), None) => search_by_name(n),
        (None, Some(p)) => search_by_port(p),
        (None, None) => list_processes(),
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Commands::Find { name, port, json } => {
            if name.is_none() && port.is_none() {
                eprintln!("请指定 --name 或 --port");
                return ExitCode::from(1);
            }
            let rows = filtered(name.as_deref(), port);
            if rows.is_empty() {
                eprintln!("无匹配");
                return ExitCode::from(2);
            }
            emit(&rows, json);
        }
        Commands::List { name, port, json } => {
            let rows = filtered(name.as_deref(), port);
            if rows.is_empty() {
                eprintln!("无匹配");
                return ExitCode::from(2);
            }
            emit(&rows, json);
        }
        Commands::Related { pid, json } => {
            let all = list_processes();
            let Some(sel) = all.iter().find(|p| p.pid == pid) else {
                eprintln!("进程不存在: {pid}");
                return ExitCode::from(2);
            };
            let rel = related_processes(sel, &all);
            if json {
                println!("{}", serde_json::to_string_pretty(&rel).unwrap());
            } else {
                println!("{:<10} {:<8} {:<16} {}", "RELATION", "PID", "NAME", "PATH");
                for r in &rel {
                    println!(
                        "{:<10} {:<8} {:<16} {}",
                        r.relation,
                        r.pid,
                        r.name,
                        r.exe_path.as_deref().unwrap_or("—")
                    );
                }
                eprintln!("共 {} 条", rel.len());
            }
        }
        Commands::Kill {
            mut pids,
            name,
            with_related,
            force: _force,
            yes,
            no_watch,
            watch,
        } => {
            let all = list_processes();
            if let Some(ref n) = name {
                let matched = search_by_name(n);
                if matched.is_empty() {
                    eprintln!("无匹配");
                    return ExitCode::from(2);
                }
                pids = matched.iter().map(|p| p.pid).collect();
            }
            if pids.is_empty() {
                eprintln!("请提供 PID 或 --name");
                return ExitCode::from(1);
            }
            if with_related {
                let mut extra = Vec::new();
                for pid in &pids.clone() {
                    if let Some(sel) = all.iter().find(|p| p.pid == *pid) {
                        for r in related_processes(sel, &all) {
                            extra.push(r.pid);
                        }
                    }
                }
                pids.extend(extra);
                pids.sort_unstable();
                pids.dedup();
            }
            if !yes {
                if !confirm(&format!("将结束 {} 个进程 {:?}, 确认?", pids.len(), pids)) {
                    eprintln!("已取消");
                    return ExitCode::from(1);
                }
            }
            let names: Vec<String> = pids
                .iter()
                .filter_map(|pid| all.iter().find(|p| p.pid == *pid).map(|p| p.name.clone()))
                .collect();
            let results = kill_many(&pids);
            let mut perm = false;
            let mut partial = false;
            let mut any_ok = false;
            for r in &results {
                if r.ok {
                    any_ok = true;
                    println!("已结束 {} ({})", r.pid, r.name);
                } else {
                    let err = r.error.clone().unwrap_or_default();
                    eprintln!("失败 {} ({}): {}", r.pid, r.name, err);
                    if err.contains("权限") {
                        perm = true;
                    }
                    partial = true;
                }
            }
            let watch_secs = if no_watch { 0 } else { watch };
            if watch_secs > 0 && any_ok {
                let w = watch_respawn(&names, &pids, watch_secs);
                for item in w {
                    if item.respawned {
                        println!(
                            "警告: 「{}」在 {} 秒内被重新拉起，新 PID: {:?}",
                            item.name, watch_secs, item.new_pids
                        );
                    } else {
                        println!("「{}」在 {} 秒内未重新拉起", item.name, watch_secs);
                    }
                }
            }
            if perm && !any_ok {
                return ExitCode::from(3);
            }
            if partial {
                return ExitCode::from(4);
            }
        }
    }
    ExitCode::SUCCESS
}
