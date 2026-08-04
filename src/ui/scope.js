/**
 * scope.js — the instrument panel.
 *
 * Two traces, both of things that are actually measured in the field.
 *
 * The current oscilloscope shows the channel-base current on a log axis,
 * because a flash spans four decades: 30 kA during a return stroke, a few
 * hundred amps of continuing current, and nothing at all in between.
 * Only a log axis shows all three at once, and the shape it draws — the
 * microsecond spike, the exponential tail, the flat shelf of continuing
 * current with M-components riding on it — is exactly what a Rogowski
 * coil on an instrumented tower records.
 *
 * The field trace shows the vertical electric field at the ground under
 * the flash, which is what a field mill measures. It ramps as the leader
 * descends and its charge approaches, then collapses in microseconds when
 * the return stroke drains it. That ramp-and-collapse signature is how
 * lightning location networks detect a stroke in the first place.
 */

const CSS_FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

export class Scope {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.window = opts.window ?? 0.6;      // seconds of history shown
    this.samples = [];
    this.maxSamples = opts.maxSamples ?? 4000;
    this.markers = [];
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(80, Math.floor(r.width * this.dpr));
    const h = Math.max(40, Math.floor(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear() {
    this.samples.length = 0;
    this.markers.length = 0;
  }

  /** @param {number} t seconds  @param {number} current A  @param {number} field V/m */
  push(t, current, field) {
    const s = this.samples;
    // Keep the peak of any spike we might otherwise stride over: at real
    // time scales a 2 us front falls between frames.
    if (s.length && t - s[s.length - 1].t < 2e-5) {
      const last = s[s.length - 1];
      last.i = Math.max(last.i, current);
      last.e = field;
      return;
    }
    s.push({ t, i: current, e: field });
    if (s.length > this.maxSamples) s.splice(0, s.length - this.maxSamples);
  }

  mark(t, label) {
    this.markers.push({ t, label });
    if (this.markers.length > 24) this.markers.shift();
  }

  draw(now) {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const dpr = this.dpr;
    c.clearRect(0, 0, W, H);

    const t1 = Math.max(now, this.window);
    const t0 = t1 - this.window;
    const padL = 34 * dpr, padR = 6 * dpr, padT = 8 * dpr, padB = 14 * dpr;
    const gw = W - padL - padR, gh = H - padT - padB;

    const x = (t) => padL + ((t - t0) / (t1 - t0)) * gw;
    // Log current axis from 1 A to 300 kA.
    const decades = 5.5;
    const yI = (i) => {
      const v = Math.max(1, i);
      return padT + gh - (Math.log10(v) / decades) * gh;
    };

    c.save();
    c.fillStyle = 'rgba(8,10,16,0.72)';
    c.fillRect(0, 0, W, H);

    // Decade gridlines.
    c.strokeStyle = 'rgba(120,150,190,0.14)';
    c.fillStyle = 'rgba(150,175,205,0.55)';
    c.font = `${10 * dpr}px ui-monospace, monospace`;
    c.lineWidth = dpr;
    const labels = ['1 A', '10', '100', '1 kA', '10 k', '100 k'];
    for (let d = 0; d <= 5; d++) {
      const y = yI(Math.pow(10, d));
      c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
      c.fillText(labels[d], 3 * dpr, y + 3 * dpr);
    }

    // Field trace, autoscaled to its own range.
    let eMax = 1;
    for (const s of this.samples) if (Math.abs(s.e) > eMax) eMax = Math.abs(s.e);
    c.strokeStyle = 'rgba(120,200,255,0.55)';
    c.lineWidth = 1.2 * dpr;
    c.beginPath();
    let started = false;
    for (const s of this.samples) {
      if (s.t < t0) continue;
      const y = padT + gh * (0.5 - 0.45 * (s.e / eMax));
      if (!started) { c.moveTo(x(s.t), y); started = true; }
      else c.lineTo(x(s.t), y);
    }
    c.stroke();

    // Current trace.
    c.strokeStyle = 'rgba(255,214,120,0.95)';
    c.lineWidth = 1.5 * dpr;
    c.beginPath();
    started = false;
    for (const s of this.samples) {
      if (s.t < t0) continue;
      if (s.i < 1) {
        started = false;
        continue;
      }
      const y = yI(s.i);
      if (!started) { c.moveTo(x(s.t), y); started = true; }
      else c.lineTo(x(s.t), y);
    }
    c.stroke();

    // Phase markers.
    c.font = `${9 * dpr}px ui-monospace, monospace`;
    for (const m of this.markers) {
      if (m.t < t0 || m.t > t1) continue;
      const mx = x(m.t);
      c.strokeStyle = 'rgba(255,120,140,0.5)';
      c.lineWidth = dpr;
      c.beginPath(); c.moveTo(mx, padT); c.lineTo(mx, padT + gh); c.stroke();
      c.fillStyle = 'rgba(255,150,165,0.85)';
      c.save();
      c.translate(mx + 3 * dpr, padT + 4 * dpr);
      c.fillText(m.label, 0, 0);
      c.restore();
    }

    // Time axis.
    c.fillStyle = 'rgba(150,175,205,0.6)';
    c.font = `${9 * dpr}px ui-monospace, monospace`;
    const span = t1 - t0;
    const unit = span < 2e-3 ? ['us', 1e6] : span < 2 ? ['ms', 1e3] : ['s', 1];
    for (let i = 0; i <= 4; i++) {
      const t = t0 + (span * i) / 4;
      c.fillText(`${(t * unit[1]).toFixed(span * unit[1] < 20 ? 1 : 0)}${unit[0]}`,
        x(t) - 8 * dpr, H - 3 * dpr);
    }
    c.fillStyle = 'rgba(255,214,120,0.8)';
    c.fillText('I(t) base current', padL + 4 * dpr, padT + 10 * dpr);
    c.fillStyle = 'rgba(120,200,255,0.7)';
    c.fillText(`E(t) ground field  +/-${(eMax / 1e3).toFixed(1)} kV/m`,
      padL + 4 * dpr, padT + 21 * dpr);
    c.restore();
  }
}
