/* Hand-drawn canvas charts (no library). Exposes window.Charts = {Line, Candles}. */
(function () {
  "use strict";
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const DPR = () => Math.min(window.devicePixelRatio || 1, 3);

  function fit(cv) {
    const r = cv.getBoundingClientRect(), d = DPR();
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // pill with text, anchored so it stays inside [0,W]
  function pill(ctx, text, cx, cy, bg, fg, W, opt = {}) {
    ctx.font = "700 11px -apple-system,BlinkMacSystemFont,sans-serif";
    const pad = 7, dot = opt.dot ? 12 : 0;
    const tw = ctx.measureText(text).width + pad * 2 + dot, th = 20;
    let x = opt.align === "right" ? cx - tw : opt.align === "left" ? cx : cx - tw / 2;
    x = Math.max(2, Math.min(W - tw - 2, x));
    const y = cy - th / 2;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.5)"; ctx.shadowBlur = 6;
    roundRect(ctx, x, y, tw, th, 10); ctx.fillStyle = bg; ctx.fill();
    ctx.restore();
    if (opt.dot) { ctx.beginPath(); ctx.arc(x + pad + 4, cy, 4, 0, 7); ctx.fillStyle = opt.dot; ctx.fill(); }
    ctx.fillStyle = fg; ctx.textBaseline = "middle"; ctx.fillText(text, x + pad + dot, cy + .5);
    return { x, y, w: tw, h: th };
  }

  const ease = (t) => 1 - Math.pow(1 - t, 3);

  /* ------------------------------------------------------------ Line ---- */
  const RM = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  class Line {
    constructor(cv) {
      this.cv = cv; this.pts = []; this.marks = []; this.start = null; this.from = null; this.t0 = 0;
      this.seen = new Map(); this.first = true;
      this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(cv);
      this.loop = this.loop.bind(this); this.raf = requestAnimationFrame(this.loop);
    }
    destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }
    // points: [[ts, value]], marks: [{ts, kind:'buy'|'sell'|'stop', label}], start: night-start value
    // levels (optional): [{v, label, color, fg, fit}] dashed horizontal price levels; fit:false ones never stretch the y-range
    setData(points, marks, start, levels) {
      this.levels = (levels || []).filter((l) => l && isFinite(l.v) && l.v > 0);
      const p = (points || []).filter((q) => q && isFinite(q[0]) && isFinite(q[1]));
      this.from = this.pts.length ? { pts: this.pts, t0: this.pts[0][0], t1: this.pts[this.pts.length - 1][0] } : null;
      this.firstAnim = !this.pts.length && p.length > 1;
      this.pts = p; this.marks = (marks || []).filter((m) => m && isFinite(m.ts));
      this.start = isFinite(start) ? +start : (p.length ? p[0][1] : null);
      this.t0 = performance.now();
      const now = performance.now();
      for (const m of this.marks) { const key = m.ts + "|" + m.label; if (!this.seen.has(key)) this.seen.set(key, this.first ? 0 : now); }
      this.first = false;
    }
    loop(now) { this.draw(now); this.raf = requestAnimationFrame(this.loop); }
    draw(now = performance.now()) {
      const { ctx, w, h } = fit(this.cv);
      ctx.clearRect(0, 0, w, h);
      const P = this.pts; if (P.length < 1) return;
      const rm = RM();
      const G = css("--green"), B = css("--blue"), Rd = css("--red");
      const top = 58, bot = 12, padR = 12;
      let lo = Infinity, hi = -Infinity;
      for (const q of P) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); }
      if (this.start != null) { lo = Math.min(lo, this.start); hi = Math.max(hi, this.start); }
      for (const l of this.levels || []) if (l.fit !== false) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); }
      if (hi - lo < 1e-9) { const d = Math.abs(hi) > 1e-6 ? Math.abs(hi) * .01 : 1; hi += d; lo -= d; }
      const span = hi - lo; lo -= span * 0.1; hi += span * 0.05;
      const t0 = P[0][0], t1 = Math.max(P[P.length - 1][0], t0 + 1);
      // a new point slides in over 250ms: interpolate the x-domain from the previous one
      const slide = rm || !this.from ? 1 : ease(Math.min(1, (now - this.t0) / 250));
      const ft1 = this.from ? this.from.t1 : t1, ft0 = this.from ? this.from.t0 : t0;
      const dt1 = ft1 + (t1 - ft1) * slide, dt0 = ft0 + (t0 - ft0) * slide;
      const X = (t) => ((t - dt0) / Math.max(1, dt1 - dt0)) * (w - padR);
      const Y = (v) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bot);
      const reveal = rm || !this.firstAnim ? 1 : ease(Math.min(1, (now - this.t0) / 700));
      const xy = P.map((q) => [Math.min(X(q[0]), w - padR), Y(q[1])]);
      const cut = Math.max(1, Math.ceil(xy.length * reveal));
      const L = xy.slice(0, cut);
      // dashed start line
      if (this.start != null) {
        const sy = Y(this.start);
        ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(235,235,245,.3)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke(); ctx.restore();
      }
      // price levels: dashed line + pill at the left; off-range ones pin to the edge with an arrow
      const lvPills = [];
      if (this.levels && this.levels.length) {
        const used = { right: xy.length ? [xy[xy.length - 1][1]] : [], left: [] };
        const free = (side, py) => !used[side].some((u) => Math.abs(u - py) < 21);
        for (const l of this.levels) {
          let y = Y(l.v), label = l.label, off = 0;
          if (y < top - 4) { y = top - 4; off = 1; } else if (y > h - bot) { y = h - bot; off = -1; }
          if (off) label = (off > 0 ? "↑ " : "↓ ") + label;
          else { ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = l.color; ctx.lineWidth = 1.2; ctx.globalAlpha = .85;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.restore(); }
          // right edge first (next to the live price), then left, then stack away from the clash
          let side = free("right", y) ? "right" : free("left", y) ? "left" : null, py = y;
          if (!side) {   // nudge up/down on either side until it clears (stays inside the plot)
            const lo = top - 4, hi = h - bot;
            outer: for (let k = 1; k <= 6; k++) for (const sg of [1, -1]) for (const sd of ["right", "left"]) {
              const q = y + sg * k * 21;
              if (q >= lo && q <= hi && free(sd, q)) { side = sd; py = q; break outer; }
            }
            if (!side) side = "left";
          }
          used[side].push(py);
          lvPills.push([label, side === "left" ? 4 : w - 4 - padR, py, l.color, l.fg || "#fff", side]);
        }
      }
      if (L.length >= 2) {
        const g = ctx.createLinearGradient(0, top, 0, h);
        g.addColorStop(0, "rgba(0,211,90,.28)"); g.addColorStop(1, "rgba(0,211,90,0)");
        ctx.beginPath(); ctx.moveTo(L[0][0], h);
        for (const [x, y] of L) ctx.lineTo(x, y);
        ctx.lineTo(L[L.length - 1][0], h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); L.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = G; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
      }
      // level pills go on top of the price fill; marks then route around them
      const placed = [];
      for (const [label, px, py, bg, fg, side] of lvPills) {
        const r = pill(ctx, label, px, py, bg, fg, w, { align: side });
        placed.push({ x: r.x, w: r.w, y: py });
      }
      // marks above the line; a later mark that would overlap moves up a row
      const lastX = L[L.length - 1][0];
      const sorted = this.marks.slice().sort((a, b) => a.ts - b.ts);
      ctx.font = "700 11px -apple-system,BlinkMacSystemFont,sans-serif";
      for (const m of sorted) {
        if (m.ts < t0 - 1 || m.ts > t1 + 1) continue;
        const mx = Math.min(X(m.ts), w - padR); if (mx > lastX + 1) continue;
        let my = L[L.length - 1][1];
        for (let i = 1; i < L.length; i++) if (L[i][0] >= mx) {
          const a = L[i - 1], b = L[i], f = b[0] === a[0] ? 0 : (mx - a[0]) / (b[0] - a[0]);
          my = a[1] + (b[1] - a[1]) * f; break;
        }
        const kind = m.kind === "buy" ? "buy" : (m.kind === "stop" || /^-/.test(String(m.label || ""))) ? "stop" : "sell";
        const bg = kind === "buy" ? B : kind === "stop" ? Rd : G;
        const fg = kind === "sell" ? "#000" : "#fff";
        const born = this.seen.get(m.ts + "|" + m.label) || 0;
        const alpha = rm || !born ? 1 : Math.min(1, (now - born) / 200);
        const label = String(m.label || (kind === "buy" ? "Bought" : "Sold"));
        const tw = ctx.measureText(label).width + 14;
        let row = 0, py, px;
        for (;;) {
          py = Math.min(my - 18, top - 12) - row * 24 + (row ? 0 : 0);
          py = my - 22 - row * 24;
          px = Math.max(2, Math.min(w - tw - 2, mx - tw / 2));
          const hit = placed.some((r) => px < r.x + r.w + 4 && px + tw + 4 > r.x && Math.abs(r.y - py) < 22);
          if (!hit || row > 6) break;
          row++;
        }
        py = Math.max(11, py);
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.moveTo(mx, my - 4); ctx.lineTo(mx, py + 10);
        ctx.strokeStyle = bg; ctx.globalAlpha = alpha * .45; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, 7); ctx.fillStyle = bg; ctx.fill();
        ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.stroke();
        const r = pill(ctx, label, mx, py, bg, fg, w);
        ctx.globalAlpha = 1;
        placed.push({ x: r.x, w: r.w, y: py });
      }
      // leading point: solid dot with a thin pulsing ring (no glow)
      const [lx, ly] = L[L.length - 1];
      if (!rm) {
        const ph = ((now % 1600) / 1600);
        ctx.beginPath(); ctx.arc(lx, ly, 5 + ph * 9, 0, 7);
        ctx.strokeStyle = G; ctx.globalAlpha = (1 - ph) * .6; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, 7); ctx.fillStyle = G; ctx.fill();
      ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, 7); ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  /* ------------------------------------------------------ Score ring ---- */
  function ring(cv, score, min, color) {
    const { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h);
    const r = Math.min(w, h) / 2 - 4, cx = w / 2, cy = h / 2, lw = Math.max(4, r * 0.16);
    ctx.lineWidth = lw; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = css("--card2"); ctx.stroke();
    if (score != null && isFinite(score)) {
      const f = Math.max(0, Math.min(100, score)) / 100;
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      ctx.strokeStyle = score >= (min ?? 70) ? css("--green") : (color || css("--yellow")); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(r * 0.75)}px -apple-system,BlinkMacSystemFont,sans-serif`;
    ctx.fillText(score != null && isFinite(score) ? String(Math.round(score)) : "–", cx, cy + 1);
  }

  /* --------------------------------------------------------- Candles ---- */
  class Candles {
    constructor(cv) {
      this.cv = cv; this.c = []; this.lines = {}; this.stopFrom = null; this.stopT = 0;
      this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(cv);
      this.loop = this.loop.bind(this); this.raf = requestAnimationFrame(this.loop);
    }
    destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }
    // candles: [[t,o,h,l,c,v]]; lines: {entry, exit, stop, entryLabel, exitLabel, stopLabel, price}
    setData(candles, lines) {
      const prevStop = this.lines.stop;
      this.c = (candles || []).filter((q) => q && q.length >= 5);
      this.lines = lines || {};
      if (prevStop != null && this.lines.stop != null && prevStop !== this.lines.stop) {
        this.stopFrom = prevStop; this.stopT = performance.now();
      } else if (prevStop == null && this.lines.stop != null) {
        this.stopFrom = null; this.stopT = performance.now();
      }
    }
    loop(now) { this.draw(now); this.raf = requestAnimationFrame(this.loop); }
    draw(now = performance.now()) {
      const { ctx, w, h } = fit(this.cv);
      ctx.clearRect(0, 0, w, h);
      const C = this.c; if (!C.length) return;
      const L = this.lines, volH = 46, top = 16, padR = 70, chartB = h - volH - 10;
      // stop animates (slides up) from previous value, or rises from below on first show
      let stop = L.stop;
      const k = RM() ? 1 : ease(Math.min(1, (now - this.stopT) / 900));
      let lo = Infinity, hi = -Infinity, vmax = 0;
      for (const q of C) { lo = Math.min(lo, q[3]); hi = Math.max(hi, q[2]); vmax = Math.max(vmax, q[5] || 0); }
      for (const v of [L.entry, L.exit, L.stop]) if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (hi - lo < 1e-12) { hi *= 1.01; lo *= .99; }
      const sp = hi - lo; lo -= sp * .06; hi += sp * .06;
      const Y = (v) => top + (1 - (v - lo) / (hi - lo)) * (chartB - top);
      if (stop != null) {
        const from = this.stopFrom != null ? this.stopFrom : lo;
        stop = from + (stop - from) * k;
      }
      const n = C.length, cw = (w - padR) / n, bw = Math.max(1.5, Math.min(9, cw * .62));
      const G = css("--green"), R = css("--red");
      // grid
      ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) { const y = top + (chartB - top) * i / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      C.forEach((q, i) => {
        const [, o, hh, ll, c, v] = q, x = i * cw + cw / 2, upc = c >= o, col = upc ? G : R;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, Y(hh)); ctx.lineTo(x, Y(ll)); ctx.stroke();
        const y1 = Y(Math.max(o, c)), y2 = Y(Math.min(o, c));
        ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
        if (vmax) { ctx.globalAlpha = .45; const vh = ((v || 0) / vmax) * volH; ctx.fillRect(x - bw / 2, h - vh, bw, vh); ctx.globalAlpha = 1; }
      });
      const dashed = (v, col, label, fg, side) => {
        const y = Y(v);
        ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.globalAlpha = .9;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.restore();
        if (label) pill(ctx, label, side === "left" ? 4 : w - 4, y, col, fg, w, { align: side === "left" ? "left" : "right" });
      };
      if (L.entry != null) dashed(L.entry, css("--blue"), L.entryLabel || "Entry", "#fff", "left");
      if (L.exit != null) dashed(L.exit, L.exitNeg ? R : G, L.exitLabel || "Exit", L.exitNeg ? "#fff" : "#000", "left");
      if (stop != null) dashed(stop, css("--orange"), L.stopLabel || "Risk trailing stop", "#000", "left");
      // last price pill
      const last = C[n - 1][4], ly = Y(last), up = last >= C[0][1];
      ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = up ? G : R; ctx.globalAlpha = .5;
      ctx.beginPath(); ctx.moveTo((n - 1) * cw + cw / 2, ly); ctx.lineTo(w, ly); ctx.stroke(); ctx.restore();
      pill(ctx, L.priceLabel || String(last), w - 2, ly, up ? G : R, up ? "#000" : "#fff", w, { align: "right" });
    }
  }

  window.Charts = { Line, Candles, ring };
})();
