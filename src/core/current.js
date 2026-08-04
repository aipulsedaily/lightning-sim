/**
 * current.js — the return stroke: current, heat, light.
 *
 * When the descending leader connects to ground, the channel is suddenly
 * shorted to earth potential. A wave of neutralisation races back up the
 * channel at a substantial fraction of the speed of light, dumping the
 * leader's several coulombs into the ground and heating the core past
 * 30 000 K in a few microseconds. This module models three linked things:
 *
 *   1. The current at the channel base, as the Heidler function that
 *      lightning-protection standards use, fitted to the measured
 *      2.4/78 us (first stroke) and 0.25/20 us (subsequent) waveshapes.
 *
 *   2. Its distribution along the channel, using the MTLE engineering
 *      model: the same waveform delayed by the front's travel time and
 *      attenuated exponentially with height, which is what reproduces
 *      measured remote electromagnetic fields.
 *
 *   3. What that current does optically. Ohmic heating fills the channel
 *      with energy faster than radiation can empty it, so light rises in
 *      microseconds and decays over tens — the asymmetric optical pulse
 *      that streak cameras record. Colour follows from Planck's law at
 *      the resulting temperature, integrated against the CIE observer,
 *      not from a colour picker.
 */

import { RETURN_STROKE, OPTICS } from './constants.js';
import { relativeDensity } from './atmosphere.js';

/* ================================================================== *
 * Heidler current function
 * ================================================================== */

/**
 *   i(t) = (I0 / eta) * (t/tau1)^n / (1 + (t/tau1)^n) * exp(-t/tau2)
 *
 * The first factor is a smooth rise with time constant tau1, the second
 * an exponential decay with tau2, and eta is the correction that makes
 * the peak equal I0. Unlike a double-exponential, its derivative is zero
 * at t = 0, which matters because di/dt is what couples lightning into
 * nearby conductors.
 *
 * Rather than hard-coding published (tau1, tau2) pairs, the constructor
 * fits them to a requested front / time-to-half-value pair, so any
 * standard waveshape can be asked for directly.
 */
export class HeidlerWaveform {
  /**
   * @param {{front:number, half:number}} shape  seconds
   * @param {number} peak  A
   * @param {number} n     steepness exponent (2 for standard waveshapes)
   */
  constructor(shape, peak, n = 2) {
    this.n = n;
    this.peak = peak;
    this.targetFront = shape.front;
    this.targetHalf = shape.half;
    this.tau1 = shape.front * 0.55;
    this.tau2 = shape.half * 1.1;
    this.scale = 1;
    this._fit();
  }

  /** Unnormalised shape function. */
  _raw(t) {
    if (t <= 0) return 0;
    const k = Math.pow(t / this.tau1, this.n);
    return (k / (1 + k)) * Math.exp(-t / this.tau2);
  }

  /**
   * Measure the peak, the equivalent front time (10-90% slope extended to
   * 0-100%, the IEC convention) and the time to half value on the tail.
   */
  _measure() {
    const tMax = Math.max(this.tau2 * 12, this.tau1 * 40);
    const N = 6000;
    let peak = 0, tPeak = 0;
    const dt = tMax / N;
    // Fine scan near the front where the peak lives.
    for (let i = 1; i <= N; i++) {
      const t = i * dt;
      const v = this._raw(t);
      if (v > peak) { peak = v; tPeak = t; }
    }
    // Refine the peak on a fine grid around tPeak.
    for (let i = -40; i <= 40; i++) {
      const t = tPeak + i * dt * 0.05;
      if (t <= 0) continue;
      const v = this._raw(t);
      if (v > peak) { peak = v; tPeak = t; }
    }
    const cross = (lo, hi, target, rising) => {
      for (let i = 0; i < 60; i++) {
        const m = 0.5 * (lo + hi);
        const v = this._raw(m);
        if (rising ? v < target : v > target) lo = m; else hi = m;
      }
      return 0.5 * (lo + hi);
    };
    const t10 = cross(0, tPeak, 0.1 * peak, true);
    const t90 = cross(0, tPeak, 0.9 * peak, true);
    const tHalf = cross(tPeak, tMax, 0.5 * peak, false);
    return { peak, tPeak, front: (t90 - t10) / 0.8, half: tHalf };
  }

