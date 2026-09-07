/* zcode-branch-tree overlay：🌳 悬浮按钮 + 任务树思维导图面板（ZCode 会话/任务版）。
 * 自包含 IIFE，由 inject-branchtree.cjs 经 executeJavaScript 注入每个窗口。
 * RPC：请求放入 window.__btreeReqs，结果经 window.__btreeResult({id,ok,data}) 回推；
 *      db / 活跃任务变化经 window.__btreeEvent({type:"db"|"active"}) 通知自动刷新。
 * 布局算法 paint() 为纯函数（git graph painter 思路，父引用驱动泳道分叉），
 * Node 环境可 require 做单元测试。
 * 切换策略（三层兜底）：① loader 聚焦已打开该任务的窗口 ② 点击客户端自身任务列表
 * 里的对应元素（data-task-item-key / data-testid*="task-item"）③ 展示
 * zcode --resume <id> 命令。
 */
(function (global) {
  "use strict";

  /* ---------- 纯函数：泳道布局（painter） ----------
   * items: 最新的在前 [{h, p:[父id...]}]（按 time_created 降序 ⇒ 父必在子后面）。
   * 分叉给父开新道/复用空道；汇合收敛。返回 {laneOf, nLanes}。 */
  function paint(items) {
    const laneOf = Object.create(null);
    const active = [];
    const free = [];
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const hits = [];
      for (let l = 0; l < active.length; l++) if (active[l] === c.h) hits.push(l);
      let lane;
      if (hits.length) {
        lane = hits[0];
        for (let k = 1; k < hits.length; k++) { active[hits[k]] = null; free.push(hits[k]); }
      } else {
        lane = free.length ? free.pop() : active.length;
        if (lane === active.length) active.push(null);
      }
      c.lane = lane; c.idx = i; laneOf[c.h] = lane;
      let first = true;
      for (let t = 0; t < c.p.length; t++) {
        const ph = c.p[t];
        if (first) { active[lane] = ph; first = false; }
        else {
          let exist = -1;
          for (let l = 0; l < active.length; l++) if (active[l] === ph) { exist = l; break; }
          if (exist < 0) {
            const nl = free.length ? free.pop() : active.length;
            if (nl === active.length) active.push(null);
            active[nl] = ph;
          }
        }
      }
      if (!c.p.length) { active[lane] = null; free.push(lane); }
    }
    return { laneOf, nLanes: Math.max(active.length, 1) };
  }

  if (typeof window === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = { paint };
    return;
  }
  if (window.__btreeOverlay) return;
  window.__btreeOverlay = true;

  var PAL = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d", "#475569"];
  var LANE = 26, ROW = 36, PAD_L = 26, PAD_T = 20;

  /* ---------- RPC ---------- */
  var pending = new Map(), seq = 1;
  function rpc(op, arg) {
    return new Promise(function (res) {
      var id = "q" + (seq++);
      pending.set(id, res);
      (window.__btreeReqs = window.__btreeReqs || []).push({ id: id, op: op, arg: arg });
    });
  }
  window.__btreeResult = function (m) {
    if (m && m.id) { var r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } }
  };

  /* ---------- 状态 ---------- */
  var state = { proj: null, data: null, sel: null, busy: false, lastLoad: 0, refreshTimer: 0 };

  /* ---------- 样式 ---------- */
  var STYLE_ID = "btree-style";
  if (!document.getElementById(STYLE_ID)) {
    var st = document.createElement("style"); st.id = STYLE_ID; st.textContent = [
      "#btree-btn{position:fixed;right:16px;bottom:96px;width:42px;height:42px;border-radius:50%;",
      "background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:19px;line-height:42px;text-align:center;",
      "cursor:pointer;user-select:none;box-shadow:0 6px 18px rgba(37,99,235,.38);opacity:.92;z-index:2147483000;",
      "transition:transform .15s,opacity .15s;font-family:system-ui,sans-serif}",
      "#btree-btn:hover{opacity:1;transform:translateY(-1px)}",
      "#btree-panel{position:fixed;right:16px;bottom:148px;width:min(920px,calc(100vw - 32px));",
      "height:min(600px,calc(100vh - 210px));display:none;flex-direction:column;",
      "background:rgba(255,255,255,.96);backdrop-filter:blur(14px) saturate(1.2);",
      "border:1px solid rgba(15,23,42,.09);border-radius:16px;box-shadow:0 16px 48px rgba(2,6,23,.24);",
      "z-index:2147483000;font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif;color:#111827;overflow:hidden}",
      "#btree-panel.open{display:flex}",
      "#btree-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(15,23,42,.07)}",
      "#btree-head .t{font-weight:700;font-size:14px}",
      "#btree-head select{max-width:320px;font-size:12px;padding:4px 6px;border:1px solid rgba(15,23,42,.15);",
      "border-radius:8px;background:#fff;color:#111827}",
      ".btree-ib{border:1px solid rgba(15,23,42,.15);background:#fff;border-radius:8px;font-size:12px;",
      "padding:4px 9px;cursor:pointer;color:#334155}",
      ".btree-ib:hover{background:#f1f5f9}",
      "#btree-stat{display:flex;align-items:center;gap:8px;padding:7px 14px;font-size:12px;color:#475569;",
      "border-bottom:1px solid rgba(15,23,42,.07);flex-wrap:wrap}",
      "#btree-stat .chip{padding:2px 9px;border-radius:99px;font-weight:600;font-size:11px}",
      "#btree-stat .cur{background:#dbeafe;color:#1d4ed8;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "#btree-stat .n{background:#f1f5f9;color:#475569}",
      "#btree-main{flex:1;display:flex;min-height:0}",
      "#btree-graph{flex:1;overflow:auto;position:relative}",
      "#btree-graph svg{display:block}",
      ".btree-row{cursor:pointer}",
      ".btree-row .hit{fill:transparent}",
      ".btree-row:hover .hit{fill:rgba(37,99,235,.06)}",
      "#btree-detail{display:none;width:310px;border-left:1px solid rgba(15,23,42,.07);overflow:auto;padding:12px;font-size:12px}",
      "#btree-detail.open{display:block}",
      "#btree-detail .dh{font-weight:700;margin-bottom:6px;line-height:1.5}",
      "#btree-detail .dmeta{color:#64748b;margin-bottom:8px}",
      "#btree-detail .dstats{background:#f8fafc;border-radius:10px;padding:8px 10px;margin:8px 0;line-height:1.8}",
      "#btree-detail .dact{margin:10px 0;display:flex;flex-direction:column;gap:6px}",
      "#btree-detail .dact button{font-size:12px;padding:7px 10px;border-radius:8px;border:1px solid rgba(15,23,42,.15);",
      "background:#fff;cursor:pointer;text-align:left}",
      "#btree-detail .dact button:hover{background:#f1f5f9}",
      "#btree-detail .dact button.main{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}",
      "#btree-detail .dact button.main:hover{background:#1d4ed8}",
      "#btree-detail .fallback{display:none;background:#fef9ec;border:1px solid #fde68a;border-radius:10px;padding:8px 10px;margin-top:8px}",
      "#btree-detail .fallback.show{display:block}",
      "#btree-detail .fallback input{width:100%;font-size:11px;padding:5px 7px;margin-top:6px;border:1px solid rgba(15,23,42,.15);",
      "border-radius:7px;font-family:Consolas,monospace;box-sizing:border-box;background:#fff}",
      "#btree-detail .plink{color:#2563eb;cursor:pointer;text-decoration:underline}",
      "#btree-empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;",
      "justify-content:center;color:#64748b;font-size:13px;padding:20px;text-align:center}",
      "#btree-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:#0f172a;color:#fff;",
      "font-size:12px;padding:7px 14px;border-radius:99px;opacity:0;transition:opacity .25s;pointer-events:none;max-width:80%;",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#btree-toast.show{opacity:.95}",
      "#btree-toast.err{background:#b91c1c}",
      "#btree-legend{position:absolute;left:10px;bottom:8px;font-size:10.5px;color:#64748b;",
      "background:rgba(255,255,255,.85);border-radius:8px;padding:3px 10px;pointer-events:none;",
      "box-shadow:0 1px 4px rgba(2,6,23,.08)}",
      "#btree-detail .dquote{background:#f8fafc;border-left:3px solid #93c5fd;border-radius:0 8px 8px 0;",
      "padding:7px 10px;margin:8px 0;color:#334155;line-height:1.6;max-height:120px;overflow:auto}",
      "#btree-detail .crumbs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:6px 0;",
      "font-size:11px;color:#64748b;line-height:1.7}",
      "#btree-detail .crumbs .step{color:#2563eb;cursor:pointer;max-width:150px;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap}",
      "#btree-detail .crumbs .arrow{color:#cbd5e1}",
      "#btree-detail .kids{margin:6px 0;line-height:2}",
      "#btree-detail .kids .kid{display:inline-block;background:#f1f5f9;border-radius:99px;padding:2px 10px;",
      "margin:2px 4px 2px 0;font-size:11px;color:#334155;cursor:pointer;max-width:200px;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap}",
      "#btree-detail .kids .kid:hover{background:#e2e8f0}",
    ].join("");
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- 骨架 ---------- */
  var btn = document.createElement("div");
  btn.id = "btree-btn"; btn.title = "任务树"; btn.textContent = "🌳";
  var panel = document.createElement("div");
  panel.id = "btree-panel";
  panel.innerHTML = [
    '<div id="btree-head">',
    '  <span class="t">🌳 任务树</span>',
    '  <select id="btree-projs"></select>',
    '  <button class="btree-ib" id="btree-refresh" title="刷新">⟳</button>',
    '  <button class="btree-ib" id="btree-close" title="关闭">✕</button>',
    "</div>",
    '<div id="btree-stat"></div>',
    '<div id="btree-main">',
    '  <div id="btree-graph"><div id="btree-empty" style="display:none"></div>',
    '    <div id="btree-legend">▶ 运行中　◐ 未读　● 开着　✗ 舍弃　无标记 = 已读　亮色 = 当前任务谱系</div>',
    "  </div>",
    '  <aside id="btree-detail"></aside>',
    "</div>",
    '<div id="btree-toast"></div>',
  ].join("");
  (document.body || document.documentElement).appendChild(btn);
  (document.body || document.documentElement).appendChild(panel);

  var $ = function (id) { return document.getElementById(id); };
  var elGraph = $("btree-graph"), elEmpty = $("btree-empty"), elDetail = $("btree-detail"),
    elStat = $("btree-stat"), elSel = $("btree-projs"), elToast = $("btree-toast");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function toast(msg, isErr) {
    elToast.textContent = msg;
    elToast.className = "show" + (isErr ? " err" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { elToast.className = ""; }, 2600);
  }
  function store(k, v) {
    try { if (arguments.length === 2) localStorage.setItem(k, v); else return localStorage.getItem(k); } catch (e) { return null; }
  }
  function fmtRel(ms) {
    if (!ms) return "";
    var d = Date.now() - Number(ms);
    if (d < 0) d = 0;
    var m = Math.floor(d / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟前";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " 小时前";
    var day = Math.floor(h / 24);
    if (day < 30) return day + " 天前";
    return Math.floor(day / 30) + " 个月前";
  }
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }
  function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); toast("已复制"); return; }
    } catch (e) { /* 降级 */ }
    var ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败", true); }
    ta.remove();
  }

  /* ---------- 面板开合 ---------- */
  function openPanel() {
    panel.classList.add("open");
    loadTree();
  }
  function closePanel() { panel.classList.remove("open"); }
  btn.addEventListener("click", function () { panel.classList.contains("open") ? closePanel() : openPanel(); });
  $("btree-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("open")) closePanel();
  });
  $("btree-refresh").addEventListener("click", function () { loadTree(true); });

  /* ---------- 数据加载与渲染 ---------- */
  function loadTree(manual) {
    if (state.busy) return;
    state.busy = true;
    if (manual || !state.data) showBusy("加载中…");
    rpc("tree", {}).then(function (m) {
      state.busy = false;
      if (!m.ok) { showEmpty("读取失败：" + esc(m.error || "")); return; }
      state.lastLoad = Date.now();
      state.data = m.data;
      render();
    });
  }
  function showEmpty(msg) {
    var s = elGraph.querySelector("svg"); if (s) s.remove();
    elEmpty.style.display = "flex";
    elEmpty.innerHTML = msg;
  }
  function showBusy(msg) {
    elEmpty.style.display = "flex";
    elEmpty.innerHTML = msg;
  }

  function render() {
    var d = state.data;
    elEmpty.style.display = "none";
    /* 项目选择器 */
    var keep = state.proj;
    elSel.innerHTML = "";
    (d.projects || []).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.proj;
      o.textContent = p.name + "（" + p.n + "）";
      elSel.appendChild(o);
    });
    if (!d.projects.length) { showEmpty("没有找到任何任务（~/.zcode/cli/db/db.sqlite）"); return; }
    var has = d.projects.some(function (p) { return p.proj === keep; });
    elSel.value = has ? keep : (store("btree.lastProj") && d.projects.some(function (p) { return p.proj === store("btree.lastProj"); }) ? store("btree.lastProj") : d.projects[0].proj);
    state.proj = elSel.value;
    store("btree.lastProj", state.proj);
    renderProj();
  }

  elSel.addEventListener("change", function () {
    state.proj = elSel.value; state.sel = null; hideDetail();
    store("btree.lastProj", state.proj);
    renderProj();
  });

  function renderProj() {
    var d = state.data;
    var proj = d.projects.filter(function (p) { return p.proj === state.proj; })[0];
    var all = d.sessions || [];
    var sessions = all.filter(function (s) { return s.proj === state.proj; });
    /* 状态行 */
    var chips = [];
    chips.push('<span class="chip cur" title="' + esc(proj.dir) + '">' + esc(proj.dir) + "</span>");
    chips.push('<span class="chip n">' + sessions.length + " 个任务</span>");
    var forkN = sessions.filter(function (s) { return s.tt === "fork"; }).length;
    if (forkN) chips.push('<span class="chip n">' + forkN + " 个分叉</span>");
    if (d.truncated) chips.push('<span class="chip n">仅最近 ' + all.length + " 个任务</span>");
    var mine = sessions.filter(function (s) { return s.id === d.mine; })[0];
    if (mine) chips.push('<span class="chip cur">本窗口：' + esc((mine.title || "").slice(0, 24)) + "</span>");
    elStat.innerHTML = chips.join("");
    if (!sessions.length) { showEmpty("该项目暂无任务"); return; }

    /* 画布数据：painter 输入 */
    var items = sessions.map(function (s) {
      return { h: s.id, p: s.pid ? [s.pid] : [], s: s };
    });
    var r = paint(items);
    var byId = Object.create(null);
    items.forEach(function (it) { byId[it.h] = it; });

    /* 子女表（session 单父：p[0]） */
    var kids = Object.create(null);
    items.forEach(function (it) {
      if (it.p.length) (kids[it.p[0]] = kids[it.p[0]] || []).push(it.h);
    });
    /* 谱系：当前打开任务（或选中任务）→ 祖先链到最初任务 + 全部后代分叉 */
    var focusId = (d.mine && byId[d.mine]) ? d.mine : ((state.sel && byId[state.sel]) ? state.sel : null);
    var lin = null;
    if (focusId) {
      var anc = [], cur = byId[focusId], seen = Object.create(null);
      while (cur && !seen[cur.h]) {
        seen[cur.h] = 1;
        anc.push(cur);
        if (!cur.p.length || !byId[cur.p[0]]) break;
        cur = byId[cur.p[0]];
      }
      var rel = Object.create(null);
      anc.forEach(function (it) { rel[it.h] = 1; });
      var q = [focusId];
      while (q.length) {
        var h = q.shift();
        (kids[h] || []).forEach(function (k) { if (!rel[k]) { rel[k] = 1; q.push(k); } });
      }
      lin = { anc: anc, rel: rel, rootId: anc.length ? anc[anc.length - 1].h : focusId };
    }
    function isRel(h) { return !lin || !!lin.rel[h]; }

    var NS = "http://www.w3.org/2000/svg";
    function sv(tag, attrs, text) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    }
    function X(lane) { return PAD_L + lane * LANE; }
    function Y(i) { return PAD_T + i * ROW; }
    function rowW(it) {
      var w = X(it.lane) + 14 + (it.s.tt === "fork" ? 52 : 0) + (d.windows[it.h] ? 20 : 0);
      if (it.s.unread || it.s.st === "running") w += 62;
      if (d.marks && d.marks[it.h]) w += 56;
      if (it.s.pin) w += 30;
      if (lin && it.h === lin.rootId) w += 48;
      w += Math.min((it.s.title || "").length, 46) * 7.2 + 60; /* 标题 + 相对时间 */
      return w;
    }
    var maxW = 620;
    items.forEach(function (it) { maxW = Math.max(maxW, rowW(it)); });
    var svgW = Math.min(maxW + 24, 4200), svgH = PAD_T * 2 + items.length * ROW;
    var svg = sv("svg", { width: svgW, height: svgH, viewBox: "0 0 " + svgW + " " + svgH });
    svg.style.background = "#fff";

    /* 边 */
    items.forEach(function (it) {
      var x1 = X(it.lane), y1 = Y(it.idx);
      it.p.forEach(function (ph) {
        var t = byId[ph];
        var dim = (!isRel(it.h) || (t && !isRel(ph))) ? 0.2 : 1;
        if (t) {
          var x2 = X(t.lane), y2 = Y(t.idx);
          var col = PAL[t.lane % PAL.length];
          if (x1 === x2) {
            svg.appendChild(sv("path", { d: "M" + x1 + "," + (y1 + 7) + " L" + x2 + "," + (y2 - 7), stroke: col, "stroke-width": 2, fill: "none", opacity: dim }));
          } else {
            var my = (y1 + y2) / 2;
            svg.appendChild(sv("path", {
              d: "M" + x1 + "," + (y1 + 7) + " C" + x1 + "," + my + " " + x2 + "," + my + " " + x2 + "," + (y2 - 7),
              stroke: col, "stroke-width": 2, fill: "none", opacity: .9 * dim
            }));
          }
        } else {
          svg.appendChild(sv("path", { d: "M" + x1 + "," + (y1 + 7) + " L" + x1 + "," + (svgH - 8), stroke: "#cbd5e1", "stroke-width": 2, "stroke-dasharray": "3 3", fill: "none", opacity: dim }));
        }
      });
    });

    /* 行 */
    items.forEach(function (it) {
      var s = it.s, y = Y(it.idx), x = X(it.lane);
      var col = PAL[it.lane % PAL.length];
      var g = sv("g", { "class": "btree-row" });
      var isDisc = !!(d.marks && d.marks[s.id]);
      var dimRow = (!isRel(s.id) ? 0.3 : 1) * (isDisc ? 0.45 : 1);
      if (dimRow < 1) g.setAttribute("opacity", dimRow);
      g.appendChild(sv("rect", { "class": "hit", x: 0, y: y - ROW / 2 + 3, width: svgW, height: ROW - 6 }));
      if (state.sel === s.id) {
        g.appendChild(sv("rect", { x: 2, y: y - ROW / 2 + 3, width: svgW - 4, height: ROW - 6, rx: 8, fill: "rgba(37,99,235,.10)" }));
      }
      var isOpen = !!(d.windows && d.windows[s.id]);
      var isMine = s.id === d.mine;
      var isFocus = s.id === focusId;
      /* 节点 */
      g.appendChild(sv("circle", { cx: x, cy: y, r: 5.5, fill: (isOpen || s.st === "running") ? col : "#fff", stroke: col, "stroke-width": 2.5 }));
      if (isFocus || isMine) g.appendChild(sv("circle", { cx: x, cy: y, r: 9, fill: "none", stroke: col, "stroke-width": 1.2, "stroke-dasharray": "2 2", opacity: .8 }));
      var cx = x + 14;
      function chip(text, fill, color, w) {
        g.appendChild(sv("rect", { x: cx, y: y - 8, width: w, height: 16, rx: 8, fill: fill }));
        g.appendChild(sv("text", { x: cx + 7, y: y + 3.5, "font-size": 10.5, "font-weight": 700, fill: color }, text));
        cx += w + 4;
      }
      if (lin && s.id === lin.rootId) chip("最初", "#0f172a", "#fff", 40);
      if (s.st === "running") chip("▶ 运行中", "#dcfce7", "#15803d", 62);
      if (s.unread) chip("◐ 未读", "#ffedd5", "#c2410c", 50);
      if (isOpen) chip("● 开着", "#dbeafe", "#1d4ed8", 52);
      if (s.pin) chip("📌", "#fef9c3", "#a16207", 24);
      if (isDisc) chip("✗ 舍弃", "#e2e8f0", "#64748b", 52);
      var title = s.title || "";
      if (title.length > 46) title = title.slice(0, 46) + "…";
      var label = sv("text", { x: cx + 2, y: y + 3.5, "font-size": 11.5, fill: "#1e293b", "font-weight": isMine ? 700 : 400 }, title);
      if (isDisc) label.setAttribute("text-decoration", "line-through");
      g.appendChild(label);
      g.appendChild(sv("text", { x: cx + 8 + Math.min(title.length, 46) * 7.2, y: y + 3.5, "font-size": 10, fill: "#94a3b8" }, fmtRel(s.tu)));
      /* 悬停摘要（简单摘要）：标题 + 状态 + 任务第一句 */
      var statusTxt = s.st === "running" ? "运行中" : (s.unread ? "未读" : "已读");
      if (isDisc) statusTxt += " · 已标注舍弃";
      g.appendChild(sv("title", null, (s.title || "") + "\n[" + (s.tt === "fork" ? "分叉" : "主线") + " · " + statusTxt + "]\n摘要：" + (s.first || "（未提取到首句）")));
      g.addEventListener("click", function () { select(s.id); });
      svg.appendChild(g);
    });

    var old = elGraph.querySelector("svg");
    if (old) old.remove();
    elGraph.insertBefore(svg, elGraph.firstChild);
    if (state.sel && !byId[state.sel]) { state.sel = null; hideDetail(); }
  }

  function hideDetail() { elDetail.classList.remove("open"); elDetail.innerHTML = ""; }

  /* ---------- 选中与详情 ---------- */
  function select(id) {
    state.sel = id;
    renderProj();
    var items = (state.data.sessions || []).filter(function (s) { return s.id === id; });
    if (items.length) {
      /* 滚动到选中行 */
      var svg = elGraph.querySelector("svg");
      if (svg) {
        var rows = (state.data.sessions || []).filter(function (s) { return s.proj === state.proj; });
        for (var i = 0; i < rows.length; i++) if (rows[i].id === id) break;
        var yy = PAD_T + i * ROW;
        if (yy < elGraph.scrollTop + 40 || yy > elGraph.scrollTop + elGraph.clientHeight - 60) {
          elGraph.scrollTop = yy - elGraph.clientHeight / 2;
        }
      }
      showDetail(items[0]);
    }
  }

  /* 在客户端自身的任务列表 DOM 里找对应元素并点击（切换走应用自己的逻辑） */
  function tryDomClick(sid) {
    try {
      var els = document.querySelectorAll('[data-task-item-key],[data-testid^="task-item"]');
      var prefix = sid.length > 16 ? sid.slice(0, 16) : sid;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var attr = (el.getAttribute("data-task-item-key") || "") + " " + (el.getAttribute("data-testid") || "");
        if (attr.indexOf(sid) >= 0 || attr.indexOf(prefix) >= 0) {
          el.click();
          return true;
        }
      }
    } catch (e) { /* DOM 结构变化则走回退 */ }
    return false;
  }

  function switchTask(s) {
    rpc("focus", { sid: s.id }).then(function (m) {
      if (m.ok && m.data && m.data.focused) {
        toast("已切到该任务所在窗口");
        return;
      }
      if (tryDomClick(s.id)) {
        toast("已通过客户端任务列表切换");
        return;
      }
      var fb = document.getElementById("btree-fallback");
      if (fb) fb.classList.add("show");
      toast("该任务未在桌面端打开，见下方命令", true);
    });
  }

  function showDetail(s) {
    var d = state.data;
    var projSessions = (d.sessions || []).filter(function (x) { return x.proj === s.proj; });
    var byId = Object.create(null);
    projSessions.forEach(function (x) { byId[x.id] = x; });
    /* 祖先链（最初 → 本任务）与直接分叉 */
    var anc = [], cur = s, seen = Object.create(null);
    while (cur && !seen[cur.id]) {
      seen[cur.id] = 1;
      anc.push(cur);
      if (!cur.pid || !byId[cur.pid]) break;
      cur = byId[cur.pid];
    }
    anc.reverse();
    var kids = projSessions.filter(function (x) { return x.pid === s.id; });
    var isOpen = !!(d.windows && d.windows[s.id]);
    var isDisc = !!(d.marks && d.marks[s.id]);
    var statusBits = [];
    if (s.st === "running") statusBits.push('<b style="color:#15803d">▶ 运行中</b>');
    else if (s.unread) statusBits.push('<b style="color:#c2410c">◐ 未读</b>');
    else statusBits.push('<span style="color:#64748b">已读</span>');
    if (isOpen) statusBits.push('<span style="color:#1d4ed8">● 已在某窗口打开</span>');
    if (s.pin) statusBits.push("📌 已置顶");
    if (s.arch) statusBits.push('<span style="color:#94a3b8">客户端已归档</span>');
    if (isDisc) statusBits.push('<b style="color:#64748b">✗ 已标注舍弃</b>');
    var crumbs = anc.map(function (a, i) {
      var t = esc((a.title || "").slice(0, 16));
      var step = '<span class="step" data-sid="' + esc(a.id) + '" title="' + esc(a.title || "") + '">' +
        (i === 0 && !a.pid ? "最初：" : "") + t + "</span>";
      return i < anc.length - 1 ? step + '<span class="arrow">→</span>' : step;
    }).join("");
    elDetail.classList.add("open");
    elDetail.innerHTML = [
      '<div class="dh">' + esc(s.title) + "</div>",
      '<div class="dmeta">' + (s.tt === "fork" ? "🜂 分叉任务" : "● 主线任务") + " · " + statusBits.join(" · ") +
      (s.id === d.mine ? " · <b style=color:#1d4ed8>本窗口</b>" : "") + "</div>",
      '<div class="dmeta">创建 ' + fmtRel(s.tc) + " · 最近活动 " + fmtRel(s.tu) + " · 📁 " + esc(s.dir) + "</div>",
      '<div class="crumbs">' + crumbs + "</div>",
      kids.length ? '<div class="kids">↳ 分出 ' + kids.length + " 条分支：" +
        kids.map(function (k) { return '<span class="kid" data-sid="' + esc(k.id) + '" title="' + esc(k.title || "") + '">' + esc((k.title || "").slice(0, 18)) + "</span>"; }).join("") + "</div>" : "",
      '<div style="font-weight:600;margin-top:8px">' + (s.tt === "fork" ? "分支时的语句" : "任务最初的输入") + "</div>",
      '<div class="dquote">' + esc(s.first || "（未提取到首句，可看标题）") + "</div>",
      '<div class="dstats">',
      "  🔁 " + (s.turns || 0) + " 轮 · " + (s.reqs || 0) + " 次请求 · " + fmtTok(s.tok) + " tokens",
      (s.files ? "<br>  ✏️ +" + (s.add || 0) + " / -" + (s.del || 0) + " 行 · " + s.files + " 个文件" : ""),
      "</div>",
      '<div class="dact">',
      '  <button class="main" id="btree-go">⇄ 切换到此任务</button>',
      '  <button id="btree-mark">' + (isDisc ? "↩ 取消舍弃标注" : "✗ 标记为舍弃") + "</button>",
      '  <button id="btree-copy">⧉ 复制 resume 命令（终端里继续）</button>',
      "</div>",
      '<div class="fallback" id="btree-fallback">',
      "  该任务没有在桌面端打开，也暂时没在任务列表里渲染出来。可以在终端里恢复：",
      '  <input id="btree-cmd" readonly value="zcode --resume ' + esc(s.id) + '" />',
      "</div>",
    ].join("");
    $("btree-go").addEventListener("click", function () { switchTask(s); });
    $("btree-mark").addEventListener("click", function () {
      rpc("mark", { sid: s.id, on: !isDisc }).then(function (m) {
        if (!m.ok) { toast(m.error || "标注失败", true); return; }
        if (!state.data.marks) state.data.marks = {};
        if (isDisc) delete state.data.marks[s.id]; else state.data.marks[s.id] = true;
        toast(isDisc ? "已取消舍弃标注" : "已标注为舍弃");
        renderProj();
        showDetail(s);
      });
    });
    $("btree-copy").addEventListener("click", function () { copyText("zcode --resume " + s.id); });
    var jump = function () { select(this.getAttribute("data-sid")); };
    Array.prototype.forEach.call(elDetail.querySelectorAll(".step,.kid"), function (el) {
      el.addEventListener("click", jump);
    });
    var cmd = $("btree-cmd");
    if (cmd) cmd.addEventListener("click", function () { cmd.select(); });
  }

  /* ---------- 事件：db 变化 / 活跃任务变化 → 节流刷新 ---------- */
  window.__btreeEvent = function (ev) {
    if (!ev || !ev.type) return;
    if (!panel.classList.contains("open")) return;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(function () {
      var wait = Date.now() - state.lastLoad > 1200 ? 0 : 1300;
      if (wait) setTimeout(function () { loadTree(false); }, wait);
      else loadTree(false);
    }, 400);
  };

})();
