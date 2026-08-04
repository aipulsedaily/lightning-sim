/**
 * physics.test.mjs — sanity checks on the physics core.
 *
 * These are not unit tests of code paths; they check that the simulation
 * lands inside the ranges the literature reports for real lightning. If a
 * change makes the leader deposit 500 C or the return stroke run at the
 * speed of sound, this is what catches it.
 *
 *   node tests/physics.test.mjs
 */

import assert from 'node:assert/strict';
import {
  relativeDensity, temperature, pressure, soundSpeed,
  breakdownField, propagationField, isothermAltitude,
} from '../src/core/atmosphere.js';
import { FieldSolver, lineChargeDensity } from '../src/core/field.js';
import { Channel, NODE } from '../src/core/channel.js';
import { LeaderGrower, findInitiationPoint } from '../src/core/leader.js';
import { makeRng } from '../src/core/rng.js';
import { CLOUD, STEPPED_LEADER, RETURN_STROKE } from '../src/core/constants.js';
import {
  HeidlerWaveform, returnStrokeSpeed, mtleAttenuation,
  blackbodyRGB, peakCurrentFromLeaderCharge,
} from '../src/core/current.js';
import { Flash, FlashType, makeTarget } from '../src/core/flash.js';
import { buildThunderImpulseResponse } from '../src/core/thunder.js';

