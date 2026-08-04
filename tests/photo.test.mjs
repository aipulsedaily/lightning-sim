/**
 * photo.test.mjs — the photo-to-3D pipeline, headless.
 *
 * The browser-only parts (decoding, WebGL, the neural model) are not
 * exercised here. What is exercised is the geometry, which is where the
 * pipeline is either right or wrong:
 *
 *   - the camera model puts the horizon at zero elevation;
 *   - the two-plane intersection returns the distances trigonometry says
 *     it should;
 *   - and the reconstruction keeps every vertex on its own ray, which is
 *     the invariant that makes the photograph reproject exactly no matter
 *     how much relief is applied.
 *
 *   node tests/photo.test.mjs
 */

import assert from 'node:assert/strict';
import { analyze, makeCameraModel, guessProjection } from '../src/photo/analyze.js';
import { planeDepth, geometricDepth, fitDisparityToMetres, DEPTH_DEFAULTS }
  from '../src/photo/depth.js';
import { reconstruct } from '../src/photo/reconstruct.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function close(a, b, tol, what) {
  assert.ok(Math.abs(a - b) <= tol,
    `${what}: ${a.toPrecision(6)} vs ${b.toPrecision(6)} (tol ${tol})`);
}

/** A synthetic photograph: smooth blue sky above, dark textured land below. */
function syntheticPhoto(w, h, horizonAt = 0.5, noise = 0.25) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    const isSky = y / h < horizonAt;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isSky) {
        const g = 150 + 60 * (1 - y / h);
        data[i] = g * 0.72; data[i + 1] = g * 0.85; data[i + 2] = 255;
      } else {
        const n = rnd() * noise;
        data[i] = 60 * (0.5 + n); data[i + 1] = 52 * (0.5 + n); data[i + 2] = 40 * (0.5 + n);
      }
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

console.log('\nimage analysis');
test('finds a clean horizon and says it is confident', () => {
  const a = analyze(syntheticPhoto(200, 140, 0.55));
  console.log(`       horizon at ${a.horizonRow.toFixed(3)} ` +
    `(true 0.550), confidence ${a.horizonConfidence.toFixed(2)}, ` +
    `sky ${(a.skyFraction * 100).toFixed(0)}%`);
  close(a.horizonRow, 0.55, 0.05, 'detected horizon row');
  assert.ok(a.horizonConfidence > 0.5, 'should be confident about an obvious horizon');
  assert.ok(a.skyFraction > 0.3 && a.skyFraction < 0.75, 'sky fraction');
});
test('reports low confidence when there is no horizon', () => {
  // Uniform noise: nothing to separate.
  const w = 160, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < w * h; i++) {
    const g = 90 + rnd() * 70;
    data[i * 4] = g; data[i * 4 + 1] = g; data[i * 4 + 2] = g; data[i * 4 + 3] = 255;
  }
  const a = analyze({ width: w, height: h, data });
  console.log(`       confidence on featureless noise: ${a.horizonConfidence.toFixed(3)}`);
  assert.ok(a.horizonConfidence < 0.45,
    `should not claim a horizon it cannot see (${a.horizonConfidence.toFixed(2)})`);
});
test('sky mask separates sky from land', () => {
  const a = analyze(syntheticPhoto(200, 140, 0.5));
  let skyAbove = 0, skyBelow = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      if (y < a.h * 0.4) skyAbove += a.sky[y * a.w + x];
      if (y > a.h * 0.6) skyBelow += a.sky[y * a.w + x];
    }
  }
  skyAbove /= a.w * a.h * 0.4; skyBelow /= a.w * a.h * 0.4;
  console.log(`       mean sky score: above ${skyAbove.toFixed(2)}, below ${skyBelow.toFixed(2)}`);
  assert.ok(skyAbove > 0.6 && skyBelow < 0.35, 'mask should be decisive');
});
test('a panorama is recognised as cylindrical', () => {
  assert.equal(guessProjection(1.5), 'rectilinear');
  assert.equal(guessProjection(2.53), 'cylindrical');   // the Sorrento test shot
});

