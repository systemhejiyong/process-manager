
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
let busy = false;
let relatedBusy = false;
let relatedError: string | null = null;
let relatedLoadToken = 0;
let relatedSlowTimer: number | null = null;
/** Resolves when the latest related load for selectRow finishes (ok or error). */
let relatedReady: Promise<void> = Promise.resolve();
let relatedReadyResolve: (() => void) | null = null;
let ctxTarget: ProcessInfo | null = null;
/** last successful query context; null = never searched / idle */
let lastQuery: { kind: "name" | "port" | "all"; value: string } | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function log(msg: string, cls: "info" | "ok" | "warn" | "err" = "info") {
  const el = $("log");
  const t = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setSearchButtonBusy(on: boolean) {
  const btn = $("btn-search") as HTMLButtonElement;
  const label = $("btn-search-label");
  if (on) {
    label.innerHTML = `<span class="spin-inline"></span>查找中`;
  } else {
    label.textContent = "查找";
  }
  btn.disabled = on;
}

function setBusy(on: boolean, label = "查询中…") {
  busy = on;
  $("loading").classList.toggle("hidden", !on);
  $("loading-text").textContent = label;
  $("status").textContent = on ? label : "就绪";
  $("results-hint").textContent = on
    ? "正在查询…"
    : "点击一行展开相关进程 · 右侧「关闭」结束单个进程";
  document.querySelector(".table-wrap")?.classList.toggle("dimmed", on);
  setSearchButtonBusy(on);
  for (const id of ["btn-refresh", "btn-kill", "query", "btn-elevate"]) {
    const el = $(id) as HTMLButtonElement | HTMLInputElement;
    el.disabled = on;
  }
  $("mode-seg").querySelectorAll("button").forEach((b) => {
    (b as HTMLButtonElement).disabled = on;
  });
}

function setEmptyCopy(idle: boolean) {
  if (idle) {
    $("empty-title").textContent = "先搜索，再看结果";
    $("empty-hint").innerHTML =
      "打开时不加载全部进程。输入进程名点「查找」，或切换到「按端口」查询占用。<br/>示例：node　python　端口 5173";
  } else {
    $("empty-title").textContent = "没有匹配的进程";
    $("empty-hint").textContent = "试试搜 node 或端口 5173";
  }
}

function portsHtml(ports: number[]) {
  if (!ports.length) return `<span class="muted">—</span>`;
  return ports.map((p) => `<span class="pill">${p}</span>`).join("");
}

function render() {
  const tbody = $("tbody");
  tbody.innerHTML = "";
  $("count").textContent = `${rows.length} 条结果`;
  const showEmpty = rows.length === 0 && !busy;
  $("empty").classList.toggle("hidden", !showEmpty);
  if (showEmpty) setEmptyCopy(lastQuery === null);
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
      hideContextMenu();
      void selectRow(p);
    });
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openContextMenu(p, e.clientX, e.clientY);
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

function clearRelatedSlowTimer() {
  if (relatedSlowTimer != null) {
    window.clearTimeout(relatedSlowTimer);
    relatedSlowTimer = null;
  }
}

async function selectRow(p: ProcessInfo) {
  selected = p;
  related = [];
  relatedChecked = new Set();
  relatedError = null;
  relatedBusy = true;
  const token = ++relatedLoadToken;
  clearRelatedSlowTimer();
  relatedReady = new Promise<void>((resolve) => {
    relatedReadyResolve = resolve;
  });
  render();
  renderRelated(); // show panel immediately with loading

  relatedSlowTimer = window.setTimeout(() => {
    if (relatedBusy && relatedLoadToken === token) {
      $("related-summary").textContent = "仍在加载…";
    }
  }, 3000);

  try {
    related = await invoke<RelatedProcess[]>("get_related", {
      pid: p.pid,
      process: p,
    });
    if (token !== relatedLoadToken) return;
    relatedChecked = new Set(related.map((r) => r.pid));
    relatedError = null;
  } catch (e) {
    if (token !== relatedLoadToken) return;
    related = [];
    relatedChecked = new Set();
    relatedError = String(e);
  } finally {
    if (token === relatedLoadToken) {
      relatedBusy = false;
      clearRelatedSlowTimer();
      renderRelated();
      relatedReadyResolve?.();
      relatedReadyResolve = null;
    }
  }
}

function renderRelated() {
  const panel = $("related-panel");
  panel.classList.toggle("hidden", !selected);
  if (!selected) return;

  const loadingEl = $("related-loading");
  const errEl = $("related-error");
  const tableWrap = $("related-table-wrap");
  const body = $("related-body");

  if (relatedBusy) {
    loadingEl.classList.remove("hidden");
    errEl.classList.add("hidden");
    tableWrap.classList.add("hidden");
    $("related-loading-text").textContent =
      `正在加载 PID ${selected.pid} 的相关进程（父进程 / 同路径 / 同项目目录）…`;
    $("related-summary").textContent = "加载中";
    body.innerHTML = "";
    return;
  }

  loadingEl.classList.add("hidden");

  if (relatedError) {
    errEl.classList.remove("hidden");
    errEl.textContent = relatedError;
    tableWrap.classList.add("hidden");
    $("related-summary").textContent = "加载失败";
    body.innerHTML = "";
    return;
  }

  errEl.classList.add("hidden");
  tableWrap.classList.remove("hidden");
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
  if (busy) return;
  const q = ($("query") as HTMLInputElement).value.trim();
  const label =
    mode === "port"
      ? `正在按端口查找「${q || "?"}」`
      : `正在按进程名查找「${q || "*"}」`;
  setBusy(true, label);
  $("empty").classList.add("hidden");
  try {
    if (mode === "port") {
      const port = Number(q);
      if (!Number.isFinite(port) || port <= 0) {
        log("请输入有效端口号", "err");
        return;
      }
      rows = await invoke<ProcessInfo[]>("find_by_port", { port });
      lastQuery = { kind: "port", value: String(port) };
      log(`按端口 ${port} 查询，${rows.length} 条`, "info");
    } else {
      rows = await invoke<ProcessInfo[]>("find_by_name", { query: q });
      lastQuery = { kind: "name", value: q };
      log(`按进程名「${q || "*"}」查询，${rows.length} 条`, "info");
    }
    selected = null;
    related = [];
    relatedBusy = false;
    relatedError = null;
    render();
    renderRelated();
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
    render();
  }
}