  /** Iteratively pull (tau1, tau2) onto the requested waveshape. */
  _fit() {
    for (let it = 0; it < 60; it++) {
      const m = this._measure();
      const fErr = this.targetFront / m.front;
      const hErr = this.targetHalf / m.half;
      if (Math.abs(fErr - 1) < 1e-4 && Math.abs(hErr - 1) < 1e-4) break;
      // Damped multiplicative update; the two knobs are nearly separable.
      this.tau1 *= Math.pow(fErr, 0.7);
      this.tau2 *= Math.pow(hErr, 0.7);
      this.tau1 = Math.max(1e-9, this.tau1);
      this.tau2 = Math.max(this.tau1 * 1.2, this.tau2);
    }
    const m = this._measure();
    this.scale = this.peak / (m.peak || 1);
    this.measured = m;
    this.tPeak = m.tPeak;
    this._buildTables();
  }

  /**
   * Two sampled tables, because `current()` is called for every node of
   * the channel on every sub-step of the return stroke — millions of times
   * per flash — and a pow plus an exp each time is the single most
   * expensive thing in the simulation.
   *
   * The fine table resolves the microsecond front (the part that matters
   * for di/dt and for how the light comes up); the coarse one covers the
   * hundred-microsecond tail. Linear interpolation between samples is well
   * inside the uncertainty of the waveshape itself.
   */
  _buildTables() {
    const N = 4096;
    this.fineEnd = 40 * this.tau1;
    this.coarseEnd = 14 * this.tau2;
    this.fineStep = this.fineEnd / (N - 1);
    this.coarseStep = this.coarseEnd / (N - 1);
    this.fine = new Float32Array(N);
    this.coarse = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.fine[i] = this.scale * this._raw(i * this.fineStep);
      this.coarse[i] = this.scale * this._raw(i * this.coarseStep);
    }
  }

  /** Current in amperes at time t after the front arrives. */
  current(t) {
    if (t <= 0) return 0;
    if (t >= this.coarseEnd) return this.scale * this._raw(t);
    const tab = t < this.fineEnd ? this.fine : this.coarse;
    const step = t < this.fineEnd ? this.fineStep : this.coarseStep;
    const u = t / step;
    const i = u | 0;
    const f = u - i;
    return tab[i] + (tab[i + 1] - tab[i]) * f;
  }

  /** Exact evaluation, bypassing the tables. Used by the fitting pass. */
  currentExact(t) {
    return t <= 0 ? 0 : this.scale * this._raw(t);
  }

  /** di/dt in A/s — the quantity that induces voltages in nearby loops. */
  derivative(t, h = 1e-9) {
    return (this.current(t + h) - this.current(t - h)) / (2 * h);
  }

  peakDerivative() {
    let best = 0;
    const N = 3000;
    const tMax = this.tPeak * 2;
    for (let i = 1; i < N; i++) {
      const d = this.derivative(i * tMax / N, tMax / N * 0.1);
      if (d > best) best = d;
    }
    return best;
  }

  /** Charge transferred up to time t, by trapezoid. */
  chargeTo(t, steps = 2000) {
    let s = 0;
    const dt = t / steps;
    for (let i = 0; i < steps; i++) {
      s += 0.5 * (this.current(i * dt) + this.current((i + 1) * dt)) * dt;
    }
    return s;
  }

  /** Action integral (specific energy) in A^2 s — what melts conductors. */
  actionIntegral(t, steps = 4000) {
    let s = 0;
    const dt = t / steps;
    for (let i = 0; i < steps; i++) {
      const a = this.current(i * dt), b = this.current((i + 1) * dt);
      s += 0.5 * (a * a + b * b) * dt;
    }
    return s;
  }
}