console.log('\ncamera model');
for (const projection of ['rectilinear', 'cylindrical']) {
  test(`${projection}: the horizon row has zero elevation`, () => {
    for (const hr of [0.3, 0.5, 0.72]) {
      const cam = makeCameraModel({ fovDeg: 55, horizonRow: hr, height: 5, aspect: 2, projection });
      for (const u of [0.1, 0.5, 0.9]) {
        const d = cam.ray(u, hr);
        close(d.y, 0, 2e-6, `dir.y at the horizon (u=${u}, row=${hr})`);
      }
    }
  });
  test(`${projection}: rays above the horizon point up, below point down`, () => {
    const cam = makeCameraModel({ fovDeg: 60, horizonRow: 0.45, height: 5, aspect: 2, projection });
    assert.ok(cam.ray(0.5, 0.1).y > 0, 'a row above the horizon');
    assert.ok(cam.ray(0.5, 0.9).y < 0, 'a row below the horizon');
  });
  test(`${projection}: every ray is a unit vector`, () => {
    const cam = makeCameraModel({ fovDeg: 70, horizonRow: 0.6, height: 5, aspect: 2.5, projection });
    for (const u of [0, 0.25, 0.5, 1]) {
      for (const v of [0, 0.33, 0.66, 1]) {
        const d = cam.ray(u, v);
        close(Math.hypot(d.x, d.y, d.z), 1, 1e-6, 'ray length');
      }
    }
  });
}
test('a cylindrical panorama sweeps its rays around in azimuth', () => {
  const cam = makeCameraModel({
    fovDeg: 55, horizonRow: 0.5, height: 5, aspect: 2.53,
    projection: 'cylindrical', hFovDeg: 140,
  });
  const left = cam.ray(0.0, 0.5), mid = cam.ray(0.5, 0.5), right = cam.ray(1.0, 0.5);
  const az = (d) => (Math.atan2(d.x, -d.z) * 180) / Math.PI;
  console.log(`       azimuths across the frame: ${az(left).toFixed(1)}, ` +
    `${az(mid).toFixed(1)}, ${az(right).toFixed(1)} degrees`);
  close(az(left), -70, 0.5, 'left edge azimuth');
  close(az(mid), 0, 0.5, 'centre azimuth');
  close(az(right), 70, 0.5, 'right edge azimuth');
});

console.log('\ntwo-plane depth');
test('a ground ray lands where trigonometry says', () => {
  const h = 50;
  for (const deg of [1, 5, 30, 60]) {
    const rad = (deg * Math.PI) / 180;
    // A very large clamp so the soft blend is effectively out of the way.
    const t = planeDepth(-Math.sin(rad), h, 1600, 1e12);
    close(t, h / Math.sin(rad), 1e-5 * t, `slant range at ${deg} deg below horizontal`);
    close(t * Math.cos(rad), h / Math.tan(rad), 1e-5 * t, `ground distance at ${deg} deg`);
  }
});
test('a sky ray meets the cloud deck', () => {
  const h = 5, base = 1600;
  for (const deg of [2, 15, 45]) {
    const rad = (deg * Math.PI) / 180;
    const t = planeDepth(Math.sin(rad), h, base, 1e12);
    close(h + t * Math.sin(rad), base, 1e-5 * base, `cloud base reached at ${deg} deg`);
  }
});
test('the horizon folds smoothly into a curtain rather than to infinity', () => {
  const maxRange = 30000;
  let prev = 0;
  for (const deg of [8, 4, 2, 1, 0.5, 0.1, 0.01]) {
    const t = planeDepth(-Math.sin((deg * Math.PI) / 180), 50, 1600, maxRange);
    assert.ok(t <= maxRange + 1e-6, `never past the clamp (${t.toFixed(0)} m)`);
    assert.ok(t > prev, 'distance should keep increasing towards the horizon');
    prev = t;
  }
  close(planeDepth(0, 50, 1600, maxRange), maxRange, 1, 'exactly level');
  console.log(`       0.01 deg below horizontal -> ${(prev / 1000).toFixed(1)} km ` +
    `(clamp ${maxRange / 1000} km)`);
});
test('depth over a whole synthetic frame stays inside its bounds', () => {
  const a = analyze(syntheticPhoto(160, 120, 0.5));
  const cam = makeCameraModel({ fovDeg: 55, horizonRow: a.horizonRow, height: 40, aspect: a.aspect });
  const d = geometricDepth(a, cam, { cameraHeight: 40 });
  let lo = Infinity, hi = 0;
  for (const t of d) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
  console.log(`       depth range ${lo.toFixed(0)} m to ${(hi / 1000).toFixed(1)} km`);
  assert.ok(lo >= DEPTH_DEFAULTS.minRange - 1e-6, 'nothing closer than the near limit');
  assert.ok(hi <= DEPTH_DEFAULTS.maxRange + 1e-6, 'nothing past the far limit');
  assert.ok(hi / lo > 20, 'a scene with a horizon should span a wide depth range');
});