async function doRefresh() {
  if (busy) return;
  setBusy(true, "正在刷新全量进程列表…");
  $("empty").classList.add("hidden");
  try {
    rows = await invoke<ProcessInfo[]>("list_all");
    lastQuery = { kind: "all", value: "" };
    log(`刷新列表，${rows.length} 条`, "info");
    selected = null;
    related = [];
    relatedBusy = false;
    relatedError = null;
    render();
    renderRelated();
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
    render();
  }
}

/** After kill: redo last query, or just drop killed rows (no full list load). */
async function reloadAfterKill(killed: number[]) {
  if (lastQuery?.kind === "name") {
    ($("query") as HTMLInputElement).value = lastQuery.value;
    mode = "name";
    await doSearch();
  } else if (lastQuery?.kind === "port") {
    ($("query") as HTMLInputElement).value = lastQuery.value;
    mode = "port";
    await doSearch();
  } else if (lastQuery?.kind === "all") {
    await doRefresh();
  } else {
    const dead = new Set(killed);
    rows = rows.filter((p) => !dead.has(p.pid));
    selected = null;
    related = [];
    relatedBusy = false;
    relatedError = null;
    render();
    renderRelated();
  }
}


function hideContextMenu() {
  $("ctx-menu").classList.add("hidden");
  ctxTarget = null;
}

async function openContextMenu(p: ProcessInfo, x: number, y: number) {
  ctxTarget = p;
  void selectRow(p);
  const menu = $("ctx-menu");
  const portsBtn = menu.querySelector('[data-act="copy-ports"]') as HTMLButtonElement;
  const projBtn = menu.querySelector('[data-act="copy-project"]') as HTMLButtonElement;
  portsBtn.disabled = !p.ports.length;
  projBtn.disabled = !p.project_dir;
  menu.classList.remove("hidden");
  // measure then flip near edges
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - 8) left = Math.max(8, x - rect.width);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

async function handleContextAction(act: string) {
  const p = ctxTarget;
  hideContextMenu();
  if (!p) return;
  if (act === "kill-one") {
    openKill([p.pid]);
    return;
  }
  if (act === "kill-related") {
    // Wait for related load if still in progress for this selection
    if (selected?.pid === p.pid && relatedBusy) {
      await relatedReady;
    } else if (selected?.pid !== p.pid) {
      await selectRow(p);
    }
    const pids = [p.pid, ...relatedChecked];
    openKill(pids);
    return;
  }
  switch (act) {
    case "copy-name":
      await copyText(p.name);
      break;
    case "copy-pid":
      await copyText(String(p.pid));
      break;
    case "copy-path":
      await copyText(p.exe_path ?? "");
      break;
    case "copy-ports":
      await copyText(p.ports.length ? p.ports.join(",") : "—");
      break;
    case "copy-project":
      await copyText(p.project_dir ?? "");
      break;
    case "copy-cmdline":
      await copyText(p.cmdline);
      break;
  }
}

function nameForPid(pid: number): string {
  if (selected?.pid === pid) return selected.name;
  const fromRows = rows.find((r) => r.pid === pid);
  if (fromRows) return fromRows.name;
  const fromRel = related.find((r) => r.pid === pid);
  if (fromRel) return fromRel.name;
  return "?";
}

/** Confirm lists every PID+name; actual kill still goes through hard-block / per-pid rules. */
function openKill(pids: number[]) {
  pendingKill = [...new Set(pids)];
  const lines = pendingKill.map((pid) => `${pid} (${nameForPid(pid)})`);
  const list =
    lines.length <= 12
      ? lines.join("、")
      : `${lines.slice(0, 12).join("、")} …共 ${lines.length} 个`;
  $("modal-msg").textContent =
    `将结束以下 ${pendingKill.length} 个进程（仍受系统关键进程硬拦截与权限校验约束，不可撤销）：\n${list}`;
  // Use pre-wrap so enumeration is readable
  $("modal-msg").style.whiteSpace = "pre-wrap";
  $("modal").classList.remove("hidden");
}

async function confirmKill() {
  $("modal").classList.add("hidden");
  setBusy(true, "关闭中…");
  const killed = [...pendingKill];
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
    setBusy(false);
    await reloadAfterKill(killed);
  } catch (e) {
    log(String(e), "err");
    setBusy(false);
    render();
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
    if (!btn || busy) return;
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
  $("ctx-menu").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    void handleContextAction(btn.dataset.act!);
  });
  // Suppress WebView/browser default context menu globally (capture).
  // Row handlers still show #ctx-menu; non-row right-clicks show nothing.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  }, true);
  document.addEventListener("click", () => hideContextMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
  window.addEventListener("blur", () => hideContextMenu());
  document.addEventListener("scroll", () => hideContextMenu(), true);

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
  // Idle open: no list_all — wait for search or explicit refresh.
  lastQuery = null;
  rows = [];
  setEmptyCopy(true);
  render();
  log("已就绪：请输入关键词/端口查找，或点「刷新列表」看全量", "info");
}

void init();
