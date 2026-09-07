/* zcode-branch-tree 主进程 loader（inject-branchtree.cjs）· 任务树版。
 * 由 patch_install.py 在 app.asar 入口尾部追加一行 dynamic import 引入。
 * 职责：
 *   1) 向每个窗口注入 overlay.js（🌳 悬浮按钮 + 任务树面板；mtime 热更新）。
 *   2) RPC：overlay 把请求放入 window.__btreeReqs，本 loader 每 400ms 收割执行，
 *      结果经 window.__btreeResult({id,ok,data|error}) 回推。
 *   3) 数据：常驻 python（taskq.py serve 行协议，只读 ~/.zcode/cli/db/db.sqlite）；
 *      意外退出自动重启，30s 内 3 次判不稳定回退一次性 dump；mtime 变化自动重启。
 *   4) 每窗口活跃任务：监听客户端自带 IPC "zcode:sync-active-task-session"
 *      （与 zcode-token-usage-statusbar 同款通道，追加监听不影响原有处理），
 *      维护 webContents.id → 会话 id 映射；tree 应答按窗口注入 mine，另附全局
 *      windows 映射（任务在哪些窗口打开）。
 *   5) db 变更：fs.watch db 目录（WAL 落盘即触发），去抖 800ms 广播 {type:"db"}，
 *      打开中的面板节流自动刷新——任务运行情况实时可见。
 * 切换（focus 操作）：目标任务已在某窗口打开 → 该窗口 BrowserWindow.focus()。
 * 不联网；不写任何文件（除数据目录 diag/无）。
 */
"use strict";
if (global.__BTREE_LOADED__) {
  module.exports = null;
} else {
global.__BTREE_LOADED__ = true;

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, webContents, ipcMain } = require("electron");

const HERE = __dirname;
const CONFIG = path.join(HERE, "config.json");
const OVERLAY = path.join(HERE, "overlay.js");
const TASKQ = path.join(HERE, "taskq.py");
const LOG = (...a) => console.error("[btree]", ...a);

/* ---------- 配置 ---------- */
const DEFAULT_CFG = { python_path: "python", max_sessions: 500 };
const MARKS = path.join(HERE, "marks.json");   // 用户手动标注（舍弃），仅存本数据目录

function readCfg() {
  const c = Object.assign({}, DEFAULT_CFG);
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { /* 保持默认 */ }
  if (!c.python_path) c.python_path = "python";
  c.max_sessions = Math.min(Math.max(parseInt(c.max_sessions, 10) || 500, 20), 3000);
  return c;
}
function readMarks() {
  try { return JSON.parse(fs.readFileSync(MARKS, "utf8")) || {}; } catch (e) { return {}; }
}
function writeMarks(m) {
  const tmp = MARKS + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), "utf8");
  fs.renameSync(tmp, MARKS);
}

/* ---------- 渲染端注入与回推 ---------- */
function isWindow(wc) {
  try { return wc.getType() === "window"; } catch (e) { return false; }
}
function allWins() {
  return webContents.getAllWebContents().filter((wc) => isWindow(wc) && !wc.isDestroyed());
}
function jsArg(obj) {
  return JSON.stringify(obj).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}
function pushResult(wc, msg) {
  wc.executeJavaScript(`window.__btreeResult && window.__btreeResult(${jsArg(msg)})`, true).catch(() => { });
}
function broadcast(ev) {
  for (const wc of allWins()) {
    wc.executeJavaScript(`window.__btreeEvent && window.__btreeEvent(${jsArg(ev)})`, true).catch(() => { });
  }
}

/* ---------- overlay 注入（含热更新） ---------- */
let overlaySrc = "";
let overlayMtime = 0;
try {
  overlaySrc = fs.readFileSync(OVERLAY, "utf8");
  overlayMtime = fs.statSync(OVERLAY).mtimeMs;
} catch (e) { LOG("overlay.js missing:", e.message); }

function injectOverlay(wc) {
  if (!overlaySrc) return;
  wc.executeJavaScript(overlaySrc, true).catch(() => { });
}
function hotReloadIfChanged() {
  let m = 0, src = "";
  try {
    m = fs.statSync(OVERLAY).mtimeMs;
    src = fs.readFileSync(OVERLAY, "utf8");
  } catch (e) { return; }
  if (m === overlayMtime) return;
  try { new Function(src); } catch (e) { LOG("overlay.js 语法未就绪，跳过:", e.message); return; }
  overlayMtime = m;
  overlaySrc = src;
  LOG("overlay.js 已变化，热重载");
  for (const wc of allWins()) {
    wc.executeJavaScript(
      '(function(){var b=document.getElementById("btree-btn");if(b)b.remove();var p=document.getElementById("btree-panel");if(p)p.remove();window.__btreeOverlay=false;})()', true
    ).catch(() => { });
    injectOverlay(wc);
  }
}
setInterval(hotReloadIfChanged, 2000);

