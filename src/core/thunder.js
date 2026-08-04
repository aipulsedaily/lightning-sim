/**
 * thunder.js — turning a channel into a sound.
 *
 * Thunder is not an explosion at a point. Every metre of channel is its
 * own source: the return stroke deposits of order 10^4 joules per metre in
 * a few microseconds, the air cannot get out of the way, and a cylindrical
 * shock wave expands from the whole length of the bolt at once. That shock
 * runs out to a "relaxation radius" of a few metres, where it has spent
 * its overpressure, and from there travels as an ordinary sound wave —
 * an N-wave, a sharp compression followed by a rarefaction, a few
 * milliseconds long, which is why the acoustic spectrum of thunder peaks
 * near 50-100 Hz.
 *
 * The consequence is that thunder's *shape* is the channel's geometry
 * projected onto the listener by the speed of sound. Sound from the
 * nearest point arrives first; sound from the far end of a five-kilometre
 * channel arrives up to fifteen seconds later. The crack is the part of
 * the channel that is close and nearly equidistant; the rumble is
 * everything else, arriving in the order the geometry dictates.
 *
 * So this module does not synthesise thunder with noise and filters. It
 * builds a genuine acoustic impulse response by summing, for every segment
 * of the simulated channel, an N-wave delayed by its travel time, scaled
 * by 1/r, and low-passed by the frequency-dependent absorption of that
 * much air. Convolve any short source with it and you get the thunder that
 * *this* flash would actually make, from *this* listening position.
 */

import { THUNDER, RETURN_STROKE } from './constants.js';
import { soundSpeed } from './atmosphere.js';

/**
 * Relaxation radius: how far the strong shock gets before it degenerates
 * into sound. Setting the energy per unit length equal to the work done
 * pushing back an atmosphere at pressure p0 over the cylinder's area,
 *
 *     E/L = pi R^2 p0    ->    R = sqrt(E / (pi p0)),
 *
 * which for 10^4 J/m at sea level is about 5 m. The duration of the N-wave
 * is roughly the time sound takes to cross it, a few milliseconds, and one
 * over that is the frequency thunder peaks at.
 */
export function relaxationRadius(energyPerMetre = RETURN_STROKE.ENERGY_PER_METRE,
  pressure = 101325) {
  return Math.sqrt(energyPerMetre / (Math.PI * pressure));
}

/**
 * The N-wave itself: a jump to +1, a linear ramp down through zero to -1,
 * and a jump back. Real measurements show the leading shock is sharper
 * than the trailing one, so the ramp is skewed slightly.
 */
export function nWave(u) {
  if (u < 0 || u > 1) return 0;
  const s = 1 - 2 * u;
  // Slight asymmetry: the leading compression is steeper.
  return s * (1 - 0.25 * u) * Math.exp(-2.5 * u * u);
}

/**
 * Build the acoustic impulse response of a channel at a listening point.
 *
 * @param {object} o
 *   channel      Channel (uses geometry, segLen and per-node current)
 *   listener     {x, y, z}
 *   sampleRate   Hz
 *   maxSeconds   truncation (default 30 s: audible thunder rarely exceeds it)
 *   energyScale  multiplies the per-metre acoustic energy
 * @returns {{data: Float32Array, sampleRate, firstArrival, lastArrival,
 *            duration, brightness, peak}}
 */
