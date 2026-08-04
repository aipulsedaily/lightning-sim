/**
 * rng.js — deterministic, seedable randomness.
 *
 * A lightning flash is a stochastic object: step directions, branching,
 * peak currents and interstroke intervals are all drawn from measured
 * distributions. Seeding them means a flash you liked can be replayed
 * exactly, and a bug in the leader can be reproduced.
 */

/** mulberry32: small, fast, passes gjrand; period 2^32. */
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  const rng = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Uniform on [lo, hi). */
  rng.range = (lo, hi) => lo + (hi - lo) * rng();

  /** Integer on [0, n). */
  rng.int = (n) => Math.floor(rng() * n) % n;

  /** Standard normal, Box-Muller (cached pair). */
  let spare = null;
  rng.normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  };

  /**
   * Log-normal with a given median and sigma of ln(x). This is the
   * distribution nature actually uses for peak current, interstroke
   * interval, step length and flash duration.
   */
  rng.logNormal = (median, sigmaLn) => median * Math.exp(sigmaLn * rng.normal());

  /** Random unit vector, uniform on the sphere. */
  rng.unitVector = (out = { x: 0, y: 0, z: 0 }) => {
    const z = rng() * 2 - 1;
    const t = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.x = r * Math.cos(t);
    out.y = r * Math.sin(t);
    out.z = z;
    return out;
  };

  /** Pick an index from an array of non-negative weights. */
  rng.weightedIndex = (weights, total) => {
    let sum = total;
    if (sum === undefined) {
      sum = 0;
      for (let i = 0; i < weights.length; i++) sum += weights[i];
    }
    if (!(sum > 0)) return rng.int(weights.length);
    let x = rng() * sum;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x <= 0) return i;
    }
    return weights.length - 1;
  };

  rng.pick = (arr) => arr[rng.int(arr.length)];
  rng.chance = (p) => rng() < p;
  rng.reseed = (s) => { a = s >>> 0; spare = null; };

  return rng;
}

/**
 * Quasi-uniform points on a sphere via the Fibonacci lattice. Used to
 * build the DBM candidate set: a continuum stand-in for the 26 lattice
 * neighbours of the original Niemeyer-Pietronero-Wiesmann model, with
 * none of the axis-aligned artefacts a cubic lattice would impose on
 * the channel's shape.
 */
export function fibonacciSphere(n) {
  const pts = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = golden * i;
    pts[i * 3] = r * Math.cos(th);
    pts[i * 3 + 1] = r * Math.sin(th);
    pts[i * 3 + 2] = z;
  }
  return pts;
}

/** Deterministic 32-bit hash of a string, for turning names into seeds. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
