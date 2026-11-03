/* Desk – iPhone web app. Plain JS, no framework, no build step.
   Reads the relay at the same origin (shapes: /workspace/desk/API_SHAPES.md).
   Token: #t= once -> localStorage -> Authorization: Bearer. Only EventSource /api/stream uses ?t=. */
(function () {
  "use strict";

  /* ================================================================ utils */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" || !isFinite(+v) ? null : +v);
  const has = (v) => num(v) !== null;
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pick = (o, ...ks) => { if (!o) return undefined; for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
  const icon = (id, cls = "") => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
  const linkOf = (o) => pick(o, "coin_url", "link");
  const haptic = () => { try { navigator.vibrate && navigator.vibrate(8); } catch (_) {} };

  const money = (v, d) => Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtUsd = (v, d = 2) => { v = num(v); return v === null ? "n/a" : (v < 0 ? "-$" : "$") + money(v, d); };
  const fmtSigned = (v, d = 2) => { v = num(v); return v === null ? "n/a" : (v >= 0 ? "+$" : "-$") + money(v, d); };
  const fmtPct = (v, d = 2, sign = true) => { v = num(v); return v === null ? "n/a" : (sign && v >= 0 ? "+" : "") + v.toFixed(d) + "%"; };
  const fmtCompact = (v) => { v = num(v); if (v === null) return "n/a"; const a = Math.abs(v);
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B"; if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K"; return "$" + v.toFixed(0); };
  const fmtPrice = (v) => { v = num(v); if (v === null) return "n/a"; if (v >= 1) return fmtUsd(v, v >= 1000 ? 2 : 4);
    if (v === 0) return "$0"; const dec = Math.min(12, Math.max(2, -Math.floor(Math.log10(v)) + 3)); return "$" + v.toFixed(dec); };
  const fmtInt = (v) => { v = num(v); return v === null ? "n/a" : Math.round(v).toLocaleString("en-US"); };
  const toMs = (t) => { if (t === null || t === undefined || t === "") return null; if (typeof t === "number") return t < 1e12 ? t * 1000 : t; const d = Date.parse(t); return isNaN(d) ? null : d; };
  const fmtTime = (t) => { const ms = toMs(t); return ms === null ? "" : new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };
  const fmtLeft = (s) => { s = num(s); if (s === null) return "n/a"; s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
  const initials = (s) => esc(String(s || "?").replace(/^\$/, "").slice(0, 2).toUpperCase());
  const avatar = (c, cls = "") => { const img = safeUrl(c && (c.image || c.logo || c.icon));
    return `<div class="av ${cls}">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${initials(c && (c.symbol || c.name))}</span></div>`; };
  const coinName = (c) => (c && (c.name || c.symbol)) || "coin";
  const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");

  /* ================================================================ token */
  const TK = "desk_token";
  // Accepts a full private link (…#t=TOKEN, also ?t= / &t=) or a bare token. Never logged.
  function parseTok(raw) {
    const x = String(raw || "").trim();
    const m = x.match(/[#?&]t=([^&#\s]+)/);
    let t = m ? m[1] : (/^[A-Za-z0-9._~+\/=-]{8,}$/.test(x) ? x : "");
    try { t = decodeURIComponent(t); } catch (_) {}
    return /^[A-Za-z0-9._~+\/=-]{8,}$/.test(t) ? t : "";
  }
  // Store #t= BEFORE stripping it; runs on every load and every hashchange.
  function grabToken() {
    const h = location.hash || "";
    const m = h.match(/[#&]t=([^&]+)/);
    if (!m) return false;
    const t = parseTok("#t=" + m[1]);
    if (t) { try { localStorage.setItem(TK, t); } catch (_) {} NET.authFail = false; }
    const rest = h.replace(/[#&]t=[^&]+/, "").replace(/^[#&]+/, "");
    history.replaceState(null, "", location.pathname + location.search + (rest ? "#" + rest : "#/"));
    return !!t;
  }
  const token = () => { try { return localStorage.getItem(TK) || ""; } catch (_) { return ""; } };

  /* ================================================================ store + network */
  const C = { state: null, chart: {}, activity: null, account: null, settings: null, autotrade: null, coin: {}, audit: {}, agent: {} };
  const NET = { offline: false, authFail: false, lastPush: null, retryAt: 0, backoff: 5, timer: 0 };
  const PENDING = new Map();   // optimistic overrides: "pause:scanner" / "set:risk.stop_pct" -> {value, until}
  const CMDS = new Map();      // relay command id -> label, matched with SSE command_result
  const SIGNALS = new Map();   // mint -> LIVE signal waiting for Bought / Skip (from SSE signal status "sent")
  const EXITS = new Map();     // mint -> exit waiting for Sold (LIVE)

  async function api(path, opt = {}) {
    const t = token();
    if (!t) { NET.authFail = true; throw { status: 401 }; }
    let r;
    try {
      r = await fetch(path, { method: opt.method || "GET", cache: "no-store",
        headers: Object.assign({ Authorization: "Bearer " + t }, opt.body ? { "Content-Type": "application/json" } : {}),
        body: opt.body ? JSON.stringify(opt.body) : undefined });
    } catch (e) { goOffline(null); throw { status: 0, offline: true }; }
    if (r.status === 401) { if (!NET.authFail) { NET.authFail = true; render(); } throw { status: 401 }; }
    let data = null; try { data = await r.json(); } catch (_) {}
    if (r.status === 503 || (r.status >= 500 && !opt.method)) { goOffline(data && data.last_push); throw { status: r.status, offline: true }; }
    const lp = num(r.headers.get("X-Desk-Last-Push")); if (lp) NET.lastPush = lp;
    if (!opt.method && r.ok) goOnline();
    if (!r.ok) throw { status: r.status, data };
    return data;
  }
  function goOffline(lastPush) {
    if (num(lastPush)) NET.lastPush = num(lastPush);
    if (!NET.offline) { NET.offline = true; NET.backoff = 5; }
    if (!NET.timer) {
      NET.retryAt = Date.now() + NET.backoff * 1000;
      NET.timer = setTimeout(() => { NET.timer = 0; NET.backoff = Math.min(30, NET.backoff * 2); refresh(); }, NET.backoff * 1000);
    }
    paintOffline();
  }
  function goOnline() { if (NET.offline) { NET.offline = false; NET.backoff = 5; clearTimeout(NET.timer); NET.timer = 0; paintOffline(); } }
  setInterval(() => NET.offline && paintOffline(), 1000);
  function paintOffline() {
    for (const el of $$(".offline-slot")) {
      if (!NET.offline) { el.innerHTML = ""; continue; }
      const n = Math.max(0, Math.ceil((NET.retryAt - Date.now()) / 1000));
      const last = NET.lastPush ? fmtTime(NET.lastPush) : "never";
      el.innerHTML = `<div class="offline" role="status">Desk offline · retrying in ${n}s · last update ${esc(last)}</div>`;
    }
  }

  /* ================================================================ toasts (slide down, ~2s, stack) */
  function toast(o) {
    if (typeof o === "string") o = { title: o };
    const box = $("#toasts");
    const el = document.createElement("div");
    const kind = o.kind || "info";
    const col = { ok: "var(--green)", err: "var(--red)", warn: "var(--orange)", buy: "var(--blue)", info: "var(--card2)" }[kind];
    const fg = kind === "ok" || kind === "warn" ? "#000" : "#fff";
    const glyph = { ok: "✓", err: "!", warn: "!", buy: "$", info: "D" }[kind];
    el.className = "toast tap toast-" + kind;
    el.innerHTML = (o.coin ? avatar(o.coin, "ti") : `<div class="ti" style="background:${col};color:${fg}">${glyph}</div>`) +
      `<div style="min-width:0;flex:1"><div class="tt">${esc(o.title)}</div>${o.sub ? `<div class="ts">${esc(o.sub)}</div>` : ""}</div><div class="tm">${esc(o.when || "now")}</div>`;
    let gone = false;
    const dismiss = () => { if (gone) return; gone = true; el.classList.add("out"); setTimeout(() => el.remove(), 400); };
    el.addEventListener("click", () => { if (o.href) location.hash = o.href; dismiss(); });
    box.prepend(el);
    while (box.children.length > 3) box.lastElementChild.remove();
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
    setTimeout(dismiss, o.ms || 2200);
    return el;
  }

  /* ================================================================ bottom sheet */
  function sheet(html, onMount) {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    const sh = document.createElement("div"); sh.className = "sheet"; sh.setAttribute("role", "dialog");
    sh.innerHTML = `<div class="grab"></div>` + html;
    document.body.append(bg, sh);
    requestAnimationFrame(() => requestAnimationFrame(() => { bg.classList.add("in"); sh.classList.add("in"); }));
    const close = () => { bg.classList.remove("in"); sh.classList.remove("in"); setTimeout(() => { bg.remove(); sh.remove(); }, 320); };
    bg.addEventListener("click", close);
    onMount && onMount(sh, close);
    return close;
  }
  const confirmSheet = (title, text, okLabel, okCls = "red") => new Promise((res) => {
    sheet(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btn-row"><button class="btn ghost" data-x>Cancel</button><button class="btn ${okCls}" data-ok>${esc(okLabel)}</button></div>`,
      (sh, close) => { $("[data-x]", sh).onclick = () => { close(); res(false); }; $("[data-ok]", sh).onclick = () => { close(); res(true); }; });
  });

  /* ================================================================ writes */
  // Every button that talks to the desk goes through post(): pressed state, spinner, toast, then
  // the SSE command_result (matched by the relay id) confirms or refuses it.
  async function post(btn, path, body, msg) {
    if (btn) { btn.classList.add("busy"); btn.disabled = true; }
    haptic();
    try {
      const r = await api(path, { method: "POST", body });
      if (r && r.id) CMDS.set(r.id, msg.ok);
      toast({ title: msg.ok || "Sent to the desk", sub: msg.okSub || "Sent to the desk · confirms in a few seconds", kind: "ok" });
      setTimeout(() => refresh(), 2500);
      return r || { queued: true };
    } catch (e) {
      const why = e && e.offline ? "Desk offline, try again in a moment" : e && e.status === 401 ? "Link expired, open your private link again" :
        (e && e.data && e.data.error) || (e && e.status ? "Error " + e.status : "No connection");
      toast({ title: msg.err || "Didn't go through", sub: why, kind: "err", ms: 3200 });
      return null;
    } finally {
      if (btn) { btn.classList.remove("busy"); btn.disabled = false; }
    }
  }
  function coinAction(btn, x, action) {
    const body = { mint: x.mint, action };
    if (has(pick(x, "signalId"))) body.signalId = +x.signalId;
    if (has(pick(x, "positionId"))) body.positionId = +x.positionId;
    return post(btn, "/api/action", body, {
      ok: { Bought: `Marked ${coinName(x)} bought`, Sold: `Marked ${coinName(x)} sold`, Skip: `Skipped ${coinName(x)}` }[action],
      okSub: action === "Skip" ? "Executor lets this one go" : action === "Bought" ? "Risk starts guarding it" : "Risk closes the position",
    }).then((r) => { if (r) { if (action === "Sold") EXITS.delete(x.mint); else SIGNALS.delete(x.mint); if (cur && cur.update) cur.update(); } return r; });
  }
  function openExternal(url) {
    const u = safeUrl(url);
    if (!u) { toast({ title: "No FOMO link from the desk", kind: "err" }); return; }
    haptic();
    window.open(u, "_blank", "noopener");
  }
  async function share(url, text) {
    const u = safeUrl(url);
    if (!u) { toast({ title: "No link from the desk yet", kind: "err" }); return; }
    haptic();
    if (navigator.share) { try { await navigator.share({ title: "FOMO", text, url: u }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(u); }
    catch (_) { const ta = document.createElement("textarea"); ta.value = u; document.body.append(ta); ta.select(); try { document.execCommand("copy"); } catch (_) {} ta.remove(); }
    toast({ title: "Link copied", kind: "ok" });
  }

  /* ================================================================ normalizers */
  const AGENTS = [
    { key: "scanner", name: "Scanner", color: "var(--cyan)", bg: "var(--cyan-d)", ic: "scanner" },
    { key: "auditor", name: "Auditor", color: "var(--blue)", bg: "var(--blue-d)", ic: "auditor" },
    { key: "analyst", name: "Analyst", color: "var(--yellow)", bg: "var(--yellow-d)", ic: "analyst" },
    { key: "executor", name: "Executor", color: "var(--green)", bg: "var(--green-d)", ic: "executor" },
    { key: "risk", name: "Risk", color: "var(--pink)", bg: "var(--pink-d)", ic: "risk" },
  ];
  function agentsOf(st) {
    const raw = st && st.agents; const out = {};
    if (Array.isArray(raw)) for (const a of raw) { if (a && a.name) out[String(a.name).toLowerCase()] = a; }
    else if (raw && typeof raw === "object") for (const k in raw) out[k.toLowerCase()] = Object.assign({ name: k }, raw[k]);
    return out;
  }
  function agentPaused(key, a) {
    const p = PENDING.get("pause:" + key);
    if (p && p.until > Date.now()) { if (a && ((typeof a.paused === "boolean" && a.paused === p.value))) PENDING.delete("pause:" + key); else return p.value; }
    if (!a) return null;
    if (typeof a.paused === "boolean") return a.paused;
    if (a.status) return /pause/i.test(a.status);
    return null;
  }
  const openPositions = (st) => num(pick(st || {}, "openPositions")) ?? 0;
  const mode = () => String(pick(C.state, "mode") || pick(C.account, "mode") || "PAPER").toUpperCase();
  const isPaper = () => (C.state && typeof C.state.paper === "boolean" ? C.state.paper : mode() === "PAPER");
  const paperBadge = () => (isPaper() ? `<span class="badge paper">PAPER</span>` : "");
  function points(ch) {
    const p = ch && ch.points; if (!Array.isArray(p)) return [];
    return p.map((q) => (Array.isArray(q) ? [toMs(q[0]), +q[1]] : [toMs(q.ts), +(q.value ?? q.balance)])).filter((q) => q[0] && isFinite(q[1]));
  }
  const MARK = { bought: "buy", buy: "buy", gain: "sell", sell: "sell", loss: "stop", stop: "stop" };
  const marks = (ch) => ((ch && ch.marks) || []).map((m) => ({ ts: toMs(m.ts), value: m.value, kind: MARK[m.kind] || (m.color === "blue" ? "buy" : m.color === "red" ? "stop" : "sell"), label: m.label }));
  function settingVal(path) {
    const p = PENDING.get("set:" + path); if (p && p.until > Date.now()) return p.value;
    const S = C.settings; if (!S) return undefined;
    const V = S.values || S;
    return V[path];
  }
  const metaOf = (path) => (C.settings && C.settings.meta && C.settings.meta[path]) || null;

  /* ================================================================ odometer: digits roll 600ms ease-out, 30ms stagger right->left */
  function odometer(el, text) {
    const prev = el.dataset.v || "";
    if (prev === text) return;
    el.dataset.v = text; el.setAttribute("aria-label", text);
    const cell = (ch) => /\d/.test(ch)
      ? `<span class="odo" aria-hidden="true"><span class="strip" style="transform:translateY(-${+ch * 1.06}em)">${"0123456789".split("").map((d) => `<span>${d}</span>`).join("")}</span></span>`
      : `<span class="odc">${esc(ch)}</span>`;
    if (!prev || prev.length !== text.length || RM()) { el.innerHTML = text.split("").map(cell).join(""); return; }
    const cells = Array.from(el.children); let k = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      if (prev[i] === text[i]) continue;
      const strip = cells[i] && cells[i].querySelector(".strip");
      if (strip && /\d/.test(text[i])) { strip.style.transitionDelay = k * 30 + "ms"; strip.style.transform = `translateY(-${+text[i] * 1.06}em)`; k++; }
      else if (cells[i]) cells[i].outerHTML = cell(text[i]);
    }
  }
  function fitText(el, maxPx, minPx) {
    if (!el.parentElement) return;
    el.style.fontSize = maxPx + "px";
    const sib = el.nextElementSibling;
    const avail = el.parentElement.clientWidth - (sib && sib.offsetWidth ? sib.offsetWidth + 10 : 0);
    let f = maxPx; while (f > minPx && el.scrollWidth > avail) { f -= 2; el.style.fontSize = f + "px"; }
  }

  /* ================================================================ skeleton / empty */
  const sk = (h, w = "100%", r = 10, mt = 0) => `<div class="skel" style="height:${h}px;width:${w};border-radius:${r}px;margin-top:${mt}px"></div>`;
  const emptyBox = (ic, title, text) => `<div class="empty"><div class="ico">${icon(ic)}</div><b>${esc(title)}</b>${text ? `<div>${esc(text)}</div>` : ""}</div>`;

  /* ================================================================ router */
  let cur = null;
  const view = () => $("#view");
  function route() {
    const h = (location.hash || "#/").replace(/^#\/?/, "");
    const [name, arg] = h.split("/");
    return { name: name || "home", arg: arg ? decodeURIComponent(arg) : "" };
  }
  window.addEventListener("hashchange", () => { if (grabToken()) { stopStream(); C.account = null; startStream(); } render(); });
  $$("#tabbar button").forEach((b) => b.addEventListener("click", () => {
    haptic(); const t = b.dataset.tab;
    if (route().name === t || (t === "home" && route().name === "home")) { view().scrollTo({ top: 0, behavior: RM() ? "auto" : "smooth" }); return; }
    location.hash = "#/" + (t === "home" ? "" : t);
  }));
  function render() {
    if (cur && cur.unmount) cur.unmount();
    cur = null;
    const v = view(); v.onscroll = null; v.scrollTop = 0; v.className = "screen" + (RM() ? "" : " view-enter");
    const r = route();
    $$("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === r.name));
    const pushed = r.name === "coin" || r.name === "audit";
    $("#tabbar").classList.toggle("hide", pushed);
    v.classList.toggle("pushed", pushed);
    if (!token() || NET.authFail) { $("#tabbar").classList.add("hide"); v.innerHTML = authScreen(); wireAuth(v); return; }
    const S = SCREENS[r.name] || SCREENS.home;
    cur = S(v, r.arg) || {};
    if (cur.update) cur.update();
    paintOffline();
    v.onscroll = () => { const h = $(".hdr", v); h && h.classList.toggle("scrolled", v.scrollTop > 4); };
    refresh();
  }
  const STANDALONE = () => (window.navigator.standalone === true) || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
  function authScreen() {
    const expired = NET.authFail && !!token();
    const hint = STANDALONE()
      ? "Home Screen apps don't share Safari's sign-in. Copy your private link and paste it here once."
      : "Open the private link the desk sent you, or paste it here. It signs this iPhone in once.";
    return `<header class="hdr"><div class="title"><span>Desk</span></div></header>` +
      emptyBox("lock", expired ? "This link has expired" : "Paste your private link", hint) +
      `<form id="signin" class="signin" autocomplete="off" novalidate>
        <label for="tok-in" class="sr">Private link or token</label>
        <input id="tok-in" class="tokf" type="password" name="desk-link" placeholder="Paste your private link" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" inputmode="url">
        <button id="tok-go" class="btn green full" type="submit">Sign in</button>
      </form>`;
  }
  function wireAuth(v) {
    const f = $("#signin", v), inp = $("#tok-in", v), b = $("#tok-go", v);
    if (!f) return;
    if (STANDALONE()) setTimeout(() => { try { inp.focus(); } catch (_) {} }, 300);
    f.onsubmit = async (e) => {
      e.preventDefault(); haptic();
      const t = parseTok(inp.value);
      if (!t) { toast({ title: "That isn't a private link", sub: "Paste the whole link, or just the token", kind: "err" }); return; }
      b.disabled = true; b.classList.add("busy"); const lbl = b.textContent; b.textContent = "Signing in…";
      let st = 0;
      try { const r = await fetch("/api/state", { cache: "no-store", headers: { Authorization: "Bearer " + t } }); st = r.status; } catch (_) { st = 0; }
      b.disabled = false; b.classList.remove("busy"); b.textContent = lbl;
      if (st === 200 || st === 503) {            // 503 = token good, desk just stale
        try { localStorage.setItem(TK, t); } catch (_) {}
        inp.value = ""; NET.authFail = false; C.account = null;
        toast({ title: "Signed in", sub: st === 503 ? "Desk is offline right now · retrying" : "This iPhone is connected", kind: "ok" });
        stopStream(); startStream(); if (location.hash && location.hash !== "#/") location.hash = "#/"; else render();
      } else if (st === 401 || st === 403) {
        inp.value = ""; toast({ title: "Link not accepted", sub: "Check you copied the newest private link", kind: "err" });
      } else {
        toast({ title: "Can't reach the desk", sub: "Check your connection and try again", kind: "err" });
      }
    };
  }
  let inflight = false, again = false;
  async function refresh() {
    if (!cur || !cur.load) return;
    if (inflight) { again = true; return; }
    inflight = true; const me = cur;
    try { await me.load(); } catch (_) { /* offline row painted; last good numbers stay */ }
    finally { inflight = false; if (cur === me && me.update) me.update(); if (again) { again = false; refresh(); } }
  }
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  const softRefresh = (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(refresh, 500); }; })();
  async function all(ps) { const r = await Promise.allSettled(ps); const bad = r.find((x) => x.status === "rejected"); if (bad) throw bad.reason; }
  const loadState = async () => { C.state = await api("/api/state"); };
  const loadSettings = async () => { C.settings = await api("/api/settings"); };
  const loadAccount = async () => { C.account = await api("/api/account"); };
  // Rows that arrived over SSE stay visible until the desk's next snapshot includes them.
  const LIVE_ROWS = [];
  const rowKey = (r) => (r.id !== undefined && r.id !== null ? "i" + r.id : "t" + r.ts + "|" + r.title);
  const mergeLive = (arr) => {
    const have = new Set(arr.map(rowKey));
    for (let i = LIVE_ROWS.length - 1; i >= 0; i--) if (have.has(rowKey(LIVE_ROWS[i]))) LIVE_ROWS.splice(i, 1);
    return LIVE_ROWS.concat(arr).sort((a, b) => toMs(b.ts) - toMs(a.ts));
  };
  const loadActivity = async () => { const d = await api("/api/activity?limit=30"); C.activity = mergeLive(Array.isArray(d) ? d : []); };

  /* ================================================================ HOME */
  // Header name: the FOMO handle from the desk (settings desk.fomo_handle via /api/account), else "Desk".
  function handleName() {
    const h = (C.account && C.account.fomo_handle) || (C.state && (C.state.fomo_handle || C.state.fomoHandle)) || "";
    const t = String(h).trim().replace(/^@+/, "");
    return t ? "@" + t : "Desk";
  }
  const RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];
  let homeRange = "LIVE";
  function homeScreen(v) {
    v.innerHTML = `
      <header class="hdr">
        <button class="nav-av tap" id="h-av" aria-label="Account">${icon("account")}</button>
        <button class="nav-name tap" id="h-name" aria-label="Account"><span id="h-handle">${esc(handleName())}</span>${icon("chev")}</button>
        <div style="flex:1"></div>
        <button class="ibtn tap" id="h-search" aria-label="Search">${icon("search")}</button>
        <button class="ibtn tap" id="h-bell" aria-label="Notifications">${icon("bell")}<i class="dot hidden" id="h-dot"></i></button>
      </header>
      <div class="offline-slot"></div>
      <div id="h-searchbar" class="hidden"><div class="searchbar">${icon("search")}<input id="h-q" placeholder="Name, symbol or mint" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></div><div id="h-results" class="sec" style="margin-top:8px"></div></div>
      <section class="hero">
        <div class="balrow"><div class="bal" id="h-bal" aria-label="Balance"></div><span id="h-badge"></span></div>
        <div class="pnl" id="h-pnl"></div>
      </section>
      <div class="chart-wrap"><canvas id="h-chart"></canvas><div class="chart-empty hidden" id="h-chart-empty"></div></div>
      <div class="ranges" id="h-ranges">${RANGES.map((r) => `<button class="pill tap ${r === homeRange ? "on" : ""}" data-r="${r}">${r === "LIVE" ? '<i class="ldot"></i>' : ""}${r}</button>`).join("")}</div>
      <div id="h-needs"></div>
      <div id="h-trade"></div>
      <div id="h-live"></div>
      <section class="sec"><div class="sec-h"><h2 id="h-agents-h">Agents</h2><button class="link tap" data-go="#/agents">See all</button></div>
        <div class="hscroll" id="h-cards"></div><div class="dots" id="h-dots">${AGENTS.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div></section>
      <section class="sec"><div class="sec-h"><h2>Activity</h2><button class="link tap" data-go="#/activity">See all</button></div><div id="h-act"></div></section>`;
    const chart = new Charts.Line($("#h-chart", v));
    $("#h-av", v).onclick = $("#h-name", v).onclick = () => (location.hash = "#/account");
    $$("[data-go]", v).forEach((b) => (b.onclick = () => (location.hash = b.dataset.go)));
    $("#h-trade", v).addEventListener("click", (e) => { const st = e.target.closest("[data-tstop]"); if (st) { haptic(); return tradeStop(st); }
      const g = e.target.closest("[data-go]"); if (g) { haptic(); location.hash = g.dataset.go; } });
    $("#h-live", v).addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) { haptic(); location.hash = g.dataset.go; } });
    $("#h-ranges", v).addEventListener("click", (e) => {
      const b = e.target.closest("[data-r]"); if (!b || b.dataset.r === homeRange) return; haptic();
      homeRange = b.dataset.r; $$("#h-ranges .pill", v).forEach((x) => x.classList.toggle("on", x === b));
      chart._sig = ""; update(); refresh();
    });
    $("#h-search", v).onclick = () => { const sb = $("#h-searchbar", v); sb.classList.toggle("hidden"); if (!sb.classList.contains("hidden")) $("#h-q", v).focus(); };
    $("#h-q", v).addEventListener("input", () => searchResults(v));
    $("#h-q", v).addEventListener("keydown", (e) => { if (e.key === "Enter") { const q = e.target.value.trim(); if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) location.hash = "#/coin/" + q; } });
    $("#h-bell", v).onclick = openBell;
    const cards = $("#h-cards", v);
    cards.addEventListener("scroll", () => { const w = cards.firstElementChild ? cards.firstElementChild.offsetWidth + 10 : 1; const i = Math.round(cards.scrollLeft / w); $$("#h-dots i", v).forEach((d, j) => d.classList.toggle("on", j === i)); }, { passive: true });
    cards.addEventListener("click", (e) => { const c = e.target.closest("[data-agent]"); if (!c) return; haptic();
      const k = c.dataset.agent, a = agentsOf(C.state)[k] || {};
      if (k === "auditor") { const cm = a.current || a.last; location.hash = "#/audit/" + (cm && cm.mint ? encodeURIComponent(cm.mint) : ""); }
      else location.hash = "#/agents/" + k; });

    async function load() {
      if (!C.account) loadAccount().then(() => cur && cur.update && cur.update()).catch(() => {});
      loadTrade().then(() => cur && cur.update && cur.update()).catch(() => {});
      loadFeed().then(() => cur && cur.update && cur.update()).catch(() => {});
      await all([loadState(), loadActivity(),
        api("/api/chart?range=" + homeRange).then((d) => { C.chart[homeRange] = d && d[homeRange] ? d[homeRange] : d; })]);
    }
    function update() {
      const st = C.state;
      const hn = $("#h-handle", v); if (hn && hn.textContent !== handleName()) hn.textContent = handleName();
      const bal = $("#h-bal", v), pnl = $("#h-pnl", v);
      if (!st) { bal.innerHTML = sk(62, "230px", 14); pnl.innerHTML = sk(20, "170px", 8, 6); }
      else {
        const b = num(st.balance);
        if (b === null) { bal.dataset.v = ""; bal.textContent = "n/a"; }
        else { if (!bal.querySelector(".odo")) { bal.dataset.v = ""; bal.innerHTML = ""; } odometer(bal, fmtUsd(b)); }
        $("#h-badge", v).innerHTML = paperBadge();
        fitText(bal, 66, 40);
        const tp = num(st.todayPct), tu = num(st.todayUsd), mult = num(st.multiplier);
        const down = (tp ?? tu ?? 0) < 0;
        pnl.innerHTML = `<span class="${down ? "red" : "green"}">${down ? "▼" : "▲"} ${tu !== null ? esc(fmtSigned(tu)) + " " : ""}(${esc(fmtPct(tp))})</span><span class="muted">today</span>` +
          (mult !== null ? `<span class="mult ${mult < 1 ? "neg" : ""}">${mult.toFixed(2)}×</span>` : "");
      }
      const ch = C.chart[homeRange];
      const pts = points(ch), mk = marks(ch);
      const start = num(pick(ch || {}, "start")) ?? num(pick(st || {}, "nightStartBalance"));
      const emp = $("#h-chart-empty", v);
      if (!ch) { emp.classList.remove("hidden"); emp.innerHTML = NET.offline ? "No chart yet" : sk(200, "92%", 14); }
      else if (ch.empty || pts.length < 2) {
        emp.classList.remove("hidden");
        emp.innerHTML = `<div class="startline"></div><div class="wait">Waiting for the first trade</div>`;
        chart.setData([], [], null); chart._sig = "";
      } else {
        emp.classList.add("hidden");
        const sig = JSON.stringify([pts[0], pts[pts.length - 1], pts.length, mk.length, start]);
        if (sig !== chart._sig) { chart._sig = sig; chart.setData(pts, mk, start); }
      }
      renderNeeds(v, st);
      const ht = $("#h-trade", v); if (ht) { const h = tradeHomeCard(C.autotrade); if (ht._h !== h) { ht._h = h; ht.innerHTML = h; } }
      const hl = $("#h-live", v); if (hl) { const h = feedHomeCard(C.tradefeed); if (hl._h !== h) { hl._h = h; hl.innerHTML = h; } }
      const A = agentsOf(st);
      const running = num(pick(st || {}, "agentsRunning")) ?? AGENTS.filter((a) => A[a.key] && agentPaused(a.key, A[a.key]) === false).length;
      $("#h-agents-h", v).textContent = st ? `Agents · ${running} running` : "Agents";
      const cardsEl = $("#h-cards", v), sl = cardsEl.scrollLeft;
      cardsEl.innerHTML = st ? AGENTS.map((a) => agentCard(a, A[a.key])).join("") : AGENTS.map(() => `<div class="acard skel"></div>`).join("");
      cardsEl.scrollLeft = sl;
      $$("#h-cards canvas[data-ring]", v).forEach((cv) => Charts.ring(cv, num(cv.dataset.score), num(cv.dataset.min) ?? 70));
      runExecBars(v);
      $("#h-act", v).innerHTML = activityList(C.activity, 5);
      bellDot();
    }
    const feedTimer = setInterval(() => { if (!document.hidden) loadFeed().then(() => cur && cur.update && cur.update()).catch(() => {}); }, 8000);
    return { load, update, unmount: () => { clearInterval(feedTimer); chart.destroy(); } };
  }

  function needsList(st) {
    const list = [];
    const ex = agentsOf(st).executor;
    const bar = ex && ex.bar;
    for (const s of SIGNALS.values()) list.push({ kind: "signal", ...s });
    if (bar && bar.status === "waiting" && bar.mint && !SIGNALS.has(bar.mint)) list.push({ kind: "signal", mint: bar.mint, name: bar.name, sizeUsd: ex.lastSizeUsd ?? ex.ticketUsd, stackPct: ex.lastPctOfStack ?? ex.ticketPctOfStack, ts: bar.startedAt });
    for (const x of EXITS.values()) list.push({ kind: "exit", ...x });
    return list;
  }
  function renderNeeds(v, st) {
    // LIVE: a signal waits for Bought / Skip, an exit waits for Sold. FOMO has no order API.
    const box = $("#h-needs", v); if (!box) return;
    const list = needsList(st);
    if (!list.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<section class="sec"><div class="sec-h"><h2>Needs you</h2></div>` + list.map((x, i) => {
      const sig = x.kind === "signal";
      const line = sig ? `Buy ${esc(coinName(x))} · ${esc(fmtUsd(x.sizeUsd))}${has(x.stackPct) ? " · " + esc(fmtPct(x.stackPct, 2, false)) + " of stack" : ""}`
        : `Sell ${esc(coinName(x))}${x.reason ? " · " + esc(x.reason) : ""}`;
      return `<div class="need"><div class="top tap" data-open="${esc(x.mint)}">${avatar(x)}<div class="main" style="flex:1;min-width:0"><div style="font-weight:700">${line}</div><div class="muted" style="font-size:13px">${sig ? "Executor" : "Risk"} · ${esc(fmtTime(x.ts) || "now")}</div></div>${icon("chev", "chev")}</div>
        <div class="btn-row">${sig
          ? `<button class="btn green" data-fomo="${i}">Buy on FOMO</button><button class="btn blue" data-act="Bought" data-i="${i}">Bought</button><button class="btn ghost" data-act="Skip" data-i="${i}">Skip</button>`
          : `<button class="btn red" data-fomo="${i}">Sell on FOMO</button><button class="btn blue" data-act="Sold" data-i="${i}">Sold</button>`}</div></div>`;
    }).join("") + `</section>`;
    box.onclick = async (e) => {
      const f = e.target.closest("[data-fomo]");
      if (f) { const x = list[+f.dataset.fomo]; let u = linkOf(x);
        if (!u) { try { const c = C.coin[x.mint] || (C.coin[x.mint] = await api("/api/coin/" + encodeURIComponent(x.mint))); u = c && c.coin_url; } catch (_) {} }
        return openExternal(u); }
      const a = e.target.closest("[data-act]"); if (a) return coinAction(a, list[+a.dataset.i], a.dataset.act);
      const o = e.target.closest("[data-open]"); if (o && o.dataset.open) location.hash = "#/coin/" + encodeURIComponent(o.dataset.open);
    };
  }

  function statusDot(key, a) {
    if (!a) return `<span class="st off">No data</span>`;
    const p = agentPaused(key, a);
    if (/down/i.test(a.status || "")) return `<span class="st down">Down</span>`;
    if (p) return `<span class="st off">Paused</span>`;
    const working = (key === "auditor" && a.running) || (key === "executor" && a.bar && a.bar.status === "executing");
    return `<span class="st ${working ? "working" : ""}">${working ? "Working" : "Running"}</span>`;
  }
  function strips(layers, running) {
    const L = layers || [];
    return `<div class="strips">${Array.from({ length: 8 }, (_, i) => { const l = L.find((x) => +x.n === i + 1) || null;
      const c = l && l.pass === true ? "pass" : l && l.pass === false ? "fail" : running && (!l) && L.filter((x) => x.pass !== null && x.pass !== undefined).length === i ? "run" : "";
      return `<i class="${c}"></i>`; }).join("")}</div>`;
  }
  function agentCard(a, c) {
    const top = `<div class="top"><div class="aicon" style="background:${a.bg};color:${a.color}">${icon(a.ic)}</div><div style="flex:1;min-width:0"><div class="nm">${a.name}</div>${statusDot(a.key, c)}</div>${icon("chev", "chev")}</div>`;
    let body = "";
    if (!c) body = `<div class="body">No data from the desk yet</div>`;
    else if (a.key === "scanner") {
      const feed = (c.feed || []).slice(0, 4);
      body = `<div class="head">${fmtInt(c.pools ?? 0)} pools</div><div class="body">` +
        (feed.length ? `<div class="feed">${feed.map((f) => { const kill = /kill|drop/i.test(f.verdict || ""), wait = /wait/i.test(f.verdict || "");
          return `<div class="fr ${kill ? "kill" : ""}">${avatar(f)}<span class="n">${esc(coinName(f))}${kill ? "" : wait ? "" : ` · liq ${esc(fmtCompact(f.liquidityUsd))} · → auditor`}</span><span class="r">${kill ? esc(f.reason || "") : wait ? "waiting" : ""}</span></div>`; }).join("")}</div>`
          : `<div class="listen">Listening for graduations</div>`) + `</div>`;
    } else if (a.key === "auditor") {
      const cm = c.running && c.current ? c.current : c.last;
      const line = !cm ? "No coin taken apart yet" : c.running && c.current ? `taking apart ${esc(coinName(cm))}...` :
        `${esc(coinName(cm))} · ${esc(cm.text || (cm.passed ? "8/8 → Executor" : cm.reason || "rejected"))}`;
      body = `<div class="head">${fmtInt(c.taken ?? 0)} taken apart</div><div class="body">${strips(cm && cm.layers, c.running)}
        <div class="${cm && !c.running ? (cm.passed ? "green" : "red") : ""}" style="font-weight:600">${line}</div></div>
        <div class="foot2"><span>${fmtInt(c.rejected ?? 0)} rejected</span></div>`;
    } else if (a.key === "analyst") {
      const cm = c.last || {};
      const sc = num(cm.score), min = num(c.minScore) ?? 70;
      body = `<div class="head">${esc(c.label || "Scoring")}</div><div class="body"><div class="ringbox"><canvas data-ring data-score="${sc ?? ""}" data-min="${min}"></canvas>
        <div style="min-width:0"><div style="color:var(--text);font-weight:600;font-size:16px">${esc(cm.name || cm.symbol || "Waiting for a coin")}</div>
        <div>${sc === null ? "" : cm.passed ? "passed" : esc((cm.failed || [])[0] || "under " + min)}</div>
        <div class="mono" style="font-size:12px;margin-top:4px">${esc(c.mode || "")}${c.mode ? " · " : ""}green from ${min}</div></div></div></div>`;
    } else if (a.key === "executor") {
      const bar = c.bar;
      const lastPct = num(c.lastPctOfStack) ?? num(c.ticketPctOfStack);
      body = `<div class="head">${fmtInt(c.trades ?? 0)} trades</div><div class="body">` +
        (has(c.lastSizeUsd) || bar ? `<div style="color:var(--text);font-weight:600;font-size:16px">${esc(fmtUsd(c.lastSizeUsd ?? c.ticketUsd))} · ${esc(fmtPct(lastPct, 2, false))} of stack</div>` : `<div>No trade yet tonight</div>`) +
        (bar ? `<div style="margin-top:2px">${esc(coinName(bar))}</div><div class="bar" data-exec="${esc(bar.status)}" data-ts="${esc(toMs(bar.startedAt) || "")}" data-d="${esc(bar.durationS ?? 1.2)}"><i style="width:${bar.status === "executing" || bar.status === "waiting" ? 0 : 100}%"></i></div>
          <div data-exec-label class="${bar.status === "filled" ? "green" : bar.status === "missed" ? "red" : ""}">${{ filled: "✓ Filled", missed: "Missed", skipped: "Skipped", waiting: "Waiting for your Bought", executing: "Executing... 0%" }[bar.status] || esc(bar.status)}</div>` : "") + `</div>`;
    } else if (a.key === "risk") {
      const sp = num(c.stopPct), tp = num(c.trailPct);
      body = `<div class="head">${c.guarding ? "Guarding" : "Idle"}</div><div class="body"><div style="color:var(--text);font-size:15px">${num(c.open) ? `${fmtInt(c.open)} open position${+c.open === 1 ? "" : "s"}` : "Nothing open"}</div>
        ${c.lastExit ? `<div>Last: ${esc(c.lastExit)}</div>` : ""}</div>
        <div style="display:flex;gap:8px">${sp !== null ? `<span class="tpill red">stop -${sp}%</span>` : ""}${tp !== null ? `<span class="tpill green">trail ${tp}%</span>` : ""}</div>`;
    }
    return `<div class="acard tap" data-agent="${a.key}">${top}${body}</div>`;
  }
  function runExecBars(root) {
    // PAPER bar: "Executing... N%" over durationS from startedAt, then "✓ Filled".
    for (const b of $$(".bar[data-exec=executing]", root)) {
      const t0 = num(b.dataset.ts) || Date.now(), dur = (num(b.dataset.d) || 1.2) * 1000; const lab = b.parentElement.querySelector("[data-exec-label]");
      const step = () => { if (!b.isConnected) return; const f = RM() ? 1 : Math.min(1, Math.max(0, (Date.now() - t0) / dur));
        b.firstElementChild.style.width = Math.round(f * 100) + "%";
        if (f >= 1) { lab.textContent = "✓ Filled"; lab.className = "green"; return; }
        lab.textContent = `Executing... ${Math.round(f * 100)}%`; requestAnimationFrame(step); };
      step();
    }
  }

  /* ---------------------------------------------------------------- bell + search */
  const SEEN = "desk_seen_ts"; const recentPush = [];
  function bellDot() {
    const d = $("#h-dot"); if (!d) return;
    const seen = +(localStorage.getItem(SEEN) || 0);
    const fromState = num(pick(C.state || {}, "unreadPushes"));
    const newer = (C.activity || []).filter((a) => toMs(a.ts) > seen).length + recentPush.filter((e) => e._at > seen).length;
    const unread = seen ? newer : fromState ?? newer;
    d.classList.toggle("hidden", !(unread > 0));
  }
  function openBell() {
    haptic();
    localStorage.setItem(SEEN, String(Date.now())); bellDot();
    const rows = (C.activity || []).slice(0, 15);
    sheet(`<h3>Notifications</h3><p>Notifications go to your Discord. Tonight's pushes:</p>` +
      (rows.length ? `<div class="group plain act" style="max-height:55vh;overflow:auto">${activityRows(rows)}</div>` : emptyBox("bell", "Nothing yet tonight", "")),
      (sh, close) => sh.addEventListener("click", (ev) => { const a = ev.target.closest("[data-href]"); if (a && a.dataset.href) { close(); location.hash = a.dataset.href; } }));
  }
  function searchResults(v) {
    const raw = $("#h-q", v).value.trim(), q = raw.toLowerCase(), box = $("#h-results", v);
    if (!q) { box.innerHTML = ""; return; }
    const seen = new Map(); const add = (c) => { if (c && c.mint && !seen.has(c.mint)) seen.set(c.mint, c); };
    (C.activity || []).forEach(add); Object.values(C.coin).forEach(add);
    const A = agentsOf(C.state); ((A.scanner && A.scanner.feed) || []).forEach(add);
    const hits = Array.from(seen.values()).filter((c) => [c.name, c.symbol, c.mint].some((s) => String(s || "").toLowerCase().includes(q))).slice(0, 8);
    const mintLike = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw);
    box.innerHTML = `<div class="group">${hits.map((c) => `<div class="row tap" data-href="#/coin/${esc(encodeURIComponent(c.mint))}">${avatar(c)}<div class="main"><div class="t">${esc(coinName(c))}</div><div class="s mono">${esc(c.mint.slice(0, 6) + "…" + c.mint.slice(-4))}</div></div>${icon("chev", "chev")}</div>`).join("") ||
      (mintLike ? `<div class="row tap" data-href="#/coin/${esc(encodeURIComponent(raw))}"><div class="main"><div class="t">Open this mint</div></div>${icon("chev", "chev")}</div>` : `<div class="row"><div class="main s">No coin on the desk tonight matches. Paste a mint to open it.</div></div>`)}</div>`;
  }

  /* ================================================================ activity rows (strings are final from the desk) */
  function activityRows(list) {
    return list.map((a) => {
      const kind = String(a.kind || "").toLowerCase();
      const title = a.title || cap(kind) + " " + coinName(a);
      const sub = a.subtitle || [cap(a.agent), fmtTime(a.ts)].filter(Boolean).join(" · ");
      const vs = String(a.value ?? "").split(/\s+·\s+/);
      const vc = { green: "green", red: "red", secondary: "muted" }[a.valueColor] || (kind === "rejected" ? "muted" : "");
      const badge = { bought: "var(--blue)", sold: "var(--green)", stopped: "var(--red)", rejected: "var(--muted2)" }[kind] || "var(--card2)";
      const target = a.target || (kind === "rejected" ? "audit" : "coin");
      const href = a.mint ? `#/${target}/${encodeURIComponent(a.mint)}` : "";
      return `<div class="row tap" data-href="${esc(href)}" data-id="${esc(a.id ?? "")}"><div class="av">${safeUrl(a.image) ? `<img src="${esc(a.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${initials(a.symbol || a.name)}</span><i class="sub" style="background:${badge}"></i></div>
        <div class="main"><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div>
        <div class="v"><div class="${vc}">${esc(vs[0])}</div>${vs[1] ? `<div class="s">${esc(vs.slice(1).join(" · "))}</div>` : ""}</div></div>`;
    }).join("");
  }
  function activityList(list, n) {
    if (!list) return `<div class="group plain">${Array.from({ length: n || 5 }, () => `<div class="row"><div class="skel" style="width:40px;height:40px;border-radius:50%;flex:none"></div><div class="main">${sk(14, "55%", 6)}${sk(11, "35%", 6, 6)}</div>${sk(14, "60px", 6)}</div>`).join("")}</div>`;
    if (!list.length) return `<div class="card">${emptyBox("moon", "Nothing yet tonight", "Buys, exits and rejects show up here as they happen.")}</div>`;
    return `<div class="group act">${activityRows(n ? list.slice(0, n) : list)}</div>`;
  }
  document.addEventListener("click", (e) => { const r = e.target.closest(".act [data-href], #h-results [data-href]"); if (r && r.dataset.href && !r.closest(".sheet")) { haptic(); location.hash = r.dataset.href; } });

  function activityScreen(v) {
    v.innerHTML = `<header class="hdr"><div class="title"><span>Activity</span></div>${paperBadge()}</header><div class="offline-slot"></div><div id="a-list"></div><div class="foot" id="a-more"></div>`;
    let more = false, extra = [];
    async function load() { await loadActivity(); more = C.activity.length >= 30; if (!C.state) loadState().catch(() => {}); }
    function update() {
      const box = $("#a-list", v);
      if (!C.activity) { box.innerHTML = `<div class="sec" style="margin-top:8px">${activityList(null, 8)}</div>`; return; }
      const arr = C.activity.concat(extra.filter((x) => !C.activity.some((y) => y.id === x.id && x.id !== undefined)));
      if (!arr.length) { box.innerHTML = `<div class="sec" style="margin-top:8px">${activityList([])}</div>`; $("#a-more", v).innerHTML = ""; return; }
      const today = new Date().toDateString(); const groups = []; let last = null;
      for (const a of arr) { const ms = toMs(a.ts); const d = ms ? new Date(ms) : null; const key = d ? d.toDateString() : "";
        if (key !== last) { groups.push({ label: key === today ? "Tonight" : d ? d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }) : "", rows: [] }); last = key; }
        groups[groups.length - 1].rows.push(a); }
      box.innerHTML = groups.map((g) => `<div class="day">${esc(g.label)}</div><div class="sec" style="margin-top:0"><div class="group act">${activityRows(g.rows)}</div></div>`).join("");
      $("#a-more", v).innerHTML = more ? `<button class="btn ghost" id="a-load">Load more</button>` : "That's everything tonight";
      const b = $("#a-load", v);
      if (b) b.onclick = async () => {
        b.classList.add("busy");
        try { const lastTs = arr[arr.length - 1].ts; const d = await api("/api/activity?limit=30&before=" + encodeURIComponent(lastTs)); if (Array.isArray(d)) { extra = extra.concat(d); more = d.length >= 30; } }
        catch (_) { toast({ title: "Couldn't load more", kind: "err" }); }
        update();
      };
    }
    return { load, update };
  }

  /* ================================================================ AGENTS TAB */
  function agentsScreen(v, focus) {
    v.innerHTML = `<header class="hdr"><div class="title"><span>Agents</span></div>${paperBadge()}</header><div class="offline-slot"></div><div class="sec" style="margin-top:8px" id="g-list"></div>`;
    let scrolled = !focus;
    async function load() {
      await loadState();
      await Promise.allSettled(AGENTS.map((a) => api(`/api/agents/${a.key}/decisions`).then((d) => (C.agent[a.key] = d)).catch((e) => { if (e && e.status === 404) C.agent[a.key] = { decisions: [] }; })));
    }
    function update() {
      const st = C.state, A = agentsOf(st), box = $("#g-list", v);
      if (!st) { box.innerHTML = AGENTS.map(() => `<div class="agent-big">${sk(44, "60%")}${sk(14, "40%", 6, 12)}${sk(120, "100%", 10, 12)}</div>`).join(""); return; }
      box.innerHTML = AGENTS.map((a) => {
        const c = A[a.key], dd = C.agent[a.key], paused = agentPaused(a.key, c ? Object.assign({}, c, dd && typeof dd.paused === "boolean" ? { paused: dd.paused } : {}) : null);
        const locked = a.key === "risk" && !paused && !!((c && c.locked) || (dd && dd.locked) || openPositions(st) > 0);
        const D = dd ? (Array.isArray(dd) ? dd : dd.decisions || []) : null;
        const count = pick(dd || {}, "todayCount") ?? pick(c || {}, "todayCount");
        return `<div class="agent-big" id="ag-${a.key}">
          <div class="top"><div class="aicon" style="background:${a.bg};color:${a.color}">${icon(a.ic)}</div>
            <div style="flex:1"><div style="font-weight:700;font-size:17px">${a.name}</div>${statusDot(a.key, c)}</div>
            <div class="cnt"><b class="num">${fmtInt(count)}</b><span>today</span></div>
            <button class="sw ${paused === false ? "on" : ""} ${locked ? "locked" : ""}" role="switch" aria-checked="${paused === false}" aria-label="${a.name} running" data-sw="${a.key}" ${c ? "" : "disabled"}></button></div>
          ${locked ? `<div class="lockline">${icon("lock")} Locked while a position is open</div>` : ""}
          <div class="sec-h" style="margin:14px 0 6px"><h2 style="font-size:15px">Last 20 decisions</h2><button class="link tap" data-set="${a.key}">Settings ${icon("chev")}</button></div>
          ${D === null ? sk(100) : !D.length ? `<div class="muted" style="font-size:14px;padding:8px 0 4px">${a.key === "scanner" ? "Listening for graduations" : "No decisions yet tonight"}</div>`
            : `<div class="dec">${D.slice(0, 20).map((d) => { const vd = String(d.verdict || ""); const good = /pass|bought|sent|trail/i.test(vd); const bad = /kill|reject|drop|stop|missed|pulled/i.test(vd);
                const u = safeUrl(linkOf(d));
                return `<div class="drow"><span class="tm num">${esc(fmtTime(d.ts))}</span>
                <span class="cn">${u ? `<a class="blue" href="${esc(u)}" target="_blank" rel="noopener">${esc(coinName(d))}</a>` : esc(coinName(d))}<small>${esc(d.reason || "")}</small></span>
                <span class="chip ${good ? "green" : bad ? "red" : "grey"}">${esc(vd || "n/a")}</span></div>`; }).join("")}</div>`}
        </div>`;
      }).join("");
      if (!scrolled) { const el = $("#ag-" + focus, v); if (el) { v.scrollTop = el.offsetTop - 70; scrolled = true; } }
      box.onclick = async (e) => {
        const s = e.target.closest("[data-set]"); if (s) { haptic(); location.hash = "#/account/" + s.dataset.set; return; }
        const sw = e.target.closest("[data-sw]"); if (!sw || sw.classList.contains("busy")) return;
        const key = sw.dataset.sw, nm = AGENTS.find((x) => x.key === key).name;
        const wasPaused = !sw.classList.contains("on");
        if (sw.classList.contains("locked")) { haptic(); toast({ title: "Risk can't pause now", sub: "Not while a position is open", kind: "warn" }); return; }
        sw.classList.toggle("on", wasPaused); sw.classList.add("busy");
        const r = await post(null, `/api/agents/${key}/${wasPaused ? "resume" : "pause"}`, {}, { ok: wasPaused ? `Resuming ${nm}` : `Pausing ${nm}` });
        sw.classList.remove("busy");
        if (r) PENDING.set("pause:" + key, { value: !wasPaused, until: Date.now() + 20000 });
        else sw.classList.toggle("on", !wasPaused);
        update();
      };
    }
    return { load, update };
  }

  /* ================================================================ COIN */
  function coinScreen(v, mint) {
    v.innerHTML = `<header class="hdr"><button class="back tap" id="c-back">${icon("back")}Back</button><div style="flex:1"></div><span id="c-badge"></span></header>
      <div class="offline-slot"></div><div id="c-body"></div><div class="actionbar" id="c-bar"></div>`;
    $("#c-back", v).onclick = () => { haptic(); history.length > 1 ? history.back() : (location.hash = "#/"); };
    let candles = null, notFound = false;
    async function load() {
      try { C.coin[mint] = await api("/api/coin/" + encodeURIComponent(mint)); notFound = false; }
      catch (e) { if (e && e.status === 404) notFound = true; else throw e; }
      if (!C.state) loadState().catch(() => {});
    }
    function update() {
      const c = C.coin[mint], body = $("#c-body", v), bar = $("#c-bar", v);
      $("#c-badge", v).innerHTML = c ? (c.paper === false ? "" : c.paper ? `<span class="badge paper">PAPER</span>` : paperBadge()) : paperBadge();
      if (!c) {
        if (notFound) { body.innerHTML = emptyBox("search", "No data for this coin yet", "The desk hasn't looked at this mint tonight."); bar.innerHTML = ""; return; }
        body.innerHTML = `<div class="coin-h"><div class="skel" style="width:48px;height:48px;border-radius:50%;flex:none"></div><div style="flex:1">${sk(20, "50%")}${sk(12, "35%", 6, 6)}</div></div><div class="sec">${sk(60, "70%", 12)}${sk(260, "100%", 12, 16)}${sk(120, "100%", 16, 16)}</div>`;
        bar.innerHTML = `<div class="skel" style="height:50px;border-radius:14px"></div>`; return;
      }
      const pos = c.position && c.position.status !== "closed" ? c.position : null;
      const ex = c.exit || null;
      if (!$("#c-candles", v)) {
        body.innerHTML = `<div class="coin-h">${avatar(c, "lg")}<div style="flex:1;min-width:0"><div class="nm" id="c-nm"></div><div class="s" id="c-sub"></div></div><button class="chip tap shield" id="c-shield"></button></div>
          <div class="pricerow"><div class="price" id="c-price"></div></div><div class="price-sub" id="c-since"></div>
          <div class="candle-wrap"><canvas id="c-candles"></canvas><div class="chart-empty hidden" id="c-cempty">Candles start after 2 minutes of price data</div></div>
          <div class="sec" style="margin-top:6px"><div class="card stats" id="c-stats"></div></div><div class="sec" id="c-pos"></div>`;
        candles = new Charts.Candles($("#c-candles", v));
        $("#c-shield", v).onclick = () => { haptic(); location.hash = "#/audit/" + encodeURIComponent(mint); };
      }
      $("#c-nm", v).textContent = coinName(c);
      $("#c-sub", v).textContent = c.subtitle || [c.symbol, c.chain || "Solana", c.ageText].filter(Boolean).join(" · ");
      const sh = $("#c-shield", v);
      sh.className = "chip tap shield " + (c.auditPassed === true ? "green" : c.auditPassed === false ? "red" : "grey");
      sh.innerHTML = `${icon("auditor")}${esc(c.shield || "–/8")}`;
      const pe = $("#c-price", v); pe.textContent = fmtPrice(c.price); fitText(pe, 66, 34);
      const se = num(c.sinceEntryPct);
      $("#c-since", v).innerHTML = pos && se !== null ? `<span class="${se < 0 ? "red" : "green"}">${se < 0 ? "▼" : "▲"} ${esc(Math.abs(se).toFixed(1))}% since entry</span>`
        : c.change && has(c.change.h1) ? `<span class="${c.change.h1 < 0 ? "red" : "green"}">${c.change.h1 < 0 ? "▼" : "▲"} ${esc(Math.abs(c.change.h1).toFixed(1))}%</span> <span class="muted">1h</span>` : "";
      const cd = (c.candles || []).map((q) => Array.isArray(q) ? q : [toMs(q.t), q.o, q.h, q.l, q.c, q.v]);
      $("#c-cempty", v).classList.toggle("hidden", cd.length >= 2);
      const entry = pos ? num(pos.entryPrice) : null;
      const le = c.lastExit;
      const exitP = !pos && le ? num(le.exitPrice) : null;
      candles.setData(cd, { entry, entryLabel: entry !== null ? "Bought " + fmtPrice(entry) : null,
        stop: pos && ex ? num(ex.exitLine) : null, stopLabel: "Risk · trailing stop",
        exit: exitP, exitNeg: le && num(le.pnlUsd) < 0, exitLabel: exitP !== null ? (num(le.pnlUsd) < 0 ? "" : "+") + fmtSigned(le.pnlUsd).replace(/^\+/, "") : null,
        priceLabel: fmtPrice(c.price) });
      const s = c.stats || {};
      $("#c-stats", v).innerHTML = [["Market cap", fmtCompact(s.marketCap)], ["Liquidity", fmtCompact(s.liquidityUsd)], ["24h volume", fmtCompact(s.volumeH24)], ["Holders", fmtInt(s.holders)]]
        .map(([k, val]) => `<div>${k}<b>${esc(val)}</b></div>`).join("");
      const value = pos && has(pos.sizeUsd) && has(pos.pnlUsd) ? +pos.sizeUsd + +pos.pnlUsd : null;
      $("#c-pos", v).innerHTML = pos ? `
        <div class="card pos"><div class="aicon" style="background:var(--green-d);color:var(--green)">${icon("executor")}</div>
          <div class="main"><div style="font-weight:700">Your position</div><div class="muted" style="font-size:13px">${esc(pos.label || fmtUsd(pos.sizeUsd) + " in · Executor")}${pos.status === "exiting" ? ' · <span class="red">exiting</span>' : ""}</div></div>
          <div class="val">${esc(fmtUsd(value))}<div class="${num(pos.pnlUsd) < 0 ? "red" : "green"}" style="font-size:13px">${esc(fmtSigned(pos.pnlUsd))} · ${esc(fmtPct(pos.pct, 1))}</div></div></div>
        ${ex ? `<div class="card" style="margin-top:10px"><div class="pos" style="margin-bottom:6px"><div class="aicon" style="background:var(--pink-d);color:var(--pink)">${icon("risk")}</div><div class="main"><div style="font-weight:700">Risk · ${ex.trailActive ? "trailing stop" : "stop armed"}</div><div class="muted" style="font-size:13px">exits at ${esc(fmtPrice(ex.exitLine))}</div></div></div>
          <div class="kv"><span>Stop line</span><b>${esc(fmtPrice(ex.stopPrice))} <span class="tpill red">-${esc(ex.stopPct ?? "n/a")}%</span></b></div>
          <div class="kv"><span>Trail line</span><b>${ex.trailActive ? esc(fmtPrice(ex.trailPrice)) + ` <span class="tpill green">trail ${esc(ex.trailPct ?? "")}%</span>` : `<span class="muted">starts at ${esc(fmtPrice(ex.trailStartPrice))}</span>`}</b></div>
          <div class="kv"><span>Time left to timeout</span><b>${esc(fmtLeft(has(ex.timeoutAt) ? (toMs(ex.timeoutAt) - Date.now()) / 1000 : ex.timeLeftS))}</b></div></div>` : ""}` : "";
      // Bottom buttons. coin_url is used verbatim from the API, never built here.
      const xb = (agentsOf(C.state).executor || {}).bar;
      const sig = SIGNALS.get(mint) || (c.signal && (!c.signal.status || c.signal.status === "sent") ? c.signal : null) || (!pos && xb && xb.mint === mint && xb.status === "waiting" ? { mint, name: xb.name } : null);
      const exiting = pos && (pos.status === "exiting" || EXITS.has(mint));
      const sell = c.button ? c.button === "sell" : !!pos;
      let html = sell
        ? (exiting ? `<div class="btn-row"><button class="btn red" data-fomo style="flex:2">Sell on FOMO</button><button class="btn blue" data-act="Sold">Sold</button></div>` : `<button class="btn red full" data-fomo>Sell on FOMO</button>`)
        : (sig ? `<div class="btn-row"><button class="btn green" data-fomo style="flex:2">Buy on FOMO</button><button class="btn blue" data-act="Bought">Bought</button><button class="btn ghost" data-act="Skip">Skip</button></div>` : `<button class="btn green full" data-fomo>Buy on FOMO</button>`);
      bar.innerHTML = safeUrl(c.coin_url) ? html : `<button class="btn ghost full" disabled>No FOMO link from the desk</button>`;
      bar.onclick = (e) => { if (e.target.closest("[data-fomo]")) return openExternal(c.coin_url);
        const a = e.target.closest("[data-act]"); if (a) coinAction(a, Object.assign({ mint, name: c.name, symbol: c.symbol, positionId: pos && pos.id }, sig || {}), a.dataset.act); };
    }
    return { load, update, unmount: () => candles && candles.destroy() };
  }

  /* ================================================================ AUDITOR */
  const LAYERS = ["Mint authority", "Freeze authority", "Dev wallet", "Top 10 holders", "Liquidity", "Pool age", "Bundled wallets", "Delegations"];
  let liveAudit = null;
  function auditScreen(v, mint) {
    v.innerHTML = `<header class="hdr"><button class="back tap" id="u-back">${icon("back")}Back</button><div class="title center"><span>Auditor</span></div><div class="hdr-r">${paperBadge()}</div></header>
      <div class="offline-slot"></div><div id="u-body"></div><div class="actionbar" id="u-bar"></div>`;
    $("#u-back", v).onclick = () => { haptic(); history.length > 1 ? history.back() : (location.hash = "#/"); };
    let notFound = false, shown = 0, beamAt = -1, timer = 0, revealed = [];
    const A = () => C.audit[mint];
    const layer = (i) => { const a = A(); const L = (a && a.layers) || []; return L.find((x) => +x.n === i + 1) || null; };
    const known = (l) => l && (l.pass === true || l.pass === false || (l.pass === null && /not checked/i.test(l.value || "")));
    async function load() {
      if (!C.settings) loadSettings().catch(() => {});
      if (!mint) {
        await loadState();
        const au = agentsOf(C.state).auditor; const cm = au && (au.current || au.last);
        if (cm && cm.mint) { location.replace("#/audit/" + encodeURIComponent(cm.mint)); return; }
        notFound = true; return;
      }
      try { C.audit[mint] = await api("/api/audit/" + encodeURIComponent(mint)); notFound = false; }
      catch (e) { if (e && e.status === 404) notFound = true; else throw e; }
    }
    liveAudit = (ev) => {
      if (!mint || ev.mint !== mint) return;
      const a = C.audit[mint] = C.audit[mint] || { mint, name: ev.name, symbol: ev.symbol, status: "running", passed: null, layers: [] };
      const l = ev.layer || { n: ev.n, pass: ev.pass, value: ev.value, name: ev.name };
      a.layers = (a.layers || []).filter((x) => +x.n !== +(l.n ?? ev.n)).concat([Object.assign({ n: ev.n }, l)]);
      if (ev.done) a.status = "done";
      notFound = false; update();
    };
    function tick() {
      // Beam: 350ms per layer top -> bottom, then 150ms to green/red. Waits on a layer the server hasn't sent.
      if (timer || !A()) return;
      if (RM()) { for (let i = 0; i < 8; i++) revealed[i] = known(layer(i)); shown = 8; beamAt = -1; paint(); return; }
      while (shown < 8 && known(layer(shown)) && layer(shown).pass !== true && layer(shown).pass !== false) { revealed[shown] = true; shown++; } // "not checked" after a red layer: no beam
      if (shown >= 8) { beamAt = -1; paint(); return; }
      beamAt = shown; paint();
      timer = setTimeout(() => {
        timer = 0;
        if (!known(layer(shown))) return; // wait; SSE audit_layer or the next poll re-enters update() -> tick()
        revealed[shown] = true; paint();
        timer = setTimeout(() => { timer = 0; shown++; tick(); }, 150);
      }, 350);
    }
    function paint() {
      const a = A() || {}, box = $("#u-discs", v); if (!box) return;
      $$(".disc", box).forEach((d, i) => {
        const l = layer(i), r = revealed[i] && l;
        const skip = r && l.pass !== true && l.pass !== false;
        d.className = "disc" + (r ? (l.pass === true ? " pass" : l.pass === false ? " fail" : " skip") : "") + (i === beamAt ? " beam" : "");
        d.querySelector("span").innerHTML = r && !skip ? icon(l.pass ? "check" : "x") : String(i + 1);
      });
      const bl = $("#u-beam", v);
      if (beamAt >= 0) { const d = $$(".disc", box)[beamAt]; bl.style.top = d.offsetTop + d.offsetHeight / 2 + "px"; bl.classList.add("on"); } else bl.classList.remove("on");
      $("#u-rows", v).innerHTML = LAYERS.map((nm, i) => { const l = layer(i), r = revealed[i] && l;
        const st = !r ? "nodata" : l.pass === true ? "pass" : l.pass === false ? "fail" : "nodata";
        const val = !r ? (i === beamAt ? "reading..." : "") : l.pass === null || l.pass === undefined ? "not checked" : l.value ?? "";
        return `<div class="row lay ${r && st === "nodata" ? "dim" : ""}"><div class="ic ${st}">${r && l.pass === true ? "✓" : r && l.pass === false ? "✕" : i + 1}</div><div class="main"><div class="t">${esc((l && l.name) || nm)}</div>${r && l.source ? `<div class="s">${esc(l.source)}</div>` : ""}</div>
          <div class="v ${st === "fail" ? "red" : st === "nodata" ? "muted" : ""}">${esc(val)}</div></div>`; }).join("");
      const done = a.status !== "running" && (a.passed === true || a.passed === false) && shown >= 8;
      const res = $("#u-res", v);
      res.innerHTML = !done ? `<div class="verdict"><div class="big" style="background:var(--cyan-d);color:var(--cyan)">${icon("auditor")}</div><div><div style="font-weight:700;font-size:18px">Taking apart...</div><div class="muted">${Math.min(shown, 8)}/8 parts read</div></div></div>`
        : a.passed ? `<div class="verdict"><div class="big" style="background:var(--green-d);color:var(--green)">${icon("check")}</div><div><div style="font-weight:700;font-size:18px">${esc(a.headline || "Cleared · 8/8 parts")}</div><div class="muted">${esc(a.subline || "Sent to Analyst")}</div></div></div>`
        : `<div class="verdict"><div class="big" style="background:var(--red-d);color:var(--red)">${icon("x")}</div><div><div style="font-weight:700;font-size:18px">${esc(a.headline || "Rejected · " + (a.reason || ""))}</div><div class="muted">${esc(a.subline || "Desk won't buy " + coinName(a))}</div></div></div>`;
    }
    function update() {
      const body = $("#u-body", v), bar = $("#u-bar", v), a = A();
      const en = settingVal("auditor.enabled") ?? (a && a.enabled);
      const toggle = `<div class="sec"><div class="group plain"><div class="row"><div class="main"><div class="t">Take apart before buying</div><div class="s">Auditor reads all 8 parts first</div></div>
        <button class="sw ${en === true ? "on" : ""}" role="switch" aria-checked="${en === true}" id="u-en" ${en === undefined ? "disabled" : ""}></button></div></div></div>`;
      if (notFound || (!mint && !a)) {
        if (!notFound && !C.state) { body.innerHTML = `<div class="sec">${sk(250, "100%", 16)}</div>`; bar.innerHTML = ""; return; }
        body.innerHTML = `<div class="sec"><div class="card">${emptyBox("auditor", "No coin taken apart yet", "When Scanner passes a coin, the Auditor takes it apart here, layer by layer.")}</div></div>` + toggle; bar.innerHTML = ""; wireToggle(); return;
      }
      if (!a) { body.innerHTML = `<div class="sec">${sk(250, "100%", 16)}${sk(300, "100%", 16, 16)}</div>`; bar.innerHTML = `<div class="skel" style="height:50px;border-radius:14px"></div>`; return; }
      if (!$("#u-discs", v)) {
        body.innerHTML = `<div class="aud-h"><div style="font-weight:700;font-size:22px" id="u-nm"></div><div class="muted mono" style="font-size:12px" id="u-mint"></div></div>
          <div class="discs" id="u-discs"><div class="coin-ic" id="u-ic"></div>${LAYERS.map((_, i) => `<div class="disc" style="--i:${i}"><span>${i + 1}</span></div>`).join("")}<div class="beam-line" id="u-beam"></div></div>
          <div class="sec" style="margin-top:12px"><div class="card" id="u-res"></div></div><div class="sec"><div class="group" id="u-rows"></div></div><div id="u-tg"></div>`;
        revealed = []; shown = 0;
      }
      $("#u-nm", v).textContent = coinName(a);
      $("#u-mint", v).textContent = mint.slice(0, 6) + "…" + mint.slice(-4);
      $("#u-ic", v).innerHTML = safeUrl(a.image) ? `<img src="${esc(a.image)}" alt="" referrerpolicy="no-referrer">` : `<span>${initials(a.symbol || a.name)}</span>`;
      $("#u-tg", v).innerHTML = toggle;
      bar.innerHTML = safeUrl(a.coin_url) ? `<button class="btn blue full" data-fomo>Open on FOMO</button>` : `<button class="btn ghost full" disabled>No FOMO link from the desk</button>`;
      bar.onclick = (e) => { if (e.target.closest("[data-fomo]")) openExternal(a.coin_url); };
      wireToggle(); paint(); tick();
    }
    function wireToggle() {
      const sw = $("#u-en", v); if (!sw) return;
      sw.onclick = () => toggleAuditor(sw);
    }
    return { load, update, unmount: () => { clearTimeout(timer); liveAudit = null; } };
  }
  async function toggleAuditor(sw) {
    const on = sw.classList.contains("on");
    haptic();
    if (on) { // turning the Auditor off asks twice
      if (!(await confirmSheet("Turn off the Auditor?", "Coins would go to the Analyst without the 8 safety checks.", "Turn off"))) return;
      if (!(await confirmSheet("Are you sure?", "Rugs, open mint authority and bundled wallets would no longer be stopped. You can turn it back on any time.", "Yes, turn it off"))) return;
    }
    sw.classList.toggle("on", !on); sw.classList.add("busy");
    const r = await saveSetting(null, "auditor.enabled", !on, on ? "Auditor off" : "Auditor on");
    sw.classList.remove("busy"); if (!r) sw.classList.toggle("on", on);
  }

  /* ================================================================ ACCOUNT */
  // Fallback for STEP 10 keys if the desk sends no meta (labels, ranges). The desk validates again.
  const SCHEMA = {
    scanner: ["Scanner", [["min_liquidity_usd", "Min liquidity", "int", 0, 500000, 1000, "$"], ["max_top10_pct", "Max top 10 holders", "float", 1, 100, 1, "%"], ["max_h1_change_pct", "Max 1h change", "float", 0, 1000, 5, "%"], ["poll_s", "Poll every", "int", 15, 600, 5, "s"], ["min_pool_age_min", "Min pool age", "int", 0, 240, 1, "min"], ["max_wait_min", "Max wait", "int", 5, 480, 5, "min"], ["runner_h24_pct", "Runner 24h change", "float", 50, 5000, 10, "%"]]],
    auditor: ["Auditor", [["enabled", "Take apart before buying", "bool"], ["max_dev_pct", "Max dev holds", "float", 0, 100, 0.5, "%"], ["max_top10_pct", "Max top 10 holders", "float", 1, 100, 1, "%"], ["min_lp_locked_pct", "Min LP locked", "float", 0, 100, 1, "%"], ["min_pool_age_min", "Min pool age", "int", 0, 240, 1, "min"], ["max_bundled", "Max bundled wallets", "int", 0, 100, 1, ""], ["max_delegated_accounts", "Max delegated accounts", "int", 0, 1000, 1, ""], ["retries", "Retries", "int", 0, 10, 1, ""]]],
    analyst: ["Analyst", [["mode", "Mode", "enum", null, null, null, "", ["rules", "jev"]], ["min_alive_6h", "Min alive 6h", "float", 0, 1, 0.01, ""], ["min_organic", "Min organic", "float", 0, 1, 0.01, ""], ["max_chase", "Max chase", "float", 0, 1, 0.01, ""], ["min_score", "Min score", "int", 0, 100, 1, ""], ["timeout_s", "Timeout", "int", 1, 60, 1, "s"]]],
    "analyst.rules": ["Analyst rules", [["alive_volume_h1", "Alive volume 1h", "int", 0, 1000000, 500, "$"], ["organic_buys_h1", "Organic buys 1h", "int", 1, 5000, 5, ""], ["bundled_penalty", "Bundled penalty", "float", 0, 1, 0.05, ""], ["flush_drop_m5_pct", "Flush drop 5m", "float", 0, 50, 0.5, "%"], ["chase_h1_pct", "Chase 1h", "float", 1, 1000, 5, "%"]]],
    executor: ["Executor", [["stack_pct", "Ticket size", "float", 0.5, 100, 0.5, "%"], ["max_pool_pct", "Max of pool", "float", 0.1, 20, 0.1, "%"], ["min_ticket_usd", "Min ticket", "float", 1, 1000, 0.5, "$"], ["below_min", "Below min ticket", "enum", null, null, null, "", ["bump", "skip"]], ["recheck_liq_drop_pct", "Recheck liquidity drop", "float", 1, 100, 1, "%"], ["recheck_price_up_pct", "Recheck price up", "float", 1, 200, 1, "%"], ["confirm_window_min", "Confirm window", "int", 1, 60, 1, "min"]]],
    risk: ["Risk", [["poll_s", "Poll every", "int", 5, 120, 1, "s"], ["stop_pct", "Stop loss", "float", 1, 50, 0.5, "%"], ["trail_start_pct", "Trail starts at", "float", 1, 500, 1, "%"], ["trail_pct", "Trail", "float", 1, 80, 0.5, "%"], ["timeout_h", "Timeout", "float", 0.5, 48, 0.5, "h"], ["timeout_min_gain_pct", "Timeout min gain", "float", 0, 100, 0.5, "%"], ["confirm_window_min", "Confirm window", "int", 1, 30, 1, "min"]]],
    desk: ["Desk", [["paper_start_stack", "Paper start stack", "float", 10, 100000, 10, "$"], ["report_time", "Morning report", "time"], ["push_rejects", "Push rejects", "bool"], ["fees_ref_discount", "Fee ref discount", "float", 0, 1, 0.01, ""], ["rpc_url", "RPC URL", "str"], ["notifier", "Notifier", "str"], ["fomo_handle", "FOMO handle", "str"]]],
  };
  const READONLY = new Set(["desk.mode", "desk.fomo_handle", "desk.notifier"]);
  function settingGroups() {
    const S = C.settings || {};
    const ids = Array.isArray(S.groups) && S.groups.length ? S.groups : Object.keys(SCHEMA).map((id) => ({ id }));
    return ids.map((g) => {
      const fb = SCHEMA[g.id] || [cap(g.id), []];
      const keys = g.keys || fb[1].map((k) => g.id + "." + k[0]);
      return { id: g.id, title: g.title || fb[0], rows: keys.filter((p) => p !== "desk.mode").map((p) => {
        const k = p.slice(g.id.length + 1), f = (fb[1].find((x) => x[0] === k) || []);
        const m = metaOf(p) || {};
        return { path: p, label: m.label || f[1] || k, type: m.type || f[2] || "float", min: m.min ?? f[3], max: m.max ?? f[4], step: m.step ?? f[5] ?? (m.type === "int" ? 1 : 0.01),
          unit: m.unit ?? f[6] ?? "", options: m.options || f[7], readonly: m.readonly || READONLY.has(p) };
      }) };
    });
  }
  async function saveSetting(btn, path, value, label) {
    const old = settingVal(path);
    PENDING.set("set:" + path, { value, until: Date.now() + 20000 });
    const r = await post(btn, "/api/settings", { [path]: value }, { ok: label || `${path} · ${old ?? "n/a"} → ${value}`, okSub: "Saved · the desk applies it now" });
    if (!r) PENDING.delete("set:" + path);
    return r;
  }
  function accountScreen(v, focus) {
    v.innerHTML = `<header class="hdr"><div class="title"><span>Account</span></div><span id="x-badge"></span></header><div class="offline-slot"></div><div id="x-body"></div>`;
    async function load() { await all([loadAccount(), loadSettings()]); if (!C.state) loadState().catch(() => {}); }
    let built = false;
    function update() {
      const A = C.account, body = $("#x-body", v);
      $("#x-badge", v).innerHTML = A ? (A.paper ? `<span class="badge paper">PAPER</span>` : "") : paperBadge();
      if (!A) { body.innerHTML = `<div class="sec" style="margin-top:8px">${sk(104, "100%", 12)}${sk(104, "100%", 16, 16)}${sk(300, "100%", 16, 16)}</div>`; return; }
      const ae = document.activeElement;
      if (built && ae && ae.closest && ae.closest("#x-body") && ae.tagName === "INPUT") return; // never clobber typing
      const m = String(A.mode || mode()).toUpperCase();
      const n = A.notifier || {};
      const tc = A.ticketCheck;
      const sy = v.scrollTop;
      body.innerHTML = `
        <div class="sec" style="margin-top:8px"><div class="group plain">
          <div class="row"><div class="main"><div class="t">Mode</div><div class="s">${m === "LIVE" ? "Real money · you buy on FOMO" : "Simulated · nothing real moves"}</div></div>
            <div class="seg" style="width:156px"><button class="${m === "PAPER" ? "on paper" : ""}" data-mode="PAPER">PAPER</button><button class="${m === "LIVE" ? "on live" : ""}" data-mode="LIVE">LIVE</button></div></div>
          <div class="row"><div class="main"><div class="t">Stack</div><div class="s">${m === "LIVE" ? "Live stack · now " + esc(fmtUsd(A.stack)) : "Paper start · now " + esc(fmtUsd(A.stack))}</div></div>
            <span class="pre">$</span><input class="numf" id="x-stack" type="number" inputmode="decimal" step="1" min="1" value="${esc(m === "LIVE" ? A.liveStack ?? "" : A.paperStartStack ?? "")}" placeholder="n/a" aria-label="Stack in dollars"><button class="btn sm blue" id="x-stack-save">Save</button></div>
          ${tc && tc.message ? `<div class="row"><div class="main s ${tc.level === "warn" ? "amber" : ""}">${esc(tc.message)}</div></div>` : ""}
        </div></div>
        <div class="sec"><div class="group">
          <div class="row tap" data-url="profile"><div class="av" style="background:var(--blue-d);color:var(--blue)">${icon("account", "chev")}</div><div class="main"><div class="t">Your FOMO profile</div><div class="s">${A.fomo_handle ? "@" + esc(A.fomo_handle) : "Not linked yet"}</div></div>${icon("ext", "chev")}</div>
          <div class="row tap" data-url="invite"><div class="av" style="background:var(--green-d);color:var(--green)">${icon("share", "chev")}</div><div class="main"><div class="t">Invite a friend</div><div class="s">Share your FOMO link</div></div>${icon("chev", "chev")}</div>
        </div></div>
        <div class="sec"><div class="group"><div class="row tap" data-gotrade><div class="av" style="background:var(--red-d);color:var(--red)">${icon("executor")}</div><div class="main"><div class="t">Auto-trade wallet</div><div class="s">Mode, STOP, test orders, positions</div></div>${icon("chev", "chev")}</div></div></div>
        <div class="sec"><div class="sec-h"><h2>Notifications</h2></div><div class="group plain">
          <div class="row"><div class="av" style="background:#5865f2;color:#fff">${icon("bell", "chev")}</div><div class="main"><div class="t">${esc(n.label || cap(n.kind) || "Discord")}</div><div class="s">Notifications go to your Discord</div></div><span class="chip ${n.connected === false ? "red" : n.connected ? "green" : "grey"}">${n.connected === false ? "Not connected" : n.connected ? "Connected" : "n/a"}</span></div>
          <div class="row"><div class="main"><div class="t">Send test push</div><div class="s">${A.webPush && A.webPush.enabled === false ? "Web push is off · the desk answers in a toast" : "Sends a test notification"}</div></div><button class="btn sm blue" id="x-test">Send</button></div>
        </div></div>
        ${settingGroups().map((g) => `<div class="sec" id="set-${esc(g.id.replace(".", "-"))}"><div class="sec-h"><h2>${esc(g.title)}</h2></div><div class="group plain">${g.rows.map(settingRow).join("")}</div></div>`).join("")}
        <div class="foot">${esc(A.version || "Desk")} · ${esc(location.host)}<br>FOMO has no order API · money only moves when you buy on FOMO</div>`;
      $$("input[type=range]", body).forEach(paintRange);
      if (!built && focus) { const el = $("#set-" + focus.replace(".", "-"), v); if (el) v.scrollTop = el.offsetTop - 64; }
      else v.scrollTop = sy;
      built = true;
    }
    function settingRow(r) {
      const val = settingVal(r.path);
      const lbl = `<div class="t">${esc(r.label)}</div><div class="s mono">${esc(r.path)}</div>`;
      if (r.type === "bool") return `<div class="row"><div class="main">${lbl}</div><button class="sw ${val === true ? "on" : ""}" role="switch" aria-checked="${val === true}" data-bool="${esc(r.path)}" ${val === undefined || r.readonly ? "disabled" : ""}></button></div>`;
      if (r.type === "enum") return `<div class="row"><div class="main">${lbl}</div><div class="seg" style="width:${Math.max(120, (r.options || []).length * 64)}px">${(r.options || []).map((o) => `<button class="${val === o ? "on" : ""}" data-enum="${esc(r.path)}" data-v="${esc(o)}" ${r.readonly ? "disabled" : ""}>${esc(o)}</button>`).join("")}</div></div>`;
      if (r.type === "str" || r.type === "time" || r.min === undefined || r.min === null) return `<div class="setrow"><div class="lbl"><div>${lbl}</div></div><div class="setctl"><input class="numf txtf" data-text="${esc(r.path)}" value="${esc(val ?? "")}" placeholder="n/a" ${r.readonly ? "readonly" : ""} ${r.type === "time" ? 'type="time"' : ""} autocapitalize="off" spellcheck="false">${r.readonly ? `<span class="chip grey">read only</span>` : `<button class="btn sm ghost" data-textsave="${esc(r.path)}">Save</button>`}</div></div>`;
      const n = num(val);
      return `<div class="setrow"><div class="lbl"><div>${lbl}</div><div class="rng mono">${esc(r.min)}–${esc(r.max)}${r.unit && r.unit !== "$" ? " " + esc(r.unit) : ""}</div></div>
        <div class="setctl"><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${n ?? r.min}" data-range="${esc(r.path)}" ${n === null || r.readonly ? "disabled" : ""} aria-label="${esc(r.label)}">
        ${r.unit === "$" ? '<span class="pre">$</span>' : ""}<input class="numf" type="number" inputmode="decimal" min="${r.min}" max="${r.max}" step="${r.step}" value="${n ?? ""}" placeholder="n/a" data-num="${esc(r.path)}" data-int="${r.type === "int" ? 1 : ""}" ${n === null || r.readonly ? "disabled" : ""} aria-label="${esc(r.label)} value"></div></div>`;
    }
    const paintRange = (r) => { const p = ((+r.value - +r.min) / (+r.max - +r.min || 1)) * 100; r.style.setProperty("--p", p + "%"); };
    v.oninput = (e) => { const r = e.target.closest("[data-range]"); if (r) { paintRange(r); const nf = $(`[data-num="${r.dataset.range}"]`, v); if (nf) nf.value = r.value; } };
    v.onchange = (e) => {
      const r = e.target.closest("[data-range],[data-num]"); if (!r) return;
      const path = r.dataset.range || r.dataset.num, nf = $(`[data-num="${path}"]`, v);
      let val = +r.value; const min = +r.min, max = +r.max;
      if (r.value === "" || !isFinite(val) || val < min || val > max) { toast({ title: "Out of range", sub: `${path} must be ${min}–${max}`, kind: "err" }); const old = settingVal(path); r.value = old ?? ""; return; }
      if (nf && nf.dataset.int) val = Math.round(val);
      const other = $(r.dataset.range ? `[data-num="${path}"]` : `[data-range="${path}"]`, v); if (other) { other.value = val; if (other.type === "range") paintRange(other); }
      if (val === num(settingVal(path))) return;
      r.blur && r.dataset.num && r.blur();
      saveSetting(null, path, val);
    };
    v.onclick = async (e) => {
      const t = e.target;
      if (t.closest("[data-gotrade]")) { haptic(); location.hash = "#/trade"; return; }
      const md = t.closest("[data-mode]");
      if (md) { haptic();
        const want = md.dataset.mode, curM = String((C.account && C.account.mode) || mode()).toUpperCase(); if (want === curM) return;
        if (want === "LIVE") return liveSheet();
        if (!(await confirmSheet("Back to PAPER?", "The desk stops sending LIVE signals. Open positions keep being guarded.", "Switch to PAPER", "amber"))) return;
        return post(md, "/api/mode", { mode: "PAPER" }, { ok: "Switching to PAPER", okSub: "Simulated trades from now on" });
      }
      if (t.closest("#x-stack-save")) { const inp = $("#x-stack", v); const val = +inp.value; if (!(val > 0)) return toast({ title: "Enter a stack in dollars", kind: "err" });
        inp.blur(); const m = String((C.account && C.account.mode) || mode()).toUpperCase();
        return saveSetting(t.closest("button"), m === "LIVE" ? "desk.live_stack" : "desk.paper_start_stack", val, `Stack set to ${fmtUsd(val)}`); }
      if (t.closest("#x-test")) return post(t.closest("button"), "/api/push", { test: true, text: "Test push from the app" }, { ok: "Test push sent", okSub: "Watch your Discord channel" });
      const u = t.closest("[data-url]");
      if (u) { const A = C.account || {}; if (u.dataset.url === "profile") return openExternal(A.profile_url); return share(A.signup_url || A.SIGNUP_URL, "Trade memecoins on FOMO with my link"); }
      const b = t.closest("[data-bool]");
      if (b && !b.disabled && !b.classList.contains("busy")) {
        const path = b.dataset.bool; if (path === "auditor.enabled") return toggleAuditor(b);
        const on = b.classList.contains("on"); haptic();
        b.classList.toggle("on", !on); b.classList.add("busy"); const r = await saveSetting(null, path, !on); b.classList.remove("busy"); if (!r) b.classList.toggle("on", on); return;
      }
      const en = t.closest("[data-enum]");
      if (en && !en.disabled) { if (en.classList.contains("on")) return; haptic(); const sibs = $$(`[data-enum="${en.dataset.enum}"]`, v); const prev = sibs.find((x) => x.classList.contains("on"));
        sibs.forEach((x) => x.classList.toggle("on", x === en)); const r = await saveSetting(null, en.dataset.enum, en.dataset.v); if (!r) sibs.forEach((x) => x.classList.toggle("on", x === prev)); return; }
      const ts = t.closest("[data-textsave]");
      if (ts) { const inp = $(`[data-text="${ts.dataset.textsave}"]`, v); inp.blur();
        if (ts.dataset.textsave === "desk.rpc_url" && !/^https:\/\//.test(inp.value.trim())) return toast({ title: "RPC URL must start with https://", kind: "err" });
        return saveSetting(ts, ts.dataset.textsave, inp.value.trim()); }
    };
    function liveSheet() {
      const A = C.account || {};
      const blocked = A.liveAllowed === false;
      sheet(`<h3>Switch to LIVE</h3><p>Money only moves when you tap Buy on FOMO and buy inside FOMO. LIVE needs at least 1 full PAPER night${has(A.paperNights) ? ` (you have ${esc(A.paperNights)})` : ""}.</p>
        ${blocked ? `<div class="warnrow">${esc(A.liveBlockReason || "Not allowed yet")}</div>` : ""}
        <p style="margin-top:10px">Type <b>LIVE</b> to confirm.</p>
        <input class="txt" id="live-in" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="LIVE" aria-label="Type LIVE">
        <div class="btn-row"><button class="btn ghost" data-x>Cancel</button><button class="btn red" data-ok disabled>Switch to LIVE</button></div>`,
        (sh, close) => {
          const inp = $("#live-in", sh), ok = $("[data-ok]", sh);
          inp.addEventListener("input", () => (ok.disabled = inp.value.trim() !== "LIVE"));
          $("[data-x]", sh).onclick = close;
          ok.onclick = async () => { const r = await post(ok, "/api/mode", { mode: "LIVE", confirm: "LIVE" }, { ok: "Switching to LIVE", okSub: blocked ? "The desk may refuse: " + (A.liveBlockReason || "") : "The desk confirms in a few seconds" }); if (r) close(); };
          setTimeout(() => inp.focus(), 350);
        });
    }
    return { load, update, unmount: () => { v.onclick = v.oninput = v.onchange = null; } };
  }

  /* ================================================================ AUTO-TRADE (separate PumpPortal wallet; FOMO untouched) */
  const TRADE_PHRASE = "LIVE WALLET";
  const loadTrade = async () => { try { C.autotrade = await api("/api/autotrade"); } catch (e) { if (e && e.status === 404) C.autotrade = C.autotrade || null; else throw e; } };
  const tradeModeLabel = (m) => ({ OFF: "OFF", TEST: "TEST", LIVE_WALLET: "LIVE WALLET" }[m] || "OFF");
  const tradeChip = (m) => `<span class="chip ${m === "LIVE_WALLET" ? "red" : m === "TEST" ? "amber" : "grey"}">${esc(tradeModeLabel(m))}</span>`;
  function tradeStop(btn) {
    const T = C.autotrade || {};
    const n = (T.positions || []).length;
    return post(btn, "/api/autotrade/stop", { sellAll: false }, { ok: "Auto-trade STOPPED", okSub: "Mode OFF · no new buys" }).then((r) => {
      if (!r) return;
      if (C.autotrade) C.autotrade.mode = "OFF";
      if (cur && cur.update) cur.update();
      if (n) sheet(`<h3>Sell ${n} open position${n > 1 ? "s" : ""} too?</h3><p>Auto-trade is OFF. Open positions still have their stop and trail exits. Sell everything now at market (15% slippage)?</p>
        <div class="btn-row"><button class="btn ghost" data-x>Keep them</button><button class="btn red" data-ok>Sell all now</button></div>`,
        (sh, close) => { $("[data-x]", sh).onclick = close;
          $("[data-ok]", sh).onclick = async () => { const ok = $("[data-ok]", sh); const r2 = await post(ok, "/api/autotrade/stop", { sellAll: true }, { ok: "Selling all positions", okSub: "The desk confirms in a few seconds" }); if (r2) close(); }; });
    });
  }
  function tradeHomeCard(T) {
    if (!T) return "";
    const m = T.mode || "OFF", t = T.today || {}, pos = (T.positions || []).length;
    return `<section class="sec"><div class="sec-h"><h2>Auto-trade</h2><button class="link tap" data-go="#/trade">Open</button></div>
      <div class="group plain"><div class="row tap" data-go="#/trade"><div class="main"><div class="t">Wallet auto-trade ${tradeChip(m)}</div>
        <div class="s">Today ${esc(fmtSigned(t.total))} · ${pos} open · max ${esc(fmtUsd((T.caps || {}).maxPerTradeUsd, 0))}/trade</div></div>${icon("chev", "chev")}</div>
      ${m !== "OFF" ? `<div class="row"><button class="btn red full stopbtn" data-tstop>STOP auto-trade</button></div>` : ""}</div></section>`;
  }
  function tradeScreen(v) {
    v.innerHTML = `<header class="hdr"><button class="back tap" id="t-back">${icon("back")}Back</button><div class="title" style="flex:1;text-align:center"><span>Auto-trade</span></div><span id="t-chip"></span></header>
      <div class="offline-slot"></div><div id="t-body"></div>`;
    $("#t-back", v).onclick = () => { haptic(); history.length > 1 ? history.back() : (location.hash = "#/"); };
    async function load() { await loadTrade(); }
    function update() {
      const T = C.autotrade, body = $("#t-body", v);
      if (!T) { body.innerHTML = `<div class="sec" style="margin-top:8px">${NET.offline ? emptyBox("executor", "No auto-trade data yet", "The desk sends it with the next update") : sk(120, "100%", 14) + sk(240, "100%", 14, 14)}</div>`; return; }
      const m = T.mode || "OFF", c = T.caps || {}, w = T.wallet || {}, t = T.today || {};
      $("#t-chip", v).innerHTML = tradeChip(m);
      const lim = num(c.dailyLossLimitUsd), tot = num(t.total);
      const row = (a, b, cls = "") => `<div class="row"><div class="main"><div class="t">${a}</div></div><div class="mono ${cls}">${b}</div></div>`;
      const ordRow = (o) => `<div class="row tap" data-go="#/coin/${esc(encodeURIComponent(o.mint))}"><div class="main"><div class="t">${o.side === "buy" ? "Buy" : "Sell"} ${esc(o.symbol || (o.mint || "").slice(0, 6))} · ${esc(o.side === "buy" ? o.amount + " SOL" : o.amount)}${has(o.usd) ? " · " + esc(fmtUsd(o.usd)) : ""}</div>
          <div class="s">${esc(fmtTime(o.ts))} · ${esc(o.mode === "TEST" ? "TEST" : "WALLET")} · slip ${esc(o.slippage)}% · prio ${esc(o.priorityFee)} SOL · ${esc(o.pool)}${o.reason ? " · " + esc(o.reason) : ""}${o.error ? " · " + esc(o.error) : ""}</div></div>
          <span class="chip ${o.status === "confirmed" || o.status === "sent" ? "green" : o.status === "failed" || o.status === "refused" ? "red" : "grey"}">${esc(o.status === "test" ? "test · not sent" : o.status)}</span></div>`;
      const posRow = (p) => `<div class="row tap" data-go="#/coin/${esc(encodeURIComponent(p.mint))}"><div class="main"><div class="t">${esc(p.symbol || p.mint.slice(0, 6))} · ${esc(p.mode === "TEST" ? "TEST" : "WALLET")}</div>
          <div class="s">${esc(fmtTime(p.openedAt))} · cost ${esc(fmtUsd(p.costUsd))} · entry ${esc(fmtPrice(p.entryPrice))} · now ${esc(fmtPrice(p.lastPrice))}</div></div><div class="mono ${num(p.pnlUsd) < 0 ? "red" : "green"}">${esc(fmtSigned(p.pnlUsd))}</div></div>`;
      body.innerHTML = `
        <div class="sec" style="margin-top:8px"><button class="btn red full stopbtn" data-tstop ${m === "OFF" ? "disabled" : ""}>${m === "OFF" ? "Auto-trade is OFF" : "STOP"}</button>
          <div class="s muted" style="margin-top:6px;text-align:center">STOP turns auto-trade OFF at once. You then choose whether to sell open positions.</div></div>
        <div class="sec"><div class="sec-h"><h2>Mode</h2></div><div class="group plain">
          <div class="row"><div class="seg" style="width:100%"><button class="${m === "OFF" ? "on" : ""}" data-tmode="OFF">OFF</button><button class="${m === "TEST" ? "on paper" : ""}" data-tmode="TEST">TEST</button><button class="${m === "LIVE_WALLET" ? "on live" : ""}" data-tmode="LIVE_WALLET">LIVE WALLET</button></div></div>
          <div class="row"><div class="main s wrap">${m === "LIVE_WALLET" ? "Real orders from the wallet via PumpPortal Lightning." : m === "TEST" ? "Builds the exact order and records it. Nothing is sent." : "No new buys."} Your FOMO account is never touched.</div></div>
          ${T.kill ? `<div class="row"><div class="main s amber wrap">Kill switch tripped ${esc(fmtTime(T.kill.at))}: ${esc(T.kill.why)}</div></div>` : ""}
        </div></div>
        <div class="sec"><div class="sec-h"><h2>Today</h2></div><div class="group plain">
          ${row("Realized", esc(fmtSigned(t.realized)), num(t.realized) < 0 ? "red" : "")}
          ${row("Open (est.)", esc(fmtSigned(t.unrealized)), num(t.unrealized) < 0 ? "red" : "")}
          ${row("Total vs limit", `${esc(fmtSigned(tot))} / -${esc(fmtUsd(lim, 0))}`, tot !== null && lim && tot <= -lim * 0.75 ? "red" : "")}
        </div></div>
        <div class="sec"><div class="sec-h"><h2>Wallet</h2></div><div class="group plain">
          <div class="row"><div class="main"><div class="t">Address</div><div class="s mono wrap" style="word-break:break-all">${w.pubkey ? esc(w.pubkey) : "Not set · add the public address in Account › Auto-trade"}</div></div></div>
          ${row("Balance", w.sol !== null && w.sol !== undefined ? `${esc((+w.sol).toFixed(4))} SOL${has(w.usd) ? " · " + esc(fmtUsd(w.usd)) : ""}` : "n/a")}
          ${row("PumpPortal key", T.apiKeySaved ? '<span class="chip green">Saved on desk</span>' : '<span class="chip red">Missing</span>')}
        </div></div>
        <div class="sec"><div class="sec-h"><h2>Caps</h2><button class="link tap" data-go="#/account/trade">Edit</button></div><div class="group plain">
          ${row("Max per trade (fees in)", esc(fmtUsd(c.maxPerTradeUsd)))}
          ${row("Daily loss limit", esc(fmtUsd(c.dailyLossLimitUsd)) + " → OFF")}
          ${row("Max open positions", esc(c.maxOpenPositions))}
          ${row("SOL reserve (never spent)", esc(c.reserveSol) + " SOL")}
          ${row("Slippage · priority fee", `${esc(c.slippagePct)}% · ${esc(c.priorityFeeSol)} SOL`)}
          ${row("PumpPortal fee", esc(c.platformFeePct) + "% per trade")}
        </div></div>
        <div class="sec"><div class="sec-h"><h2>Open positions</h2></div><div class="group plain">${(T.positions || []).length ? T.positions.map(posRow).join("") : `<div class="row"><div class="main s">None</div></div>`}</div></div>
        <div class="sec"><div class="sec-h"><h2>Orders</h2></div><div class="group plain">${(T.orders || []).length ? T.orders.map(ordRow).join("") : `<div class="row"><div class="main s">No orders yet. In TEST, every order the desk would send shows here.</div></div>`}</div></div>
        ${(T.closed || []).length ? `<div class="sec"><div class="sec-h"><h2>Closed</h2></div><div class="group plain">${T.closed.map((p) => `<div class="row"><div class="main"><div class="t">${esc(p.symbol || p.mint.slice(0, 6))} · ${esc(p.mode === "TEST" ? "TEST" : "WALLET")}</div><div class="s">${esc(fmtTime(p.closedAt))} · ${esc(p.reason || "")}</div></div><div class="mono ${num(p.pnlUsd) < 0 ? "red" : "green"}">${esc(fmtSigned(p.pnlUsd))}</div></div>`).join("")}</div></div>` : ""}
        ${T.lastError ? `<div class="foot">Last error: ${esc(T.lastError)}</div>` : ""}`;
    }
    function liveWalletSheet() {
      const T = C.autotrade || {}, w = T.wallet || {}, c = T.caps || {};
      const blocked = !w.pubkey ? "Set the wallet address first (Account › Auto-trade)" : !T.apiKeySaved ? "PumpPortal key missing on the desk" : null;
      sheet(`<h3>Switch to LIVE WALLET</h3><p>The desk will send real buy and sell orders from the PumpPortal wallet${w.pubkey ? " " + esc(String(w.pubkey).slice(0, 4) + "…" + String(w.pubkey).slice(-4)) : ""}. Max ${esc(fmtUsd(c.maxPerTradeUsd))} per trade, ${esc(c.maxOpenPositions)} open, OFF after -${esc(fmtUsd(c.dailyLossLimitUsd, 0))} in a day. Your FOMO account is not used.</p>
        ${blocked ? `<div class="warnrow">${esc(blocked)}</div>` : ""}
        <p style="margin-top:10px">Type <b>${TRADE_PHRASE}</b> to confirm.</p>
        <input class="txt" id="lw-in" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="${TRADE_PHRASE}" aria-label="Type ${TRADE_PHRASE}">
        <div class="btn-row"><button class="btn ghost" data-x>Cancel</button><button class="btn red" data-ok disabled>Go LIVE WALLET</button></div>`,
        (sh, close) => {
          const inp = $("#lw-in", sh), ok = $("[data-ok]", sh);
          inp.addEventListener("input", () => (ok.disabled = inp.value.trim() !== TRADE_PHRASE));
          $("[data-x]", sh).onclick = close;
          ok.onclick = async () => { const r = await post(ok, "/api/autotrade/mode", { mode: "LIVE_WALLET", confirm: inp.value.trim() }, { ok: "Switching to LIVE WALLET", okSub: "The desk checks the wallet and confirms" }); if (r) close(); };
          setTimeout(() => inp.focus(), 350);
        });
    }
    v.onclick = (e) => {
      const st = e.target.closest("[data-tstop]"); if (st) { haptic(); return tradeStop(st); }
      const md = e.target.closest("[data-tmode]");
      if (md) { haptic(); const want = md.dataset.tmode, curM = (C.autotrade && C.autotrade.mode) || "OFF"; if (want === curM) return;
        if (want === "LIVE_WALLET") return liveWalletSheet();
        return post(md, "/api/autotrade/mode", { mode: want }, { ok: "Auto-trade → " + tradeModeLabel(want), okSub: want === "TEST" ? "Orders are recorded, never sent" : "No new buys" }); }
      const g = e.target.closest("[data-go]"); if (g) { haptic(); location.hash = g.dataset.go; }
    };
    return { load, update, unmount: () => { v.onclick = null; } };
  }

  /* ================================================================ LIVE TRADES feed (what auto-trade is buying into; read-only) */
  const fmtET = (t) => { const ms = toMs(t); return ms === null ? "" : new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/New_York" }) + " ET"; };
  const loadFeed = async () => { try { C.tradefeed = await api("/api/tradefeed"); } catch (e) { if (e && e.status === 404) C.tradefeed = C.tradefeed || null; else throw e; } };
  const pnlCls = (v) => (num(v) === null ? "" : num(v) < 0 ? "red" : "green");
  function feedSummary(F) {
    const s = (F && F.summary) || {};
    const cell = (k, v, cls = "") => `<div class="lt-cell"><div class="lt-k">${k}</div><div class="lt-v mono ${cls}">${v}</div></div>`;
    return `<div class="lt-sum" id="lt-sum">${cell("Test orders", esc(fmtInt(s.testOrders)))}${cell("Open", esc(fmtInt(s.open)))}${cell("Closed", esc(fmtInt(s.closed)))}
      ${cell("P&amp;L", esc(fmtSigned(s.pnlUsd)), pnlCls(s.pnlUsd))}${cell("P&amp;L %", esc(fmtPct(s.pnlPct)), pnlCls(s.pnlPct))}${cell("Win rate", s.winRate === null || s.winRate === undefined ? "n/a" : esc(fmtPct(s.winRate, 0, false)))}</div>`;
  }
  function feedHomeCard(F) {
    if (!F || !F.summary) return "";
    const s = F.summary, last = (F.items || [])[0];
    return `<section class="sec"><div class="sec-h"><h2>Live trades</h2><button class="link tap" data-go="#/live">Open</button></div>
      <div class="group plain"><div class="row tap" data-go="#/live" id="h-live-row"><div class="main"><div class="t">What it's buying ${tradeChip(F.mode === "LIVE_WALLET" ? "LIVE_WALLET" : "TEST")}</div>
        <div class="s">${esc(fmtInt(s.testOrders))} test orders · ${esc(fmtInt(s.open))} open · P&amp;L <span class="${pnlCls(s.pnlUsd)}">${esc(fmtSigned(s.pnlUsd))}</span>${last ? " · last " + esc((last.side === "buy" ? "buy " : "sell ") + (last.symbol || "")) : ""}</div></div>${icon("chev", "chev")}</div></div></section>`;
  }
  function feedCard(it, isNew) {
    const buy = it.side === "buy", open = it.positionStatus === "open" || it.positionStatus === "closing", closed = it.positionStatus === "closed";
    const nm = it.name && it.symbol && it.name !== it.symbol ? `${esc(it.name)} <span class="muted">${esc(it.symbol)}</span>` : esc(it.symbol || it.name || (it.mint || "").slice(0, 6));
    const aud = has(it.auditorChecked) && it.auditorChecked ? `Auditor ${esc(it.auditorPassed)}/${esc(it.auditorChecked)}` : "Auditor n/a";
    const ana = has(it.analystScore) ? `Analyst ${esc(it.analystScore)}` : "Analyst n/a";
    const pnl = has(it.pnlUsd) ? `<div class="lt-pnl mono ${pnlCls(it.pnlUsd)}">${esc(fmtSigned(it.pnlUsd))}${has(it.pnlPct) ? " · " + esc(fmtPct(it.pnlPct, 1)) : ""}</div>` : "";
    const state = buy ? (open ? `<span class="chip blue">open</span>` : closed ? `<span class="chip grey">closed</span>` : "") : `<span class="chip grey">exit</span>`;
    const size = buy ? `${has(it.sol) ? esc((+it.sol).toFixed(4)) + " SOL · " : ""}${esc(fmtUsd(it.usd))}` : `${esc(it.amount || "")}${has(it.usd) ? " · ~" + esc(fmtUsd(it.usd)) : ""}`;
    const live = buy && open ? `<div class="lt-line">Now ${esc(fmtPrice(it.priceNow))}${has(it.mcapNow) ? " · mcap " + esc(fmtCompact(it.mcapNow)) : ""} · <b class="${pnlCls(it.pnlPct)}">unrealized ${esc(fmtPct(it.pnlPct, 1))}</b></div>` : "";
    const exit = (closed || !buy) && (it.exitReason || it.reason) ? `<div class="lt-line">Exit: ${esc(it.exitReason || it.reason)}</div>` : "";
    return `<div class="lt-card tap${isNew ? " lt-new" : ""}" data-lt="${esc(it.id)}" data-mint="${esc(it.mint)}">
      <div class="lt-top"><span class="chip ${buy ? "green" : "red"}">${buy ? "WOULD BUY" : "WOULD SELL"}</span>${it.mode === "TEST" ? `<span class="chip amber">TEST</span>` : `<span class="chip red">WALLET</span>`}${state}<span class="lt-time muted">${esc(fmtET(it.ts))}</span></div>
      <div class="lt-name">${nm}</div>
      <div class="lt-line mono">${size}</div>
      <div class="lt-line">Entry ${esc(fmtPrice(it.entryPrice))}${has(it.entryMcap) ? " · mcap " + esc(fmtCompact(it.entryMcap)) : ""}</div>
      <div class="lt-line muted">${aud} · ${ana}</div>${live}${exit}${pnl}
      <div class="btn-row"><button class="btn ${buy && !closed ? "green" : "red"}" data-ltfomo="${esc(it.id)}">${buy && !closed ? "Open on FOMO" : "View on FOMO"}</button><button class="btn ghost" data-go="#/coin/${esc(encodeURIComponent(it.mint))}">Coin details</button></div></div>`;
  }
  function liveScreen(v) {
    v.innerHTML = `<header class="hdr"><button class="back tap" id="lt-back">${icon("back")}Back</button><div class="title" style="flex:1;text-align:center"><span>Live trades</span></div><span class="chip amber" id="lt-badge">TEST</span></header>
      <div class="offline-slot"></div><div class="sec lt-note muted">Orders auto-trade would place. In TEST nothing is sent. Updates every 4s.</div><div id="lt-sumbox"></div><div id="lt-list" class="sec"></div><div class="foot" id="lt-foot"></div>`;
    $("#lt-back", v).onclick = () => { haptic(); history.length > 1 ? history.back() : (location.hash = "#/"); };
    const seen = new Set(); let first = true, timer = null, alive = true;
    async function load() { await loadFeed(); }
    function update() {
      const F = C.tradefeed, list = $("#lt-list", v);
      $("#lt-badge", v).textContent = F && F.mode === "LIVE_WALLET" ? "LIVE WALLET" : "TEST";
      $("#lt-badge", v).className = "chip " + (F && F.mode === "LIVE_WALLET" ? "red" : "amber");
      if (!F) { list.innerHTML = NET.offline ? emptyBox("executor", "No live trades feed yet", "The desk's feed sends it every few seconds") : sk(160, "100%", 14) + sk(160, "100%", 14, 14); return; }
      const sh = feedSummary(F), sb = $("#lt-sumbox", v); if (sb._h !== sh) { sb._h = sh; sb.innerHTML = sh; }
      const items = F.items || [];
      if (!items.length) { list.innerHTML = emptyBox("executor", "No trades yet", "Each would-buy and would-sell shows up here the moment the desk records it"); }
      else {
        const html = items.map((it) => feedCard(it, !first && !seen.has(it.id) && !RM())).join("");
        if (list._h !== html.replace(/ lt-new/g, "")) { list._h = html.replace(/ lt-new/g, ""); list.innerHTML = html; }
        items.forEach((it) => seen.add(it.id)); first = false;
      }
      $("#lt-foot", v).textContent = has(F.feedAge) ? `Feed ${F.feedAge < 20 ? "live" : "stale"} · updated ${Math.round(F.feedAge)}s ago` : "";
    }
    const tick = async () => { if (!alive) return; try { await loadFeed(); update(); } catch (_) {} if (alive) timer = setTimeout(tick, 4000); };
    timer = setTimeout(tick, 4000);
    v.onclick = (e) => {
      const f = e.target.closest("[data-ltfomo]");
      if (f) { e.stopPropagation(); const it = ((C.tradefeed || {}).items || []).find((x) => String(x.id) === f.dataset.ltfomo); return openExternal(it && it.link); }
      const g = e.target.closest("[data-go]"); if (g) { haptic(); location.hash = g.dataset.go; return; }
      const c = e.target.closest("[data-mint]"); if (c) { haptic(); location.hash = "#/coin/" + encodeURIComponent(c.dataset.mint); }
    };
    return { load, update, unmount: () => { alive = false; clearTimeout(timer); v.onclick = null; } };
  }

  const SCREENS = { live: liveScreen, trade: tradeScreen, home: homeScreen, agents: agentsScreen, activity: activityScreen, account: accountScreen, coin: coinScreen, audit: auditScreen };

  /* ================================================================ SSE: live trades + activity */
  let es = null, esRetry = 0, lastSeq = 0;
  const TYPES = ["hello", "scan", "audit_layer", "verdict", "signal", "fill", "exit", "balance", "activity", "command_result"];
  function startStream() {
    if (!token() || es || typeof EventSource === "undefined") return;
    es = new EventSource("/api/stream?t=" + encodeURIComponent(token()) + (lastSeq ? "&since=" + lastSeq : ""));
    for (const ty of TYPES) es.addEventListener(ty, (m) => { let d = {}; try { d = JSON.parse(m.data); } catch (_) {} const s = +m.lastEventId || d.seq || 0; if (s) lastSeq = Math.max(lastSeq, s); try { onEvent(ty, d); } catch (err) { console.error(err); } });
    es.onopen = () => { esRetry = 0; };
    es.onerror = () => { if (es && es.readyState === 2) { es = null; setTimeout(startStream, Math.min(30000, 2000 * ++esRetry)); } };
  }
  function stopStream() { if (es) { try { es.close(); } catch (_) {} es = null; } }
  window.addEventListener("online", () => { refresh(); if (!es) startStream(); });
  function onEvent(type, d) {
    if (type === "hello") { if (d.offline) goOffline(); return; }
    const c = { name: d.name, symbol: d.symbol, image: d.image, mint: d.mint };
    const pfx = (d.mode ? String(d.mode).toUpperCase() === "PAPER" : isPaper()) ? "PAPER · " : "";
    let t = null;
    switch (type) {
      case "balance": {
        const val = num(d.balance), ts = toMs(d.ts) || Date.now();
        if (C.state && val !== null) { C.state.balance = val; if (has(d.todayPct)) C.state.todayPct = d.todayPct; if (has(d.multiplier)) C.state.multiplier = d.multiplier; }
        const ch = C.chart.LIVE; if (ch && val !== null) { ch.points = (ch.points || []).concat([[ts / 1000, val]]); ch.empty = false; }
        if (cur && cur.update) cur.update();
        return;
      }
      case "audit_layer": if (liveAudit) liveAudit(d); softRefresh(); return;
      case "command_result": {
        const label = CMDS.get(d.id); CMDS.delete(d.id);
        if (d.ok === false) { toast({ title: "Desk refused" + (label ? ": " + label : ""), sub: d.message || d.error || "", kind: "err", ms: 3500 }); PENDING.clear(); }
        else toast({ title: d.message || "Done", sub: "Desk confirmed", kind: "ok" });
        softRefresh(); return;
      }
      case "activity": {
        if (d.row) { LIVE_ROWS.unshift(d.row); LIVE_ROWS.length = Math.min(LIVE_ROWS.length, 20); C.activity = mergeLive(Array.isArray(C.activity) ? C.activity.filter((x) => rowKey(x) !== rowKey(d.row)) : []); }
        if (cur && cur.update) cur.update();
        requestAnimationFrame(() => { const first = $(".act .row"); first && first.classList.add("new"); });
        softRefresh(); return;
      }
      case "signal":
        if (d.status === "sent" && d.mint && !pfx) SIGNALS.set(d.mint, { ...d, kind: "signal" });
        else if (d.mint) SIGNALS.delete(d.mint);
        if (!d.status || d.status === "sent") t = { title: `${pfx}Buy ${coinName(c)} · ${fmtUsd(d.sizeUsd)}`, sub: "Executor", kind: "buy" };
        break;
      case "fill": SIGNALS.delete(d.mint); t = { title: `${pfx}Bought ${coinName(c)} · ${fmtUsd(d.sizeUsd)}`, sub: "Executor", kind: "buy" }; break;
      case "exit": {
        const p = num(d.pnlUsd), stop = /stop/i.test(d.reason || "");
        if (!pfx && d.mint && /sent|exiting|pending/i.test(d.status || "")) EXITS.set(d.mint, { ...d, kind: "exit" }); else EXITS.delete(d.mint);
        t = { title: stop ? `${pfx}${coinName(c)} hit the -${d.stopPct ?? ""}% stop · ${fmtSigned(p)}` : `${pfx}Sold ${coinName(c)} · ${fmtSigned(p)} (${fmtPct(d.pct, 1)})`, sub: "Risk · " + (d.reason || "exit"), kind: p !== null && p < 0 ? "err" : "ok" };
        break;
      }
      case "verdict": case "scan": softRefresh(); return;
    }
    if (t) {
      t.coin = c.symbol || c.name ? c : null; t.sub = "Desk · " + t.sub; t.ms = 2000;
      if (d.mint) t.href = "#/coin/" + encodeURIComponent(d.mint);
      toast(t); recentPush.unshift({ ...d, _at: Date.now(), _title: t.title }); recentPush.length = Math.min(recentPush.length, 50); bellDot();
    }
    softRefresh();
  }

  /* ================================================================ web push: stub (Discord carries notifications in this hosting) */
  window.deskEnableWebPush = async () => ({ supported: false, reason: "Notifications go to your Discord" });

  /* ================================================================ boot */
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
  document.addEventListener("touchstart", () => {}, { passive: true }); // :active on iOS
  grabToken();
  render();
  startStream();
})();