const hookWc = (wc) => {
  if (!isWindow(wc)) return;
  wc.on("did-finish-load", () => injectOverlay(wc));
  if (wc.isLoading()) return;
  injectOverlay(wc);
};
app.on("web-contents-created", (e, wc) => hookWc(wc));
for (const wc of allWins()) hookWc(wc);

/* ---------- 每窗口活跃任务（客户端自带通道，追加监听） ---------- */
const IPC_ACTIVE_SID = "zcode:sync-active-task-session";
const activeSid = new Map();   // webContents.id → 会话 id 或 ""
try {
  ipcMain.on(IPC_ACTIVE_SID, (e, sid) => {
    if (!e || !e.sender || e.sender.isDestroyed()) return;
    const s = typeof sid === "string" ? sid.trim() : "";
    const val = s && s.length <= 128 && /^[A-Za-z0-9_-]+$/.test(s) ? s : "";
    const prev = activeSid.get(e.sender.id);
    activeSid.set(e.sender.id, val);
    if (prev !== val) broadcast({ type: "active" });   // 活跃任务变化，面板可即时更新标记
  });
} catch (e) { LOG("ipc hook failed:", e.message); }

/* ---------- 常驻查询进程（taskq.py serve，行协议） ---------- */
let pyRes = null;        // { proc, buf, waiters:[fn], born }
let pyFail = 0;
let pyBackoff = 1000;
let pyRestarting = false;

function startResident() {
  if (pyRes) return;
  const proc = spawn(readCfg().python_path, [TASKQ, "serve"], { windowsHide: true });
  const state = { proc, buf: "", waiters: [], born: Date.now() };
  pyRes = state;
  LOG("resident python starting");
  proc.stdout.on("data", (d) => {
    state.buf += d.toString("utf8");
    let i;
    while ((i = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, i);
      state.buf = state.buf.slice(i + 1);
      const w = state.waiters.shift();
      if (!w) continue;
      let payload = null;
      try { payload = JSON.parse(line); } catch (e) { /* 跳过坏行 */ }
      w(payload);
    }
  });
  proc.stderr.on("data", () => { });
  proc.on("close", () => {
    if (pyRes === state) pyRes = null;
    const pending = state.waiters;
    state.waiters = [];
    pending.forEach((w) => w(null));
    if (pyRestarting) { pyRestarting = false; startResident(); return; }
    if (Date.now() - state.born < 30000) {
      pyFail++;
      if (pyFail >= 3) { LOG("resident 不稳定（3 次早退），回退一次性查询"); return; }
      setTimeout(startResident, pyBackoff);
      pyBackoff = Math.min(pyBackoff * 2, 30000);
    } else {
      pyFail = 0; pyBackoff = 1000;
      startResident();
    }
  });
}
function killResidentForUpgrade() {
  if (!pyRes) return;
  pyRestarting = true;
  try { pyRes.proc.kill(); } catch (e) { /* 已退出 */ }
}
function oneShotQuery(cb) {
  let out = "";
  const py = spawn(readCfg().python_path, [TASKQ, "dump", String(readCfg().max_sessions)], { windowsHide: true });
  const killer = setTimeout(() => { try { py.kill(); } catch (e) { /* 已退出 */ } }, 15000);
  py.stdout.on("data", (d) => { out += d; });
  py.on("error", (e) => { clearTimeout(killer); cb(null, String(e && e.message || e)); });
  py.on("close", () => {
    clearTimeout(killer);
    try { cb(JSON.parse(out), null); } catch (e) { cb(null, "解析失败"); }
  });
}
function runQuery(cb) {
  if (pyFail < 3) {
    if (!pyRes) startResident();
    if (pyRes && pyRes.proc.stdin.writable) {
      const state = pyRes;
      const timer = setTimeout(() => {
        LOG("resident 查询超时，重启之");
        pyRestarting = true;
        try { state.proc.kill(); } catch (e) { /* 已退出 */ }
        cb(null, "timeout");
      }, 15000);
      state.waiters.push((payload) => { clearTimeout(timer); cb(payload, null); });
      try { state.proc.stdin.write(JSON.stringify({ op: "tree", max: readCfg().max_sessions }) + "\n"); } catch (e) { /* 下次心跳再试 */ }
      return;
    }
  }
  oneShotQuery(cb);
}

/* taskq.py 升级热生效：mtime 变化重启常驻进程 */
let taskqMtime = 0, taskqKnown = false;
setInterval(() => {
  hotReloadIfChanged();
  try {
    const m = fs.statSync(TASKQ).mtimeMs;
    if (taskqKnown && m !== taskqMtime && pyRes) {
      LOG("taskq.py 已变化，重启常驻查询");
      killResidentForUpgrade();
    }
    taskqMtime = m; taskqKnown = true;
  } catch (e) { /* 文件暂不可读 */ }
}, 2000);

