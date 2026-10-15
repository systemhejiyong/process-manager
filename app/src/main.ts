
import { invoke } from "@tauri-apps/api/core";

type ProcessInfo = {
  pid: number;
  name: string;
  ports: number[];
  project_dir: string | null;
  project_dir_note: string | null;
  parent_pid: number | null;
  parent_name: string | null;
  cmdline: string;
  exe_path: string | null;
  cwd: string | null;
};

type RelatedProcess = {
  relation: string;
  pid: number;
  name: string;
  exe_path: string | null;
  service: string | null;
};

type KillResult = { pid: number; name: string; ok: boolean; error: string | null };
type RespawnWatch = { name: string; respawned: boolean; new_pids: number[] };
type Meta = { elevated: boolean; elevate_label: string; version: string };

let mode: "name" | "port" = "name";
let rows: ProcessInfo[] = [];
let selected: ProcessInfo | null = null;
let related: RelatedProcess[] = [];
let relatedChecked = new Set<number>();
let pendingKill: number[] = [];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function log(msg: string, cls: "info" | "ok" | "warn" | "err" = "info") {
  const el = $("log");
  const t = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `[${t}] ${msg}`;
  el.prepend(line);
}

function portsHtml(ports: number[]) {
  if (!ports.length) return `<span class="muted">—</span>`;
  return ports.map((p) => `<span class="pill">${p}</span>`).join("");
}

function render() {
  const tbody = $("tbody");
  tbody.innerHTML = "";
  $("count").textContent = `${rows.length} 条结果`;
  $("empty").classList.toggle("hidden", rows.length > 0);
  for (const p of rows) {
    const tr = document.createElement("tr");
    if (selected?.pid === p.pid) tr.classList.add("sel");
    const parent =
      p.parent_name && p.parent_pid
        ? `${p.parent_name} (${p.parent_pid})`
        : p.parent_pid
          ? String(p.parent_pid)
          : "—";
    tr.innerHTML = `
      <td class="mono">${p.pid}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${portsHtml(p.ports)}</td>
      <td class="mono" title="${escapeHtml(p.project_dir ?? "")}">${escapeHtml(p.project_dir ?? "—")}</td>
      <td>${escapeHtml(parent)}</td>
      <td class="mono" title="${escapeHtml(p.cmdline)}">${escapeHtml(p.cmdline)}</td>
      <td class="mono" title="${escapeHtml(p.exe_path ?? "")}">${escapeHtml(p.exe_path ?? "—")}</td>
      <td><button class="btn link" data-kill="${p.pid}">关闭</button></td>`;
    tr.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      void selectRow(p);
    });
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-kill]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pid = Number((btn as HTMLElement).dataset.kill);
      openKill([pid]);
    });
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function selectRow(p: ProcessInfo) {
  selected = p;
  render();
  related = await invoke<RelatedProcess[]>("get_related", { pid: p.pid });
  relatedChecked = new Set(related.map((r) => r.pid));
  renderRelated();
}

function renderRelated() {
  const panel = $("related-panel");
  panel.classList.toggle("hidden", !selected);
  const body = $("related-body");
  body.innerHTML = "";
  for (const r of related) {
    const tr = document.createElement("tr");
    const checked = relatedChecked.has(r.pid) ? "checked" : "";
    tr.innerHTML = `
      <td><input type="checkbox" data-pid="${r.pid}" ${checked} /></td>
      <td>${escapeHtml(r.relation)}</td>
      <td class="mono">${r.pid}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="mono">${escapeHtml(r.exe_path ?? "—")}</td>`;
    body.appendChild(tr);
  }
  body.querySelectorAll("input[type=checkbox]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const pid = Number((inp as HTMLInputElement).dataset.pid);
      if ((inp as HTMLInputElement).checked) relatedChecked.add(pid);
      else relatedChecked.delete(pid);
      $("related-summary").textContent = `已勾选 ${relatedChecked.size} / ${related.length}`;
    });
  });
  $("related-summary").textContent = `已勾选 ${relatedChecked.size} / ${related.length}`;
}