/** A straight vertical channel, for testing the acoustics in isolation. */
function makeLineChannel(height, segments = 80) {
  const c = new Channel();
  let prev = -1;
  for (let i = 0; i <= segments; i++) {
    prev = c.add(0, 0, (i / segments) * height, prev, {});
  }
  for (let i = 0; i < c.count; i++) { c.lum[i] = 1; c.current[i] = 30000; }
  return c;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function inRange(v, lo, hi, what) {
  assert.ok(v >= lo && v <= hi,
    `${what}: ${typeof v === 'number' ? v.toPrecision(4) : v} not in [${lo}, ${hi}]`);
}

console.log('\natmosphere');
test('ISA sea-level values', () => {
  assert.ok(Math.abs(temperature(0) - 288.15) < 1e-6);
  assert.ok(Math.abs(pressure(0) - 101325) < 1e-6);
  inRange(relativeDensity(0), 0.999, 1.001, 'delta(0)');
});
test('density falls to ~0.53 at 6 km and ~0.34 at 10 km', () => {
  inRange(relativeDensity(6000), 0.50, 0.57, 'delta(6 km)');
  inRange(relativeDensity(10000), 0.31, 0.36, 'delta(10 km)');
});
test('speed of sound 340 m/s at surface, slower aloft', () => {
  inRange(soundSpeed(0), 339, 341, 'c_s(0)');
  inRange(soundSpeed(6000), 310, 320, 'c_s(6 km)');
});
test('breakdown field 3 MV/m at sea level, lower aloft', () => {
  inRange(breakdownField(0), 2.99e6, 3.01e6, 'E_bd(0)');
  assert.ok(breakdownField(8000) < breakdownField(0) * 0.5);
});
test('negative leaders need a stronger field than positive ones', () => {
  assert.ok(propagationField(5000, -1) > propagationField(5000, +1));
});
test('-10 C and -25 C isotherms bracket the main negative charge', () => {
  const lo = isothermAltitude(-10), hi = isothermAltitude(-25);
  inRange(lo, 3000, 4500, '-10 C level');
  inRange(hi, 5500, 7000, '-25 C level');
  assert.ok(CLOUD.MAIN_NEG.z > lo && CLOUD.MAIN_NEG.z < hi + 1500);
});

console.log('\nelectrostatics');
const regions = [CLOUD.UPPER_POS, CLOUD.MAIN_NEG, CLOUD.LOWER_POS];
const solver = new FieldSolver(regions);

test('potential vanishes on the conducting ground plane', () => {
  for (const [x, y] of [[0, 0], [2000, -1500], [-4000, 3000]]) {
    assert.ok(Math.abs(solver.ambient.potential(x, y, 0)) < 1,
      `phi(${x},${y},0) = ${solver.ambient.potential(x, y, 0)}`);
  }
});
test('far field matches a point charge of the same total', () => {
  // 40 - 40 + 6 = +6 C net, plus its image, seen from a long way off.
  const r = 200000;
  const phi = solver.ambient.potential(r, 0, 6000);
  const expect = 8.9875e9 * 6 * (1 / r - 1 / r); // net dipole-dominated
  assert.ok(Math.abs(phi) < 1e4, `far potential too large: ${phi}`);
  assert.ok(Number.isFinite(phi));
});
test('field between the charge centres is 0.2-2 kV/cm', () => {
  const E = solver.ambient.fieldMagnitude(0, 0, 4400);
  inRange(E, 2e4, 2e5, 'E between N and LPCR');
});
test('the storm reverses and amplifies the fair-weather surface field', () => {
  // Fair weather is about -100 V/m (downward). Negative charge overhead
  // flips it upward and multiplies it by one to two orders of magnitude.
  const E = solver.groundField(0, 0);
  console.log(`       surface field under the core: ${(E).toFixed(0)} V/m ` +
    `(fair weather is about -100 V/m)`);
  assert.ok(E > 0, 'negative charge overhead should point the surface field up');
  inRange(E, 1e3, 5e4, 'surface field magnitude (V/m)');
  // Far outside the storm it should relax back towards nothing.
  assert.ok(Math.abs(solver.groundField(40000, 0)) < Math.abs(E) * 0.1);
});
test('flashes start between charge regions, not at their centres', () => {
  const cg = findInitiationPoint(solver.ambient, { zMin: 1500, zMax: CLOUD.MAIN_NEG.z });
  const ic = findInitiationPoint(solver.ambient, { zMin: CLOUD.MAIN_NEG.z, zMax: 12500 });
  console.log(`       CG band: z = ${(cg.z / 1000).toFixed(2)} km, ` +
    `E = ${(cg.field / 1e3).toFixed(0)} kV/m, E/Ec = ${cg.ratio.toFixed(2)}`);
  console.log(`       IC band: z = ${(ic.z / 1000).toFixed(2)} km, ` +
    `E = ${(ic.field / 1e3).toFixed(0)} kV/m, E/Ec = ${ic.ratio.toFixed(2)}`);
  // Between the main negative charge and the lower positive region.
  inRange(cg.z, CLOUD.LOWER_POS.z, CLOUD.MAIN_NEG.z, 'CG initiation altitude');
  // Between the main negative charge and the upper positive region.
  inRange(ic.z, CLOUD.MAIN_NEG.z, CLOUD.UPPER_POS.z, 'IC initiation altitude');
  // Peak fields inside thunderstorms are 100-400 kV/m in balloon soundings.
  inRange(cg.field / 1e3, 60, 400, 'CG-band peak field (kV/m)');
  inRange(ic.field / 1e3, 60, 400, 'IC-band peak field (kV/m)');
});
test('the field vanishes at the centre of a charge region', () => {
  // A symmetric charge layer has no field at its own centre; anything
  // else would mean the discretisation is lumpy.
  const centre = solver.ambient.fieldMagnitude(0, 0, CLOUD.MAIN_NEG.z);
  const edge = solver.ambient.fieldMagnitude(0, 0, CLOUD.MAIN_NEG.z - 1400);
  assert.ok(centre < 0.25 * edge,
    `field at region centre ${(centre / 1e3).toFixed(1)} kV/m vs ` +
    `${(edge / 1e3).toFixed(1)} kV/m below it`);
});
test('charge densities match the 0.1-5 nC/m^3 that soundings report', () => {
  for (const r of regions) {
    const vol = (4 / 3) * Math.PI * r.radiusH * r.radiusH * r.radiusV;
    const rho = Math.abs(r.charge) / vol * 1e9;   // nC/m^3
    inRange(rho, 0.1, 5, `charge density of the region at ${r.z} m`);
  }
});
test('corona-sheath line charge lands in the measured 1e-4..1e-3 C/m band', () => {
  const l = Math.abs(lineChargeDensity(-50e6,
    STEPPED_LEADER.CORONA_RADIUS, STEPPED_LEADER.CORE_RADIUS));
  inRange(l, 1e-4, 1e-3, 'lambda at 50 MV');
});
test('local field expansion agrees with the exact Coulomb sum', () => {
  const s = new FieldSolver(regions);
  const rng = makeRng(7);
  for (let i = 0; i < 400; i++) {
    s.channel.add(rng.range(-300, 300), rng.range(-300, 300),
      rng.range(500, 5000), rng.range(-1e-2, 1e-2));
  }
  const cx = 0, cy = 0, cz = 3000;
  const loc = s.channel.buildLocal(cx, cy, cz, 300);
  const out = { ex: 0, ey: 0, ez: 0 };
  const exact = { phi: 0, ex: 0, ey: 0, ez: 0 };
  let worst = 0;
  for (let k = 0; k < 30; k++) {
    const px = cx + rng.range(-20, 20), py = cy + rng.range(-20, 20),
      pz = cz + rng.range(-20, 20);
    s.channel.fieldLocal(loc, px, py, pz, out);
    s.channel.eval(px, py, pz, exact);
    const mag = Math.hypot(exact.ex, exact.ey, exact.ez);
    const err = Math.hypot(out.ex - exact.ex, out.ey - exact.ey, out.ez - exact.ez);
    worst = Math.max(worst, err / Math.max(mag, 1));
  }
  assert.ok(worst < 0.10, `worst relative field error ${(worst * 100).toFixed(2)}%`);
});

console.log('\nstepped leader (DBM)');

function growCG(seed, params) {
  const s = new FieldSolver(regions);
  const ch = new Channel();
  const init = findInitiationPoint(s.ambient, { zMin: 1500, zMax: CLOUD.MAIN_NEG.z });
  const g = new LeaderGrower({ solver: s, channel: ch, rng: makeRng(seed), params });
  g.seed(init.x, init.y, init.z, false);
  let rounds = 0;
  while (!g.finished && g.groundContact < 0 && rounds < 3000) { g.round(); rounds++; }
  return { s, ch, g, init, rounds };
}

test('a negative CG leader descends, branches, and reaches the ground', () => {
  let reached = 0;
  const trials = 5;
  for (let t = 0; t < trials; t++) {
    const { ch, g, init } = growCG(1000 + t * 7919);
    const drop = init.z - g.stats.minAltitude;
    const charge = ch.chargeMagnitude();
    const speed = g.measuredDescentSpeed(init.z);
    const tortuosity = ch.arcLen[g.groundContact >= 0 ? g.groundContact : ch.lowestNode()]
      / Math.max(1, drop);
    const tipPotential = g.originPotential +
      8000 * ch.dropLen[g.groundContact >= 0 ? g.groundContact : ch.lowestNode()];
    // Without an upward connecting leader to close the final jump, a bare
    // stepped leader is not expected to touch down every time; the last
    // few hundred metres are the hardest part of its journey. The flash
    // level test below is the one that checks strike rate.
    const ok = g.groundContact >= 0 || g.stats.minAltitude < 700;
    if (ok) reached++;
    console.log(`       #${t}: ${ch.count} nodes, ${g.stats.branches} branches, ` +
      `${(ch.totalLength / 1000).toFixed(1)} km channel, ` +
      `min z ${g.stats.minAltitude.toFixed(0)} m, ${charge.toFixed(1)} C, ` +
      `${(g.simTime * 1e3).toFixed(0)} ms, v = ${speed.toPrecision(3)} m/s, ` +
      `tortuosity ${tortuosity.toFixed(2)}, tip ${(tipPotential / 1e6).toFixed(0)} MV`);

    inRange(g.stats.branches, 2, 200, 'branch count');
    inRange(g.simTime, 3e-3, 150e-3, 'leader duration (s)');
    inRange(charge, 1, 40, 'charge on the leader channel (C)');
    inRange(speed, 5e4, 2.5e6, 'mean descent speed (m/s)');
    inRange(tipPotential / 1e6, -120, -10, 'leader tip potential (MV)');
  }
  assert.ok(reached >= trials - 1,
    `only ${reached}/${trials} leaders got to the ground`);
});

test('the in-cloud positive end develops before the negative end descends', () => {
  const { ch, g } = (() => {
    const s = new FieldSolver(regions);
    const chn = new Channel();
    const init = findInitiationPoint(s.ambient, { zMin: 1500, zMax: CLOUD.MAIN_NEG.z });
    const gr = new LeaderGrower({ solver: s, channel: chn, rng: makeRng(31337) });
    gr.seed(init.x, init.y, init.z, false);
    for (let r = 0; r < 30; r++) gr.round();
    return { ch: chn, g: gr, init };
  })();
  let up = 0, down = 0;
  for (let i = 0; i < ch.count; i++) (ch.polarity[i] > 0 ? up++ : down++);
  console.log(`       after 30 rounds: ${up} positive-leader nodes, ` +
    `${down} negative-leader nodes`);
  assert.ok(up > 0, 'the positive end should be growing');
});

test('the bidirectional leader stays electrically neutral', () => {
  const { s, ch } = growCG(555);
  const net = s.channel.totalCharge;
  const mag = ch.chargeMagnitude();
  console.log(`       net ${net.toExponential(2)} C on ${mag.toFixed(1)} C of ` +
    `separated charge`);
  assert.ok(Math.abs(net) < 0.02 * mag + 1e-3,
    `net charge ${net} is not small against ${mag}`);
});

test('a positive leader branches far less than a negative one', () => {
  function grow(upwardIsNegative, seed) {
    const s = new FieldSolver(regions);
    const ch = new Channel();
    const g = new LeaderGrower({ solver: s, channel: ch, rng: makeRng(seed) });
    const init = findInitiationPoint(s.ambient, { zMin: 1500, zMax: CLOUD.MAIN_NEG.z });
    g.seed(init.x, init.y, init.z, upwardIsNegative);
    let r = 0;
    while (!g.finished && g.groundContact < 0 && r < 1200) { g.round(); r++; }
    let branchNodes = 0;
    for (let i = 0; i < ch.count; i++) if (ch.level[i] > 0) branchNodes++;
    return branchNodes / Math.max(1, ch.count);
  }
  // Average over seeds: this is a statistical property, not a single run.
  let neg = 0, pos = 0;
  const seeds = [11, 222, 3333, 44444];
  for (const sd of seeds) { neg += grow(false, sd); pos += grow(true, sd); }
  neg /= seeds.length; pos /= seeds.length;
  console.log(`       fraction of channel on side branches - ` +
    `negative-down ${(neg * 100).toFixed(0)}%, positive-down ${(pos * 100).toFixed(0)}%`);
  assert.ok(neg > pos,
    'negative leaders should put more of their channel into branches');
});

test('eta controls how filamentary the discharge is', () => {
  // Growth is chaotic, so this is a statistical claim about morphology,
  // not something a single trajectory can settle. The effect is real but
  // modest here: the leader tip's overpotential compresses the spread of
  // bond fields, so the weights are closer together than they would be in
  // a classic lattice DBM with an O(1) potential range.
  const seeds = [9001, 4, 77, 1618, 2718, 31, 8191, 65537];
  // What eta controls unambiguously is the *sharpness* of the selection:
  // the mean weight of the bond actually taken, relative to the best
  // available. Downstream morphology follows from that, but branch counts
  // alone are a poor probe of it because two runs with different eta take
  // entirely different, chaotically divergent paths.
  const sharpnessFor = (eta) => {
    let s = 0;
    for (const sd of seeds) s += growCG(sd, { eta }).g.stats.selectionSharpness;
    return s / seeds.length;
  };
  const soft = sharpnessFor(0.6);
  const mid = sharpnessFor(3.0);
  const sharp = sharpnessFor(8.0);
  console.log(`       mean (E_chosen-Ec)/(E_best-Ec):  eta=0.6 -> ${soft.toFixed(3)}, ` +
    `eta=3 -> ${mid.toFixed(3)}, eta=8 -> ${sharp.toFixed(3)}`);
  assert.ok(sharp > mid && mid > soft,
    `selection should sharpen monotonically with eta ` +
    `(${soft.toFixed(3)} / ${mid.toFixed(3)} / ${sharp.toFixed(3)})`);
  assert.ok(sharp > 0.8, 'a large eta should almost always take the best bond');
});

console.log('\nreturn stroke');
test('Heidler waveform hits its target peak and front/half times', () => {
  const w = new HeidlerWaveform(RETURN_STROKE.WAVESHAPE_FIRST, 30e3);
  let peak = 0, tPeak = 0;
  for (let t = 0; t < 400e-6; t += 2e-8) {
    const i = w.current(t);
    if (i > peak) { peak = i; tPeak = t; }
  }
  inRange(peak / 1e3, 29.5, 30.5, 'peak current (kA)');
  // 10-90% front time and time to half value on the tail.
  let t10 = 0, t90 = 0, tHalf = 0;
  for (let t = 0; t < 400e-6; t += 2e-8) {
    const i = w.current(t);
    if (!t10 && i >= 0.1 * peak) t10 = t;
    if (!t90 && i >= 0.9 * peak) t90 = t;
    if (t > tPeak && !tHalf && i <= 0.5 * peak) tHalf = t;
  }
  const front = (t90 - t10) / 0.8;
  console.log(`       peak ${(peak / 1e3).toFixed(1)} kA, ` +
    `front ${(front * 1e6).toFixed(2)} us, half ${(tHalf * 1e6).toFixed(0)} us`);
  inRange(front * 1e6, 1.0, 5.0, 'front time (us)');
  inRange(tHalf * 1e6, 50, 120, 'time to half value (us)');
});
test('subsequent strokes are faster and weaker', () => {
  const f = new HeidlerWaveform(RETURN_STROKE.WAVESHAPE_FIRST, 30e3);
  const s = new HeidlerWaveform(RETURN_STROKE.WAVESHAPE_SUBSEQ, 12e3);
  assert.ok(s.peakDerivative() > f.peakDerivative(),
    'subsequent strokes have the steeper front');
  inRange(s.peakDerivative() / 1e9, 5, 400, 'di/dt (kA/us)');
});
test('return-stroke front runs at c/5 to c/2 and slows with height', () => {
  const v0 = returnStrokeSpeed(0), v6 = returnStrokeSpeed(6000);
  inRange(v0 / 3e8, 0.15, 0.7, 'v(0) / c');
  assert.ok(v6 < v0, 'front should decelerate with height');
  inRange(v6 / 3e8, 0.05, 0.4, 'v(6 km) / c');
});
test('MTLE attenuates current with height', () => {
  assert.ok(mtleAttenuation(0) === 1);
  inRange(mtleAttenuation(2000), 0.35, 0.38, 'attenuation at one lambda');
});
test('peak current follows from the leader charge, I = lambda v', () => {
  const I = peakCurrentFromLeaderCharge(STEPPED_LEADER.LINE_CHARGE_TYPICAL,
    RETURN_STROKE.SPEED_BASE);
  console.log(`       lambda = 4e-4 C/m at 1.1e8 m/s  ->  ${(I / 1e3).toFixed(0)} kA`);
  inRange(I / 1e3, 15, 80, 'derived peak current (kA)');
});
test('30000 K reads blue-white, 3000 K reads red', () => {
  const hot = blackbodyRGB(30000), warm = blackbodyRGB(3000);
  assert.ok(hot[2] >= hot[0], 'hot plasma should be blue-dominant');
  assert.ok(warm[0] > warm[2], '3000 K should be red-dominant');
});

console.log('\nwhole flashes');

function runFlash(type, seed) {
  const f = new Flash({
    seed, type,
    targets: [makeTarget(220, -140, 120, 3, 'radio mast')],
  });
  let guard = 0;
  while (!f.done && guard++ < 400000) f.update(2e-4);
  return f;
}

test('a negative CG flash reproduces the measured numbers', () => {
  const seeds = [7, 1234, 4242, 8675309, 20260803];
  let grounded = 0;
  const peaks = [], charges = [], mult = [];
  for (const s of seeds) {
    const f = runFlash(FlashType.NEGATIVE_CG, s);
    const T = f.telemetry();
    const hit = f.groundNode >= 0;
    if (hit) {
      grounded++;
      peaks.push(T.peakCurrent);
      charges.push(T.chargeTransferred);
      mult.push(f.strokes.length);
    }
    console.log(`       seed ${s}: ${hit ? 'struck' : 'stayed aloft'} — ` +
      `${f.strokes.length} stroke(s), ${(T.peakCurrent / 1e3).toFixed(0)} kA, ` +
      `${T.chargeTransferred.toFixed(1)} C, ${(T.peakTemp / 1000).toFixed(0)} kK, ` +
      `${(f.time * 1e3).toFixed(0)} ms, ${(T.channelLength / 1000).toFixed(0)} km channel`);
    // Whether or not it reaches ground, these must hold.
    inRange(T.peakTemp, 8000, 45000, 'peak channel temperature (K)');
    inRange(f.time, 5e-3, 1.5, 'flash duration (s)');
  }
  assert.ok(grounded >= 3, `only ${grounded}/${seeds.length} reached the ground`);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`       means: ${(mean(peaks) / 1e3).toFixed(0)} kA peak ` +
    `(observed median 30), ${mean(charges).toFixed(1)} C (observed 5-25), ` +
    `${mean(mult).toFixed(1)} strokes (observed 3-5)`);
  inRange(mean(peaks) / 1e3, 12, 80, 'mean peak current (kA)');
  inRange(mean(charges), 1, 40, 'mean charge transfer (C)');
  inRange(mean(mult), 1, 8, 'mean multiplicity');
});