/* ================================================================== *
 * Propagation of the front
 * ================================================================== */

/**
 * Return-stroke front speed as a function of height. Measured values run
 * from about c/3 near the ground down to c/10 in the cloud; the decrease
 * comes from the falling residual conductivity of the upper leader
 * channel and from the current being progressively used up.
 */
export function returnStrokeSpeed(z, base = RETURN_STROKE.SPEED_BASE) {
  const v = base * Math.exp(-Math.max(0, z) / RETURN_STROKE.SPEED_DECAY_HEIGHT);
  return Math.max(RETURN_STROKE.SPEED_MIN, v);
}

/** MTLE current attenuation with height, exp(-z/lambda), lambda ~ 2 km. */
export function mtleAttenuation(z, lambda = RETURN_STROKE.MTLE_LAMBDA) {
  return Math.exp(-Math.max(0, z) / lambda);
}

/**
 * The transmission-line relation between the leader's line charge density
 * and the peak current it produces:  I = lambda * v.
 *
 * This is the bridge between the two halves of the simulation. The leader
 * phase computes lambda from the corona-sheath capacitance; multiply by
 * the return-stroke speed and you get the peak current, without ever
 * choosing one. 4e-4 C/m at 1.1e8 m/s gives 44 kA, right on top of the
 * measured distribution for first strokes.
 */
export function peakCurrentFromLeaderCharge(lambda, speed = RETURN_STROKE.SPEED_BASE,
  coreFraction = RETURN_STROKE.CORE_CHARGE_FRACTION) {
  return Math.abs(lambda) * speed * coreFraction;
}

/** Love's striking distance, the electrogeometric model. I in A, out in m. */
export function strikingDistance(peakCurrentA) {
  return 10 * Math.pow(Math.max(1, peakCurrentA) / 1000, 0.65);
}

/**
 * Cylindrical strong-shock (Taylor-Sedov) radius: the channel's blast
 * wave, from which thunder is born. R grows as t^(1/2) until it weakens
 * to the local sound speed at the relaxation radius, a few metres out.
 */
export function shockRadius(t, energyPerMetre = RETURN_STROKE.ENERGY_PER_METRE, z = 0) {
  if (t <= 0) return RETURN_STROKE.CHANNEL_RADIUS;
  const rho = 1.225 * relativeDensity(z);
  return Math.max(RETURN_STROKE.CHANNEL_RADIUS,
    1.0 * Math.pow(energyPerMetre / rho, 0.25) * Math.sqrt(t));
}

/* ================================================================== *
 * Thermal / optical state of the channel
 * ================================================================== */

/**
 * Energy balance for one metre of channel:
 *
 *     dW/dt = i(t)^2 R'  -  W / tau_cool
 *
 * R' is an effective resistance per metre chosen so the total deposited
 * energy matches the 1e3-1e5 J/m measured acoustically; 1 ohm/m with a
 * 30 kA stroke and a 30 us cooling time gives ~2e4 J/m, mid-range.
 *
 * Temperature follows from radiative equilibrium, where the radiated
 * power goes as T^4, so T scales as W^(1/4). That single exponent is why
 * the channel's colour barely shifts through the first few tens of
 * microseconds and then falls away quickly.
 */
export class ChannelThermal {
  constructor(opts = {}) {
    this.Rp = opts.resistancePerMetre ?? 1.0;             // ohm/m
    this.tauCool = opts.tauCool ?? RETURN_STROKE.TEMP_COOL_TAU;
    this.Tpeak = opts.peakTemperature ?? RETURN_STROKE.TEMP_PEAK;
    this.Tquiet = opts.quiescentTemperature ?? RETURN_STROKE.TEMP_QUIESCENT;
    // Reference energy: what a median first stroke puts in.
    this.Wref = opts.referenceEnergy ?? RETURN_STROKE.ENERGY_PER_METRE;
  }