async function doSearch() {
  const q = ($("query") as HTMLInputElement).value.trim();
  $("status").textContent = "查询中…";
  try {
    if (mode === "port") {
      const port = Number(q);
      if (!Number.isFinite(port) || port <= 0) {
        log("请输入有效端口号", "err");
        return;
      }
      rows = await invoke<ProcessInfo[]>("find_by_port", { port });
      log(`按端口 ${port} 查询，${rows.length} 条`, "info");
    } else {
      rows = await invoke<ProcessInfo[]>("find_by_name", { query: q });
      log(`按进程名「${q || "*"}」查询，${rows.length} 条`, "info");
    }
    selected = null;
    related = [];
    render();
    renderRelated();
  } catch (e) {
    log(String(e), "err");
  } finally {
    $("status").textContent = "就绪";
  }
}

async function doRefresh() {
  $("status").textContent = "刷新中…";
  try {
    rows = await invoke<ProcessInfo[]>("list_all");
    log(`刷新列表，${rows.length} 条`, "info");
    selected = null;
    related = [];
    render();
    renderRelated();
  } catch (e) {
    log(String(e), "err");
  } finally {
    $("status").textContent = "就绪";
  }
}

function openKill(pids: number[]) {
  pendingKill = [...new Set(pids)];
  $("modal-msg").textContent = `将结束 ${pendingKill.length} 个进程（${pendingKill.join(", ")}）。此操作不可撤销。`;
  $("modal").classList.remove("hidden");
}

async function confirmKill() {
  $("modal").classList.add("hidden");
  $("status").textContent = "关闭中…";
  try {
    const [results, watch] = await invoke<[KillResult[], RespawnWatch[]]>("kill_pids", {
      pids: pendingKill,
      watchSecs: 4,
    });
    for (const r of results) {
      if (r.ok) log(`已结束 ${r.pid} (${r.name})`, "ok");
      else log(`失败 ${r.pid} (${r.name}): ${r.error ?? ""}`, "err");
    }
    for (const w of watch) {
      if (w.respawned) log(`「${w.name}」被重新拉起: ${w.new_pids.join(",")}`, "warn");
      else log(`「${w.name}」4 秒内未重新拉起`, "ok");
    }
    await doRefresh();
  } catch (e) {
    log(String(e), "err");
  } finally {
    $("status").textContent = "就绪";
  }
}

function collectKillTargets(): number[] {
  const pids: number[] = [];
  if (selected) {
    pids.push(selected.pid);
    if (($("chk-same-name") as HTMLInputElement).checked) {
      for (const p of rows) {
        if (p.name.toLowerCase() === selected.name.toLowerCase()) pids.push(p.pid);
      }
    }
    for (const id of relatedChecked) pids.push(id);
  } else if (($("chk-same-name") as HTMLInputElement).checked && rows.length) {
    for (const p of rows) pids.push(p.pid);
  }
  return [...new Set(pids)];
}

async function init() {
  $("mode-seg").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-mode]") as HTMLButtonElement | null;
    if (!btn) return;
    mode = btn.dataset.mode as "name" | "port";
    $("mode-seg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    $("query-label").textContent = mode === "port" ? "端口" : "关键词";
    ($("query") as HTMLInputElement).placeholder = mode === "port" ? "例如 5173" : "例如 node";
  });
  $("btn-search").addEventListener("click", () => void doSearch());
  $("btn-refresh").addEventListener("click", () => void doRefresh());
  $("btn-kill").addEventListener("click", () => {
    const pids = collectKillTargets();
    if (!pids.length) {
      log("请先选中进程或勾选同名匹配", "warn");
      return;
    }
    openKill(pids);
  });
  $("btn-elevate").addEventListener("click", () => {
    log("提权重启：请用系统方式以管理员/root 重新打开本应用（v1 占位）", "warn");
  });
  $("modal-cancel").addEventListener("click", () => $("modal").classList.add("hidden"));
  $("modal-ok").addEventListener("click", () => void confirmKill());
  $("query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSearch();
  });

  try {
    const meta = await invoke<Meta>("get_meta");
    $("btn-elevate").textContent = meta.elevate_label;
    $("ver").textContent = `v${meta.version}`;
    const chip = $("perm-chip");
    chip.textContent = meta.elevated ? "已提权" : "标准用户";
    chip.classList.toggle("admin", meta.elevated);
  } catch {
    /* browser preview without tauri */
  }
  await doRefresh();
}

void init();