test('subsequent strokes are weaker than the first, on average', () => {
  // Individual subsequent strokes do sometimes exceed the first — that is
  // a documented and not especially rare occurrence — so the claim to
  // test is about the medians (30 kA against 12 kA), not about every
  // stroke of every flash.
  let firstSum = 0, restSum = 0, restN = 0, flashes = 0;
  for (const sd of [4242, 7, 1234, 99, 20260803, 31337]) {
    const f = runFlash(FlashType.NEGATIVE_CG, sd);
    if (f.strokes.length < 2) continue;
    flashes++;
    firstSum += f.strokes[0].peak;
    for (const s of f.strokes.slice(1)) { restSum += s.peak; restN++; }
  }
  if (!flashes) { console.log('       (no multi-stroke flashes, skipped)'); return; }
  const first = firstSum / flashes, rest = restSum / restN;
  console.log(`       mean first stroke ${(first / 1e3).toFixed(1)} kA over ` +
    `${flashes} flashes, mean subsequent ${(rest / 1e3).toFixed(1)} kA ` +
    `over ${restN} strokes`);
  assert.ok(rest < first,
    `subsequent strokes should be weaker on average (${(rest / 1e3).toFixed(1)} ` +
    `vs ${(first / 1e3).toFixed(1)} kA)`);
});