  /** One explicit step of the energy balance. W in J/m, i in A. */
  step(W, i, dt) {
    const heat = i * i * this.Rp;
    const cool = W / this.tauCool;
    let out = W + (heat - cool) * dt;
    return out > 0 ? out : 0;
  }

  temperature(W) {
    const f = Math.pow(Math.max(0, W) / this.Wref, 0.25);
    return this.Tquiet + (this.Tpeak - this.Tquiet) * Math.min(1.6, f);
  }

  /** Visible radiance, compressed: emission grows sublinearly with energy
   *  because the hot core is optically thick and radiates from its skin. */
  luminance(W) {
    return Math.pow(Math.max(0, W) / this.Wref, 0.62);
  }
}

/* ================================================================== *
 * Colour from temperature — Planck through the CIE 1931 observer
 * ================================================================== */

/** Gaussian with different widths either side of the peak. */
function gLobe(x, mu, s1, s2) {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2);
  return Math.exp(-0.5 * t * t);
}

/** Multi-lobe analytic fits to the CIE 1931 2-degree colour matching
 *  functions (Wyman, Sloan & Shirley 2013). Accurate to ~1%. */
function cieX(l) {
  return 1.056 * gLobe(l, 599.8, 37.9, 31.0)
    + 0.362 * gLobe(l, 442.0, 16.0, 26.7)
    - 0.065 * gLobe(l, 501.1, 20.4, 26.2);
}
function cieY(l) {
  return 0.821 * gLobe(l, 568.8, 46.9, 40.5)
    + 0.286 * gLobe(l, 530.9, 16.3, 31.1);
}
function cieZ(l) {
  return 1.217 * gLobe(l, 437.0, 11.8, 36.0)
    + 0.681 * gLobe(l, 459.0, 26.0, 13.8);
}

const H_PLANCK = 6.62607015e-34;
const K_BOLTZ = 1.380649e-23;
const C0 = 2.99792458e8;

/** Planck spectral radiance, wavelength in nm, per unit wavelength. */
export function planck(lambdaNm, T) {
  const l = lambdaNm * 1e-9;
  const a = 2 * H_PLANCK * C0 * C0 / Math.pow(l, 5);
  const b = Math.expm1(H_PLANCK * C0 / (l * K_BOLTZ * T));
  return a / b;
}

const _bbCache = new Map();

/**
 * Linear sRGB of a blackbody at temperature T, normalised so the largest
 * channel is 1. At 30 000 K the visible band is deep on the Rayleigh-Jeans
 * tail and the result is a blue-white that barely changes with further
 * heating — which is exactly why every lightning photograph looks the
 * same colour regardless of how strong the stroke was, and why the
 * interesting colour change happens later, during the cool-down.
 */
export function blackbodyRGB(T) {
  const key = Math.round(T / 50) * 50;
  const hit = _bbCache.get(key);
  if (hit) return hit;

  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const p = planck(l, Math.max(500, T));
    X += p * cieX(l); Y += p * cieY(l); Z += p * cieZ(l);
  }
  // CIE XYZ -> linear sRGB (sRGB primaries, D65 white).
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const m = Math.max(r, g, b) || 1;
  const out = [r / m, g / m, b / m];
  _bbCache.set(key, out);
  return out;
}

/**
 * Rayleigh extinction over a path, which is what turns a flash beyond a
 * few kilometres orange. Distant lightning is not a different colour of
 * plasma; it is the same plasma seen through more air.
 */
export function rayleighTransmission(distance, out = [0, 0, 0]) {
  const b = OPTICS.RAYLEIGH_BETA;
  out[0] = Math.exp(-b[0] * distance);
  out[1] = Math.exp(-b[1] * distance);
  out[2] = Math.exp(-b[2] * distance);
  return out;
}