export function buildThunderImpulseResponse(o) {
  const ch = o.channel;
  const L = o.listener;
  const sr = o.sampleRate || 22050;
  const maxSeconds = o.maxSeconds || 90;
  const energyScale = o.energyScale ?? 1;
  const cs = soundSpeed(0);

  let firstArrival = Infinity, lastArrival = 0;
  const contributions = [];
  let totalEnergy = 0;

  for (let i = 0; i < ch.count; i++) {
    const seg = ch.segLen[i];
    if (seg <= 0) continue;
    // Acoustic output tracks the energy the stroke put into that segment.
    // Use the peak current the segment saw; luminous output and acoustic
    // output are both driven by the same ohmic heating.
    const I = Math.abs(ch.current[i]) || 0;
    const lum = ch.lum[i] || 0;
    const drive = Math.max(I / 30000, lum * 0.35);
    if (drive < 0.01) continue;

    const mx = 0.5 * (ch.x[i] + ch.x[ch.parent[i] >= 0 ? ch.parent[i] : i]);
    const my = 0.5 * (ch.y[i] + ch.y[ch.parent[i] >= 0 ? ch.parent[i] : i]);
    const mz = 0.5 * (ch.z[i] + ch.z[ch.parent[i] >= 0 ? ch.parent[i] : i]);
    const dx = mx - L.x, dy = my - L.y, dz = mz - L.z;
    const r = Math.max(20, Math.sqrt(dx * dx + dy * dy + dz * dz));

    // Sound speed falls with altitude, so a ray from high up travels a
    // little slower on average than one from the cloud base.
    const cAvg = 0.5 * (cs + soundSpeed(mz));
    const t = r / cAvg;
    if (t > maxSeconds) continue;
    if (t < firstArrival) firstArrival = t;
    if (t > lastArrival) lastArrival = t;

    const energyPerMetre = RETURN_STROKE.ENERGY_PER_METRE * drive * drive * energyScale;
    const R0 = relaxationRadius(energyPerMetre);
    // Cylindrical source of length seg, spreading as 1/r once far away.
    const amp = seg * Math.sqrt(energyPerMetre) / (r * 1.4);
    totalEnergy += amp * amp;
    contributions.push({ t, amp, R0, r, cAvg });
  }

  if (!contributions.length) {
    return {
      data: new Float32Array(1), sampleRate: sr, firstArrival: 0,
      lastArrival: 0, duration: 0, brightness: 0, peak: 0,
    };
  }

  const n = Math.max(2, Math.ceil((lastArrival - firstArrival + 0.5) * sr) + 64);
  const data = new Float32Array(n);

  for (const c of contributions) {
    // Width of the N-wave: the time sound takes to cross the shock's
    // relaxation radius, stretched by dispersion over the propagation
    // path. Thunder heard from far away is not just quieter, it is
    // *slower* — the pulse has been smeared out.
    const base = 2 * c.R0 / c.cAvg;
    const spread = base * (1 + 0.9 * Math.sqrt(c.r / 3000));
    const width = Math.max(1 / sr * 2, spread);
    const start = (c.t - firstArrival) * sr;
    const w = width * sr;
    const i0 = Math.max(0, Math.floor(start));
    const i1 = Math.min(n - 1, Math.ceil(start + w));
    // Absorption of the high frequencies is folded into the pulse width
    // above; what remains is the straightforward geometric loss.
    for (let i = i0; i <= i1; i++) {
      data[i] += c.amp * nWave((i - start) / w);
    }
  }

  // Normalise, and measure how much high-frequency content survived — the
  // single number that most distinguishes a nearby crack from a distant
  // rumble.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < n; i++) data[i] /= peak;

  let hf = 0, tot = 1e-12;
  for (let i = 1; i < n; i++) {
    const d = data[i] - data[i - 1];
    hf += d * d;
    tot += data[i] * data[i];
  }

  return {
    data,
    sampleRate: sr,
    firstArrival,
    lastArrival,
    duration: lastArrival - firstArrival,
    brightness: Math.sqrt(hf / tot),
    peak,
    sources: contributions.length,
    energy: totalEnergy,
  };
}

/**
 * Peak of the acoustic spectrum implied by the shock's relaxation radius.
 * Comes out at 50-100 Hz for a cloud-to-ground stroke, which is what
 * measurements of thunder report.
 */
export function spectralPeak(energyPerMetre = RETURN_STROKE.ENERGY_PER_METRE) {
  const R0 = relaxationRadius(energyPerMetre);
  return soundSpeed(0) / (2 * Math.PI * R0);
}

/** Rule of thumb, for the HUD: seconds of delay per kilometre. */
export function delayPerKm() {
  return 1000 / soundSpeed(0);
}

/**
 * Total acoustic energy radiated by the channel, in joules. Only about
 * one percent of the electrical energy ends up as sound; most goes to
 * light, heat and radio. THUNDER is loud because lightning is enormous,
 * not because it is an efficient loudspeaker.
 */
export function acousticEnergy(channelLength,
  energyPerMetre = RETURN_STROKE.ENERGY_PER_METRE, efficiency = 0.01) {
  return channelLength * energyPerMetre * efficiency;
}