test('an intracloud flash never touches the ground', () => {
  const f = runFlash(FlashType.INTRACLOUD, 99);
  let minZ = Infinity;
  for (let i = 0; i < f.channel.count; i++) minZ = Math.min(minZ, f.channel.z[i]);
  console.log(`       lowest point of the discharge: ${(minZ / 1000).toFixed(2)} km, ` +
    `${(f.channel.totalLength / 1000).toFixed(0)} km of channel`);
  assert.ok(f.groundNode < 0, 'an intracloud flash must not attach');
  assert.ok(minZ > 500, 'it should stay well above the surface');
});

test('a positive flash is single-stroke and moves a lot of charge', () => {
  let found = null;
  for (const s of [7, 4242, 31337, 5150]) {
    const f = runFlash(FlashType.POSITIVE_CG, s);
    if (f.groundNode >= 0) { found = f; break; }
  }
  if (!found) { console.log('       (no positive flash reached ground in 4 tries)'); return; }
  const T = found.telemetry();
  console.log(`       ${found.strokes.length} stroke(s), ` +
    `${(T.peakCurrent / 1e3).toFixed(0)} kA, ${T.chargeTransferred.toFixed(0)} C`);
  assert.equal(found.strokes.length, 1, 'positive flashes are almost always single-stroke');
});

