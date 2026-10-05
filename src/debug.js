// Debug overlay (fps, timings, onset log) and an exportable session log.

export class Debug {
  constructor(el) {
    this.el = el;
    this.on = false;
    this.frames = [];
    this.lines = [];
    this.log = [];            // session log, exported as JSON
    this.stats = {};
  }

  frame(t) {
    this.frames.push(t);
    while (this.frames.length && t - this.frames[0] > 1000) this.frames.shift();
  }
  get fps() { return this.frames.length; }

  record(type, data) {
    const e = { type, t: Math.round(performance.now()), ...data };
    this.log.push(e);
    if (this.log.length > 20000) this.log.shift();
    if (type === 'onset' || type === 'note' || type === 'drop' || type === 'test') {
      this.lines.unshift(fmt(e));
      this.lines.length = Math.min(this.lines.length, 10);
    }
    return e;
  }

  render(extra) {
    if (!this.on) { this.el.hidden = true; return; }
    this.el.hidden = false;
    const s = Object.entries({ fps: this.fps, ...extra }).map(([k, v]) => `${k}: ${v}`).join('  ');
    this.el.textContent = s + '\n' + this.lines.join('\n');
  }

  export(meta) {
    const blob = new Blob([JSON.stringify({ meta, log: this.log }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mirror-piano-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}

function fmt(e) {
  const r = (x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x);
  if (e.type === 'onset') return `onset r=${r(e.ratio)}${e.self ? ' (self, gated)' : ''}`;
  if (e.type === 'note') return `note ${e.keys.join('+')} via ${e.via} lag=${r(e.lag)}ms ${e.best ? `score=${r(e.best.score)} down=${r(e.best.down)}` : ''}`;
  if (e.type === 'drop') return `drop (${e.reason})`;
  if (e.type === 'test') return `test target=${e.target} got=${e.got ?? '—'}`;
  return e.type;
}