console.log('\nfitting neural depth to metres');
test('recovers the scale of a disparity map it has never seen', () => {
  const a = analyze(syntheticPhoto(120, 90, 0.5));
  const cam = makeCameraModel({ fovDeg: 55, horizonRow: a.horizonRow, height: 30, aspect: a.aspect });
  const geo = geometricDepth(a, cam, { cameraHeight: 30 });
  // Pretend a network returned disparity = 1/depth under an unknown
  // affine transform, exactly as an affine-invariant model would.
  const A = 137.4, B = -0.0021;
  const disparity = new Float32Array(geo.length);
  for (let i = 0; i < geo.length; i++) disparity[i] = (1 / geo[i] - B) / A;

  const fit = fitDisparityToMetres(disparity, geo, a, { cameraHeight: 30 });
  assert.ok(fit.ok, 'the fit should succeed');
  let worst = 0;
  for (let i = 0; i < geo.length; i++) {
    worst = Math.max(worst, Math.abs(fit.depth[i] - geo[i]) / geo[i]);
  }
  console.log(`       recovered a=${fit.a.toPrecision(5)} (true ${A}), ` +
    `worst depth error ${(worst * 100).toFixed(3)}%`);
  assert.ok(worst < 0.02, `should recover metres to within 2% (got ${(worst * 100).toFixed(1)}%)`);
});
test('refuses a degenerate disparity map instead of inverting the scene', () => {
  const a = analyze(syntheticPhoto(80, 60, 0.5));
  const cam = makeCameraModel({ fovDeg: 55, horizonRow: 0.5, height: 20, aspect: a.aspect });
  const geo = geometricDepth(a, cam, { cameraHeight: 20 });
  const flat = new Float32Array(geo.length).fill(0.5);   // no information at all
  const fit = fitDisparityToMetres(flat, geo, a, { cameraHeight: 20 });
  assert.equal(fit.ok, false, 'a constant disparity map carries no depth');
  assert.deepEqual(Array.from(fit.depth.slice(0, 8)), Array.from(geo.slice(0, 8)));
});