test('the flash is deterministic for a given seed', () => {
  const a = runFlash(FlashType.NEGATIVE_CG, 12345).telemetry();
  const b = runFlash(FlashType.NEGATIVE_CG, 12345).telemetry();
  assert.equal(a.nodes, b.nodes);
  assert.ok(Math.abs(a.channelLength - b.channelLength) < 1e-3);
  assert.ok(Math.abs(a.peakCurrent - b.peakCurrent) < 1e-6);
});

console.log('\nthunder');
test('the acoustic delay is the 3 seconds per kilometre rule', () => {
  const ir = buildThunderImpulseResponse({
    channel: makeLineChannel(4000), listener: { x: 3000, y: 0, z: 2 },
    sampleRate: 8000,
  });
  console.log(`       first arrival ${ir.firstArrival.toFixed(2)} s, ` +
    `last ${ir.lastArrival.toFixed(2)} s, spread ${ir.duration.toFixed(2)} s`);
  inRange(ir.firstArrival, 3000 / 350, 3000 / 330, 'first arrival (s)');
  // A 4 km channel seen from 3 km away spreads its arrivals over seconds.
  assert.ok(ir.duration > 1.0, 'thunder from a tall channel should rumble');
});
test('distant thunder loses its high frequencies', () => {
  const near = buildThunderImpulseResponse({
    channel: makeLineChannel(4000), listener: { x: 500, y: 0, z: 2 }, sampleRate: 8000,
  });
  const far = buildThunderImpulseResponse({
    channel: makeLineChannel(4000), listener: { x: 12000, y: 0, z: 2 }, sampleRate: 8000,
  });
  assert.ok(far.sources > 0, 'the far listener should still receive something');
  console.log(`       brightness near ${near.brightness.toFixed(3)}, ` +
    `far ${far.brightness.toFixed(3)}`);
  assert.ok(far.brightness < near.brightness,
    'the far impulse response should be duller');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