/* ---------- db 监听：一有写入广播刷新 ---------- */
function dbDir() {
  return path.join(app.getPath("home"), ".zcode", "cli", "db");
}
function dbStamp() {
  let m = 0;
  const dir = dbDir();
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try { m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) { /* 忽略 */ }
  }
  return m;
}
let lastDbStamp = 0;
let dbDebounce = 0, dbWatcher = null;
function watchDb() {
  if (dbWatcher) return;
  try {
    dbWatcher = fs.watch(dbDir(), (ev, f) => {
      if (f && !/db\.sqlite/.test(f)) return;
      clearTimeout(dbDebounce);
      dbDebounce = setTimeout(() => {
        const st = dbStamp();
        if (st && st !== lastDbStamp) {
          lastDbStamp = st;
          broadcast({ type: "db" });
        }
      }, 800);
    });
    dbWatcher.on("error", () => {
      LOG("db watcher error, re-arm in 5s");
      try { dbWatcher.close(); } catch (e) { /* 已关 */ }
      dbWatcher = null;
      setTimeout(watchDb, 5000);
    });
    LOG("watching", dbDir());
  } catch (e) {
    setTimeout(watchDb, 5000);
  }
}
lastDbStamp = dbStamp();
watchDb();

/* ---------- RPC 操作 ---------- */
const POLL_EXPR =
  '(function(){var q=window.__btreeReqs;if(q&&q.length){return JSON.stringify(q.splice(0,q.length))}return ""})()';

const ops = {
  "ping": (arg, done) => done({ ok: true, data: { pong: true } }),

  "tree": (arg, done, wc) => {
    runQuery((payload, err) => {
      if (!payload) { done({ ok: false, error: err || "查询失败" }); return; }
      if (payload.ok === false) { done({ ok: false, error: payload.error || "查询失败" }); return; }
      const data = {
        projects: payload.projects || [],
        sessions: payload.sessions || [],
        truncated: !!payload.truncated,
        mine: (wc && !wc.isDestroyed() && activeSid.get(wc.id)) || "",
        windows: {},
        marks: readMarks().discarded || {},
      };
      for (const [wcId, sid] of Array.from(activeSid.entries())) {
        if (sid) (data.windows[sid] = data.windows[sid] || []).push(wcId);
      }
      done({ ok: true, data });
    });
  },

  "focus": (arg, done) => {
    const sid = arg && arg.sid;
    if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sid)) { done({ ok: false, error: "非法任务 id" }); return; }
    for (const wc of allWins()) {
      if (activeSid.get(wc.id) === sid) {
        try {
          const win = BrowserWindow.fromWebContents(wc);
          if (win) { win.show(); win.focus(); }
          done({ ok: true, data: { focused: true } });
        } catch (e) {
          done({ ok: false, error: String(e && e.message || e) });
        }
        return;
      }
    }
    done({ ok: true, data: { focused: false } });   // 没有窗口打开它：overlay 走 DOM/回退路径
  },

  /* 手动标注：舍弃 / 取消舍弃（marks.json，仅本数据目录） */
  "mark": (arg, done) => {
    const sid = arg && arg.sid;
    if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sid)) { done({ ok: false, error: "非法任务 id" }); return; }
    try {
      const m = readMarks();
      const disc = m.discarded || {};
      if (arg.on) disc[sid] = true;
      else delete disc[sid];
      m.discarded = disc;
      writeMarks(m);
      broadcast({ type: "marks" });
      done({ ok: true, data: { discarded: !!arg.on } });
    } catch (e) {
      done({ ok: false, error: String(e && e.message || e) });
    }
  },
};

setInterval(() => {
  for (const wc of allWins()) {
    let p;
    try { p = wc.executeJavaScript(POLL_EXPR, true); } catch (e) { continue; }
    p.then((s) => {
      if (!s) return;
      let reqs = null;
      try { reqs = JSON.parse(s); } catch (e) { return; }
      if (!Array.isArray(reqs)) return;
      for (const r of reqs) {
        if (!r || typeof r.id !== "string") continue;
        const op = ops[r.op];
        if (!op) { pushResult(wc, { id: r.id, ok: false, error: "未知操作: " + r.op }); continue; }
        try {
          op(r.arg, (msg) => {
            msg.id = r.id;
            if (!wc.isDestroyed()) pushResult(wc, msg);
          }, wc);
        } catch (e) {
          pushResult(wc, { id: r.id, ok: false, error: String(e && e.message || e) });
        }
      }
    }).catch(() => { });
  }
}, 400);

LOG("任务树 loader 已加载（常驻查询 + db 监听 + 每窗口活跃任务映射）");
}
