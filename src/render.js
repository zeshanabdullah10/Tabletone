// Draws the mirrored camera image, the keyboard in perspective, fingertips and key presses.
import { TIPS } from './hands.js?v=202610052130';

const FINGER_COLORS = ['#ffb347', '#7fdbff', '#a0f07a', '#ff85c0', '#c9a0ff'];

export class Renderer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.pressed = new Map();   // key → {t, vel}
    this.target = null;         // key highlighted by the accuracy test
    this.dragging = null;
  }

  press(key, vel = 0.8) { this.pressed.set(key, { t: performance.now(), vel }); }

  draw({ hands, keyboard, showHands = true, placing = null, flash = 0 }) {
    const { canvas, video, ctx } = this;
    const W = video.videoWidth, H = video.videoHeight;
    if (!W) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();

    if (keyboard.quad) this.drawKeyboard(keyboard, hands);
    if (placing) this.drawPlacing(placing);
    if (showHands) this.drawHands(hands);
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.25 * flash})`; ctx.fillRect(0, 0, W, H); }
  }

  drawKeyboard(kb, hands) {
    const ctx = this.ctx, n = kb.count, now = performance.now();
    const hover = new Set();
    for (const h of hands) for (const i of TIPS) { const k = kb.keyAt(h.pts[i].x, h.pts[i].y); if (k != null) hover.add(k); }
    const unit = Math.hypot(kb.quad.nr.x - kb.quad.nl.x, kb.quad.nr.y - kb.quad.nl.y) / n;
    for (let i = 0; i < n; i++) {
      const u0 = i / n, u1 = (i + 1) / n, g = 0.06 / n;
      const p = this.pressed.get(i);
      const age = p ? (now - p.t) / 350 : 1;
      const press = Math.max(0, 1 - age);
      const sink = press * 0.04;
      const poly = [kb.point(u0 + g, sink), kb.point(u1 - g, sink), kb.point(u1 - g, 1), kb.point(u0 + g, 1)];
      ctx.beginPath(); poly.forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
      const base = this.target === i ? 'rgba(255,214,90,0.55)' : hover.has(i) ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.22)';
      ctx.fillStyle = base; ctx.fill();
      if (press > 0) {
        ctx.save();
        ctx.shadowColor = '#7fe3ff'; ctx.shadowBlur = 30 * press;
        ctx.fillStyle = `rgba(110,220,255,${0.65 * press})`; ctx.fill();
        ctx.restore();
      } else if (p && age > 3) this.pressed.delete(i);
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.stroke();
      const c = kb.point((u0 + u1) / 2, 0.82);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.font = `600 ${Math.max(12, Math.min(28, unit * 0.32))}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(kb.label(i), c.x, c.y);
    }
    // Playing line.
    const a = kb.point(0, 0.5), b = kb.point(1, 0.5);
    ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    if (this.showHandles) {
      for (const [, q] of kb.corners()) {
        ctx.beginPath(); ctx.arc(q.x, q.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,214,90,0.9)'; ctx.fill();
      }
    }
  }

  drawHands(hands) {
    const ctx = this.ctx;
    for (const h of hands) {
      TIPS.forEach((i, f) => {
        const p = h.pts[i];
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = FINGER_COLORS[f]; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
      });
    }
  }

  drawPlacing({ progress, quad }) {
    const ctx = this.ctx;
    if (quad) {
      ctx.beginPath();
      [quad.nl, quad.nr, quad.fr, quad.fl].forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fillStyle = `rgba(255,214,90,${0.15 + 0.35 * progress})`; ctx.fill();
      ctx.strokeStyle = '#ffd65a'; ctx.lineWidth = 3; ctx.stroke();
    }
  }

  // CSS pixel → canvas pixel (canvas is letterboxed with object-fit: contain).
  toCanvas(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const s = Math.min(r.width / this.canvas.width, r.height / this.canvas.height);
    const ox = r.left + (r.width - this.canvas.width * s) / 2, oy = r.top + (r.height - this.canvas.height * s) / 2;
    return { x: (clientX - ox) / s, y: (clientY - oy) / s, s };
  }
}
