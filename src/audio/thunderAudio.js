/**
 * thunderAudio.js — playing the impulse response.
 *
 * The physics module builds a genuine acoustic impulse response from the
 * channel's geometry: one delayed, spread N-wave per segment. What is
 * left is to convolve it with a source and put it out of the speakers,
 * which the Web Audio API does natively.
 *
 * The source is deliberately plain — a short burst of shaped noise
 * standing in for the fine structure of the shock front — because all the
 * character of the sound is in the impulse response. Change the flash and
 * the thunder changes; move the listener and it changes again; the crack
 * of a nearby strike and the twenty-second rumble of a distant one come
 * from the same code with different geometry, exactly as in the air.
 *
 * The delay before playback is not faked either: it is the time the
 * simulation says sound takes to arrive, so counting the seconds between
 * the flash and the bang gives the right distance.
 */

import { buildThunderImpulseResponse, spectralPeak, delayPerKm } from '../core/thunder.js';

export class ThunderAudio {
  constructor(opts = {}) {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.volume = opts.volume ?? 0.7;
    this.pending = [];
    this.lastReport = null;
  }

  /** Web Audio needs a user gesture; call this from a click handler. */
  async enable() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.enabled = true;
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;

    // A gentle shelf: thunder has very little above 2 kHz even close up,
    // and rolling it off keeps the convolution from sounding like static.
    this.tilt = this.ctx.createBiquadFilter();
    this.tilt.type = 'lowpass';
    this.tilt.frequency.value = 2400;
    this.tilt.Q.value = 0.6;

    // Sub-bass emphasis around the measured 50-100 Hz spectral peak.
    this.body = this.ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = spectralPeak();
    this.body.Q.value = 0.8;
    this.body.gain.value = 5;

    this.tilt.connect(this.body);
    this.body.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.enabled = true;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return true;
  }

  disable() { this.enabled = false; }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * Source signal for the convolution: the fine structure of the shock,
   * a fraction of a millisecond of noise with a fast attack. Everything
   * audible about the thunder comes from the impulse response it is
   * convolved with, not from this.
   */
  _makeSource(durationSeconds = 0.05) {
    const sr = this.ctx.sampleRate;
    const n = Math.max(64, Math.floor(sr * durationSeconds));
    const buf = this.ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const white = Math.random() * 2 - 1;
      lp += (white - lp) * 0.35;             // pink-ish
      d[i] = lp * Math.exp(-t * 9) * (1 - Math.exp(-t * 400));
    }
    return buf;
  }

  /** Turn the computed impulse response into a stereo AudioBuffer. */
  _makeIR(ir) {
    const sr = this.ctx.sampleRate;
    const ratio = sr / ir.sampleRate;
    const n = Math.max(2, Math.floor(ir.data.length * ratio));
    const buf = this.ctx.createBuffer(2, n, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) {
      const u = i / ratio;
      const j = u | 0;
      const f = u - j;
      const a = ir.data[j] || 0;
      const b = ir.data[j + 1] || 0;
      const v = a + (b - a) * f;
      // A little decorrelation between the ears. Thunder arrives from a
      // channel kilometres long, so it is anything but a point source and
      // it does not localise to one spot.
      const jitter = 1 + 0.12 * Math.sin(i * 0.0007 + 1.7);
      L[i] = v * jitter;
      R[i] = v * (2 - jitter);
    }
    return buf;
  }

  /**
   * Schedule the thunder for a flash.
   *
   * @param {Channel} channel
   * @param {{x,y,z}} listener  in simulation coordinates (z up)
   * @param {object} opts       {gain, maxSeconds}
   */
  play(channel, listener, opts = {}) {
    if (!this.enabled || !this.ctx) return null;

    const ir = buildThunderImpulseResponse({
      channel, listener,
      sampleRate: Math.min(22050, this.ctx.sampleRate),
      maxSeconds: opts.maxSeconds ?? 40,
    });
    if (!ir.sources || ir.data.length < 4) return null;

    const now = this.ctx.currentTime;
    const delay = ir.firstArrival;

    const src = this.ctx.createBufferSource();
    src.buffer = this._makeSource();

    const conv = this.ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = this._makeIR(ir);

    const gain = this.ctx.createGain();
    // Sound intensity falls as 1/r^2, so amplitude as 1/r; the reference
    // makes a strike a kilometre away sit at roughly unity.
    const r = Math.max(120, Math.hypot(
      listener.x, listener.y, listener.z - 400));
    const level = Math.min(1.6, 1000 / r) * (opts.gain ?? 1);
    gain.gain.value = level;

    src.connect(conv);
    conv.connect(gain);
    gain.connect(this.tilt);
    src.start(now + delay);
    src.stop(now + delay + conv.buffer.duration + 0.2);

    this.lastReport = {
      delay,
      duration: ir.duration,
      brightness: ir.brightness,
      sources: ir.sources,
      distanceKm: r / 1000,
      spectralPeakHz: spectralPeak(),
      secondsPerKm: delayPerKm(),
    };
    return this.lastReport;
  }

  dispose() {
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.enabled = false;
  }
}