console.log('\nmesh reconstruction');
test('rows are concentrated towards the horizon', () => {
  const a = analyze(syntheticPhoto(160, 120, 0.5));
  const cam = makeCameraModel({ fovDeg: 55, horizonRow: 0.5, height: 30, aspect: a.aspect });
  const depth = geometricDepth(a, cam, { cameraHeight: 30 });
  const m = reconstruct({ analysis: a, camera: cam, depth, gridWidth: 120 });

  // Row spacing should shrink as rows approach the horizon, because that
  // is where all the depth range of a two-plane scene lives.
  const gapAt = (v) => {
    let best = 0, bestGap = 0;
    for (let j = 1; j <= m.gridHeight; j++) {
      const mid = (m.rowV[j] + m.rowV[j - 1]) / 2;
      if (best === 0 || Math.abs(mid - v) < Math.abs(best - v)) {
        best = mid; bestGap = m.rowV[j] - m.rowV[j - 1];
      }
    }
    return bestGap;
  };
  const nearHorizon = gapAt(0.52);
  const farFromIt = gapAt(0.95);
  console.log(`       row spacing: ${nearHorizon.toExponential(2)} at the horizon, ` +
    `${farFromIt.toExponential(2)} at the frame edge`);
  assert.ok(nearHorizon < farFromIt * 0.5,
    'rows should bunch up near the horizon');
  // And the mapping must stay monotonic, or the mesh folds over itself.
  for (let j = 1; j <= m.gridHeight; j++) {
    assert.ok(m.rowV[j] > m.rowV[j - 1], `row ${j} must be below row ${j - 1}`);
  }
});
test('every vertex stays on its own ray', () => {
  // This is the invariant that makes the photograph reproject exactly:
  // relief moves points along their rays, never across them.
  for (const projection of ['rectilinear', 'cylindrical']) {
    const a = analyze(syntheticPhoto(160, 120, 0.5));
    const cam = makeCameraModel({
      fovDeg: 55, horizonRow: a.horizonRow, height: 35, aspect: a.aspect, projection,
    });
    const depth = geometricDepth(a, cam, { cameraHeight: 35, skyRelief: 0.3, groundRelief: 0.2 });
    const m = reconstruct({ analysis: a, camera: cam, depth, gridWidth: 96 });

    const gw = m.gridWidth, gh = m.gridHeight;
    let worst = 0;
    for (let j = 0; j <= gh; j += 7) {
      for (let i = 0; i <= gw; i += 7) {
        const k = j * (gw + 1) + i;
        // Use the coordinates the mesh actually landed on: rows are
        // warped towards the horizon, so recomputing them uniformly here
        // would test the wrong ray.
        const d = cam.ray(m.colU[i], m.rowV[j]);
        const px = m.positions[k * 3];
        const py = m.positions[k * 3 + 1] - cam.height;
        const pz = m.positions[k * 3 + 2];
        const len = Math.hypot(px, py, pz);
        if (len < 1e-6) continue;
        // The angle between the vertex and the ray it came from.
        const cos = (px * d.x + py * d.y + pz * d.z) / len;
        worst = Math.max(worst, Math.acos(Math.min(1, cos)));
      }
    }
    console.log(`       ${projection}: worst deviation from its ray ` +
      `${((worst * 180) / Math.PI).toExponential(2)} degrees`);
    assert.ok(worst < 1e-5, `${projection}: vertices must not leave their rays`);
  }
});
test('tears at depth discontinuities instead of stretching', () => {
  const a = analyze(syntheticPhoto(160, 120, 0.5));
  const cam = makeCameraModel({ fovDeg: 55, horizonRow: 0.5, height: 30, aspect: a.aspect });
  const depth = geometricDepth(a, cam, { cameraHeight: 30 });
  // Punch a near object into the middle of the frame, as a foreground
  // wall or a person would be.
  for (let y = 40; y < 80; y++) for (let x = 40; x < 80; x++) depth[y * a.w + x] = 12;

  const loose = reconstruct({ analysis: a, camera: cam, depth, gridWidth: 120, tearRatio: 100 });
  const tight = reconstruct({ analysis: a, camera: cam, depth, gridWidth: 120, tearRatio: 2.2 });
  console.log(`       quads dropped: ${(loose.tearFraction * 100).toFixed(1)}% at ratio 100, ` +
    `${(tight.tearFraction * 100).toFixed(1)}% at ratio 2.2`);
  assert.ok(tight.quadsTorn > loose.quadsTorn, 'a tighter ratio should tear more');
  assert.ok(tight.tearFraction > 0.002, 'the inserted silhouette should tear');
  assert.ok(tight.tearFraction < 0.35, 'but it should not shred the whole mesh');
});
test('mesh stays inside its vertex budget and indexes validly', () => {
  const a = analyze(syntheticPhoto(200, 80, 0.5));
  const cam = makeCameraModel({ fovDeg: 55, horizonRow: 0.5, height: 10, aspect: a.aspect });
  const depth = geometricDepth(a, cam, { cameraHeight: 10 });
  const m = reconstruct({ analysis: a, camera: cam, depth, gridWidth: 900, vertexBudget: 20000 });
  const nv = m.positions.length / 3;
  console.log(`       ${nv} vertices, ${m.index.length / 3} triangles, ` +
    `${m.index.constructor.name}`);
  assert.ok(nv <= 20000 * 1.15, `vertex budget respected (${nv})`);
  for (let i = 0; i < m.index.length; i++) {
    assert.ok(m.index[i] < nv, 'every index is in range');
  }
  for (let i = 0; i < m.positions.length; i++) {
    assert.ok(Number.isFinite(m.positions[i]), 'no NaN positions');
  }
  for (let i = 0; i < m.normals.length; i += 3) {
    const l = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
    close(l, 1, 1e-4, 'normals are unit length');
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
