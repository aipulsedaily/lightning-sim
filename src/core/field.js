/**
 * field.js — the electrostatic engine.
 *
 * Everything a lightning flash does is decided by one scalar field: the
 * electrostatic potential. This module computes it by the *charge
 * simulation method*, the same approach used by published 3-D fractal
 * lightning models (Mansell et al. 2002, Riousset et al. 2007):
 *
 *   1. The thundercloud's charge regions are represented by clusters of
 *      softened point charges arranged in oblate ("pancake") shapes,
 *      because real charge layers are horizontally extensive and only a
 *      kilometre or so deep. The far field of a cluster is exactly that
 *      of the total charge, so the large-scale field is right by
 *      construction while the near field stays finite and smooth.
 *
 *   2. The ground is a perfect conductor at z = 0, imposed exactly by
 *      the method of images: every charge q at height z gets a partner
 *      -q at -z. This is what makes the potential vanish on the ground
 *      plane and what draws the leader downward once it is low enough.
 *
 *   3. The growing leader channel is itself a set of charges. Each
 *      segment carries the line charge density a corona-shrouded
 *      conductor at potential difference dPhi from its surroundings
 *      would hold:
 *
 *          lambda = 2 pi eps0 * dPhi / ln(R_corona / r_core)
 *
 *      With dPhi ~ 50 MV, R = 5 m and r = 5 mm this gives ~4e-4 C/m and
 *      a total of ~5 C over a branched 15 km channel — both squarely
 *      inside the measured range. That agreement is not tuned; it falls
 *      out of the cylindrical capacitance of a leader.
 *
 * The expensive part is step 3, since the channel grows to thousands of
 * charges and the DBM needs the potential at ~1000 candidate points per
 * growth round. The solution here is a two-scale split: distant charges
 * are lumped into a coarse grid and expanded to first order about each
 * leader tip (they vary slowly over one step length), while charges
 * within a few hundred metres are summed exactly, because it is exactly
 * that near field — the channel screening itself — that decides which
 * way a branch turns.
 */

import { K_E } from './constants.js';

/* ================================================================== *
 * Ambient field: the thundercloud
 * ================================================================== */

/** Error function, Abramowitz & Stegun 7.1.26. |error| < 1.5e-7. */
export function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

const SQRT2 = Math.SQRT2;
const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);

/** Points of a hexagonal lattice covering a disc of the given radius. */
function hexDisc(radius, spacing) {
  const pts = [];
  const dy = spacing * 0.8660254;
  const ny = Math.ceil(radius / dy);
  const nx = Math.ceil(radius / spacing) + 1;
  const r2 = radius * radius;
  for (let j = -ny; j <= ny; j++) {
    const py = j * dy;
    const off = (j & 1) ? spacing * 0.5 : 0;
    for (let i = -nx; i <= nx; i++) {
      const px = i * spacing + off;
      if (px * px + py * py <= r2) pts.push(px, py);
    }
  }
  return pts;
}

/**
 * Lay out a horizontally extensive charge layer as a hexagonal lattice of
 * *Gaussian* charge blobs.
 *
 * The choice of a Gaussian rather than a softened point matters. A
 * Gaussian ball of charge has an exact, everywhere-smooth potential,
 *
 *     phi(r) = k_e q erf(r / (sqrt(2) sigma)) / r
 *
 * that becomes indistinguishable from a point charge beyond ~4 sigma, so
 * the far field is right by construction while nothing inside the cloud
 * ever sees the lumpiness of the discretisation. Spacing the blobs at
 * about one sigma makes the composite a genuinely smooth pancake — which
 * is what a real charge layer is, a kilometre thick and several across,
 * not a ball.
 *
 * Getting this right is not cosmetic: the leader chooses its direction
 * from potential differences of a few percent, so numerical lumps in the
 * ambient field would show up directly as spurious branches.
 */
function buildRegionSources(region, targetCount = 61) {
  const { x = 0, y = 0, z, radiusH, radiusV, charge } = region;
  const spacing = radiusH * Math.sqrt(Math.PI / (0.8660254 * targetCount));
  const sigma = Math.max(0.62 * radiusV, 0.60 * spacing);
  const disc = hexDisc(radiusH, spacing);

  const n = disc.length / 2;
  const w = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const px = disc[i * 2], py = disc[i * 2 + 1];
    // Gaussian horizontal profile: charge density peaks at the centre of
    // the layer and tapers at the edges, as soundings show.
    const wi = Math.exp(-1.5 * (px * px + py * py) / (radiusH * radiusH));
    w[i] = wi; wsum += wi;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(x + disc[i * 2], y + disc[i * 2 + 1], z, charge * w[i] / wsum, sigma);
  }
  return out;
}

export class AmbientField {
  /**
   * @param {Array} regions  charge regions {x,y,z,radiusH,radiusV,charge}
   * @param {boolean} groundPlane  impose a perfectly conducting earth
   */
  constructor(regions, groundPlane = true) {
    this.regions = regions;
    this.groundPlane = groundPlane;
    this.rebuild();
  }

  rebuild() {
    const src = [];
    for (const r of this.regions) {
      if (!r || r.charge === 0) continue;
      src.push(...buildRegionSources(r));
    }

    // Real charges followed by their ground images (-q at -z).
    const n = src.length / 5;
    const total = this.groundPlane ? n * 2 : n;
    const s = new Float64Array(total * 5);
    s.set(src, 0);
    if (this.groundPlane) {
      for (let i = 0; i < n; i++) {
        s[(n + i) * 5 + 0] = src[i * 5 + 0];
        s[(n + i) * 5 + 1] = src[i * 5 + 1];
        s[(n + i) * 5 + 2] = -src[i * 5 + 2];
        s[(n + i) * 5 + 3] = -src[i * 5 + 3];
        s[(n + i) * 5 + 4] = src[i * 5 + 4];
      }
    }
    this.sources = s;
    this.count = total;

    this.netCharge = 0;
    for (const r of this.regions) if (r) this.netCharge += r.charge;
  }

  /**
   * Potential (V) and electric field (V/m) at a point.
   * Writes into `out` to avoid allocation in the growth inner loop.
   *
   * Beyond four sigma the Gaussian is a point charge to better than one
   * part in 10^8, so the expensive branch is taken only for the handful
   * of blobs a query is actually sitting inside.
   */
  eval(x, y, z, out = { phi: 0, ex: 0, ey: 0, ez: 0 }) {
    const s = this.sources;
    let phi = 0, ex = 0, ey = 0, ez = 0;
    for (let i = 0, n = this.count * 5; i < n; i += 5) {
      const dx = x - s[i], dy = y - s[i + 1], dz = z - s[i + 2];
      const r2 = dx * dx + dy * dy + dz * dz;
      const sig = s[i + 4];
      const kq = K_E * s[i + 3];
      if (r2 > 16 * sig * sig) {
        const inv = 1 / Math.sqrt(r2);
        const p = kq * inv;
        phi += p;
        const g = p * inv * inv;
        ex += g * dx; ey += g * dy; ez += g * dz;
      } else {
        const r = Math.sqrt(r2);
        if (r < 1e-6) {
          phi += kq * SQRT_2_OVER_PI / sig;
          continue;
        }
        const u = r / (SQRT2 * sig);
        const e = erf(u);
        phi += kq * e / r;
        // E_r = k q [ erf(u)/r^2 - sqrt(2/pi) exp(-u^2) / (sigma r) ]
        const Er = kq * (e / r2 - SQRT_2_OVER_PI * Math.exp(-u * u) / (sig * r));
        const g = Er / r;
        ex += g * dx; ey += g * dy; ez += g * dz;
      }
    }
    out.phi = phi; out.ex = ex; out.ey = ey; out.ez = ez;
    return out;
  }

  potential(x, y, z) {
    return this.eval(x, y, z, TMP).phi;
  }

  fieldMagnitude(x, y, z) {
    const o = this.eval(x, y, z, TMP);
    return Math.hypot(o.ex, o.ey, o.ez);
  }
}

const TMP = { phi: 0, ex: 0, ey: 0, ez: 0 };

/* ================================================================== *
 * Channel charges: the leader's own space charge
 * ================================================================== */

const GROWTH = 4096;

export class ChannelCharges {
  /**
   * @param {number} cellSize  coarse-grid cell size for the far field (m)
   * @param {boolean} groundPlane
   */
  constructor(cellSize = 250, groundPlane = true) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
    this.groundPlane = groundPlane;
    this.n = 0;
    this.x = new Float64Array(GROWTH);
    this.y = new Float64Array(GROWTH);
    this.z = new Float64Array(GROWTH);
    this.q = new Float64Array(GROWTH);
    /** cellKey -> {q, mx,my,mz (charge-weighted moments), idx: number[]} */
    this.cells = new Map();
    /** flat list of cell summaries, rebuilt lazily for fast iteration */
    this.cellList = [];
    this.cellsDirty = true;
    this.totalCharge = 0;
    /** softening so a query sitting on a charge does not blow up */
    this.soft2 = 4.0;
  }

  clear() {
    this.n = 0;
    this.cells.clear();
    this.cellList.length = 0;
    this.cellsDirty = true;
    this.totalCharge = 0;
  }

  _grow() {
    const cap = this.x.length * 2;
    const gx = new Float64Array(cap); gx.set(this.x);
    const gy = new Float64Array(cap); gy.set(this.y);
    const gz = new Float64Array(cap); gz.set(this.z);
    const gq = new Float64Array(cap); gq.set(this.q);
    this.x = gx; this.y = gy; this.z = gz; this.q = gq;
  }

  key(ix, iy, iz) {
    // 21 bits each, offset to keep positive; ample for a 100 km domain.
    return ((ix + 1048576) * 2097152 + (iy + 1048576)) * 2097152 + (iz + 1048576);
  }

  add(x, y, z, q) {
    if (this.n >= this.x.length) this._grow();
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.q[i] = q;
    this.totalCharge += q;

    const ix = Math.floor(x * this.invCell);
    const iy = Math.floor(y * this.invCell);
    const iz = Math.floor(z * this.invCell);
    const k = this.key(ix, iy, iz);
    let c = this.cells.get(k);
    if (!c) {
      c = { q: 0, mx: 0, my: 0, mz: 0, cx: 0, cy: 0, cz: 0, idx: [], ix, iy, iz };
      this.cells.set(k, c);
      this.cellsDirty = true;
    }
    c.q += q;
    // Geometric centroid: it stays put when charges are later revised,
    // which they are on every round as the channel's floating potential
    // moves. A charge-weighted centroid would jitter and invalidate the
    // near/far split.
    c.mx += x; c.my += y; c.mz += z;
    c.idx.push(i);
    const m = c.idx.length;
    c.cx = c.mx / m; c.cy = c.my / m; c.cz = c.mz / m;
    return i;
  }

  /** Overwrite one charge without touching the geometry. */
  setCharge(i, q) {
    this.totalCharge += q - this.q[i];
    this.q[i] = q;
  }

  /** Re-sum the coarse-grid cell totals after a bulk charge update. */
  refreshCells() {
    this._syncCells();
    for (let ci = 0; ci < this.cellList.length; ci++) {
      const c = this.cellList[ci];
      let s = 0;
      const idx = c.idx;
      for (let j = 0; j < idx.length; j++) s += this.q[idx[j]];
      c.q = s;
    }
  }

  _syncCells() {
    if (!this.cellsDirty) return;
    this.cellList = Array.from(this.cells.values());
    this.cellsDirty = false;
  }

  /**
   * Build a local view of the channel's field about a point.
   *
   * Returns:
   *   phi, ex, ey, ez   — first-order expansion of the *far* charges
   *   near              — indices of individual charges inside rNear,
   *                       plus their ground images when those are close
   *                       enough to matter (they are, near the surface).
   *
   * The far part is re-expanded about `center` each call, but it only
   * costs one term per occupied coarse cell, so a 20 km branched channel
   * is a few hundred operations.
   */
  buildLocal(cx, cy, cz, rNear, out) {
    this._syncCells();
    const res = out || { phi: 0, ex: 0, ey: 0, ez: 0, near: [], nearImg: [] };
    res.phi = 0; res.ex = 0; res.ey = 0; res.ez = 0;
    res.near.length = 0; res.nearImg.length = 0;
    res.cx = cx; res.cy = cy; res.cz = cz;

    const rNear2 = rNear * rNear;
    const cell = this.cellSize;
    // A cell counts as "near" if any part of it could fall within rNear.
    const cellDiag = cell * 0.8660254; // half diagonal
    const nearCellR = rNear + cellDiag;
    const nearCellR2 = nearCellR * nearCellR;

    for (let ci = 0; ci < this.cellList.length; ci++) {
      const c = this.cellList[ci];
      const dx = cx - c.cx, dy = cy - c.cy, dz = cz - c.cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < nearCellR2) {
        // Resolve this cell charge-by-charge.
        const idx = c.idx;
        for (let j = 0; j < idx.length; j++) {
          const i = idx[j];
          const ex = cx - this.x[i], ey = cy - this.y[i], ez = cz - this.z[i];
          if (ex * ex + ey * ey + ez * ez < rNear2) res.near.push(i);
          else this._accumFar(res, this.x[i], this.y[i], this.z[i], this.q[i], cx, cy, cz);
        }
      } else {
        this._accumFar(res, c.cx, c.cy, c.cz, c.q, cx, cy, cz);
      }

      if (this.groundPlane) {
        // Image cell: mirrored centroid, opposite charge.
        const idz = cz + c.cz;
        const id2 = dx * dx + dy * dy + idz * idz;
        if (id2 < nearCellR2) {
          const idx = c.idx;
          for (let j = 0; j < idx.length; j++) {
            const i = idx[j];
            const ex = cx - this.x[i], ey = cy - this.y[i], ez = cz + this.z[i];
            if (ex * ex + ey * ey + ez * ez < rNear2) res.nearImg.push(i);
            else this._accumFar(res, this.x[i], this.y[i], -this.z[i], -this.q[i], cx, cy, cz);
          }
        } else {
          this._accumFar(res, c.cx, c.cy, -c.cz, -c.q, cx, cy, cz);
        }
      }
    }
    return res;
  }

  _accumFar(res, sx, sy, sz, q, cx, cy, cz) {
    const dx = cx - sx, dy = cy - sy, dz = cz - sz;
    const r2 = dx * dx + dy * dy + dz * dz + this.soft2;
    const inv = 1 / Math.sqrt(r2);
    const kq = K_E * q;
    const p = kq * inv;
    res.phi += p;
    const g = p * inv * inv;
    res.ex += g * dx; res.ey += g * dy; res.ez += g * dz;
  }

  /**
   * Potential at a point given a previously built local view. The far
   * charges are taken to first order about the expansion centre — they
   * vary on a scale of hundreds of metres, so over one step length this
   * is essentially exact — while every near charge is summed properly.
   */
  potentialLocal(loc, x, y, z) {
    // phi_far(p) = phi(c) + grad phi . (p - c),  and grad phi = -E.
    let phi = loc.phi
      - (loc.ex * (x - loc.cx) + loc.ey * (y - loc.cy) + loc.ez * (z - loc.cz));

    const near = loc.near;
    const eps2 = this.soft2;
    for (let j = 0; j < near.length; j++) {
      const i = near[j];
      const dx = x - this.x[i], dy = y - this.y[i], dz = z - this.z[i];
      phi += K_E * this.q[i] / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
    }
    const img = loc.nearImg;
    for (let j = 0; j < img.length; j++) {
      const i = img[j];
      const dx = x - this.x[i], dy = y - this.y[i], dz = z + this.z[i];
      phi -= K_E * this.q[i] / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
    }
    return phi;
  }

  /**
   * Electric field at a point given a previously built local view.
   *
   * This — not the potential — is what the growth rule consumes. Working
   * in the field rather than in bond potential differences makes the
   * leader's own space charge behave correctly without any bookkeeping:
   * the charge sitting on the tip produces a field that drives growth
   * *forward*, while the charge on a neighbouring branch produces one
   * that pushes a candidate *away* from it. Forward enhancement and
   * lateral screening, the two things that shape a real channel, both
   * come out of the same Coulomb sum.
   *
   * The far charges are held at zeroth order about the expansion centre,
   * which is consistent with taking the potential to first order.
   */
  fieldLocal(loc, x, y, z, out) {
    let ex = loc.ex, ey = loc.ey, ez = loc.ez;
    const eps2 = this.soft2;

    const near = loc.near;
    for (let j = 0; j < near.length; j++) {
      const i = near[j];
      const dx = x - this.x[i], dy = y - this.y[i], dz = z - this.z[i];
      const r2 = dx * dx + dy * dy + dz * dz + eps2;
      const inv = 1 / Math.sqrt(r2);
      const g = K_E * this.q[i] * inv * inv * inv;
      ex += g * dx; ey += g * dy; ez += g * dz;
    }
    const img = loc.nearImg;
    for (let j = 0; j < img.length; j++) {
      const i = img[j];
      const dx = x - this.x[i], dy = y - this.y[i], dz = z + this.z[i];
      const r2 = dx * dx + dy * dy + dz * dz + eps2;
      const inv = 1 / Math.sqrt(r2);
      const g = -K_E * this.q[i] * inv * inv * inv;
      ex += g * dx; ey += g * dy; ez += g * dz;
    }
    out.ex = ex; out.ey = ey; out.ez = ez;
    return out;
  }

  /** Exact potential and field. Used for HUD readouts and inception tests. */
  eval(x, y, z, out = { phi: 0, ex: 0, ey: 0, ez: 0 }) {
    let phi = 0, ex = 0, ey = 0, ez = 0;
    const eps2 = this.soft2;
    for (let i = 0; i < this.n; i++) {
      let dx = x - this.x[i], dy = y - this.y[i], dz = z - this.z[i];
      let r2 = dx * dx + dy * dy + dz * dz + eps2;
      let inv = 1 / Math.sqrt(r2);
      let kq = K_E * this.q[i];
      let p = kq * inv;
      phi += p;
      let g = p * inv * inv;
      ex += g * dx; ey += g * dy; ez += g * dz;

      if (this.groundPlane) {
        dz = z + this.z[i];
        r2 = dx * dx + dy * dy + dz * dz + eps2;
        inv = 1 / Math.sqrt(r2);
        kq = -K_E * this.q[i];
        p = kq * inv;
        phi += p;
        g = p * inv * inv;
        ex += g * dx; ey += g * dy; ez += g * dz;
      }
    }
    out.phi = phi; out.ex = ex; out.ey = ey; out.ez = ez;
    return out;
  }
}

/* ================================================================== *
 * Combined view
 * ================================================================== */

export class FieldSolver {
  constructor(regions, opts = {}) {
    this.groundPlane = opts.groundPlane !== false;
    this.ambient = new AmbientField(regions, this.groundPlane);
    this.channel = new ChannelCharges(opts.cellSize || 250, this.groundPlane);
    this._a = { phi: 0, ex: 0, ey: 0, ez: 0 };
    this._c = { phi: 0, ex: 0, ey: 0, ez: 0 };
  }

  reset() { this.channel.clear(); }

  /** Exact total potential and field. */
  eval(x, y, z, out = { phi: 0, ex: 0, ey: 0, ez: 0 }) {
    this.ambient.eval(x, y, z, this._a);
    this.channel.eval(x, y, z, this._c);
    out.phi = this._a.phi + this._c.phi;
    out.ex = this._a.ex + this._c.ex;
    out.ey = this._a.ey + this._c.ey;
    out.ez = this._a.ez + this._c.ez;
    return out;
  }

  magnitude(x, y, z) {
    const o = this.eval(x, y, z, TMP2);
    return Math.hypot(o.ex, o.ey, o.ez);
  }

  /**
   * Vertical field just above the ground — what a field mill measures,
   * and what decides whether a grounded object launches an upward
   * connecting leader.
   *
   * Sign is the physics one: positive means E points upward. Fair weather
   * gives about -100 V/m (downward). Negative charge overhead reverses it
   * and drives it to several kV/m; a descending negative leader takes it
   * to tens of kV/m in the last moments before a strike. Directly beneath
   * a strong lower positive charge region the sign can flip back — the
   * field reversal that soundings under storm cores routinely see.
   */
  groundField(x, y) {
    const o = this.eval(x, y, 1.0, TMP2);
    return o.ez;
  }
}

const TMP2 = { phi: 0, ex: 0, ey: 0, ez: 0 };

/**
 * Cylindrical line-capacitance charge density of a leader channel.
 *
 *     lambda = 2 pi eps0 dPhi / ln(R_corona / r_core)
 *
 * dPhi is how far the channel's potential sits from the ambient
 * potential at that location. Near the origin the two agree and the
 * channel carries almost nothing; by the time the tip is near the
 * ground, where the conducting earth holds the ambient potential near
 * zero, dPhi is tens of megavolts and the channel is heavily charged.
 * That is precisely the charge the return stroke later neutralises.
 */
export function lineChargeDensity(dPhi, coronaRadius, coreRadius, cap) {
  const lambda = (2 * Math.PI * 8.8541878128e-12 * dPhi) /
    Math.log(Math.max(2, coronaRadius / coreRadius));
  if (cap === undefined) return lambda;
  return Math.max(-cap, Math.min(cap, lambda));
}

/**
 * Self-potential coefficient of one channel segment.
 *
 * A uniformly charged rod of length L and radius r0 sits at a potential
 *
 *     phi_self = q * 2 k_e ln(L / r0) / L
 *
 * relative to infinity. Inverting that gives the charge a segment must
 * carry to reach a prescribed potential once everything else in the
 * problem has had its say — which is one Gauss-Seidel sweep of the full
 * equipotential boundary condition.
 *
 * Doing it this way, incrementally, as each segment is created, is what
 * keeps the channel a conductor instead of a string of arbitrary point
 * charges. It also reproduces the right charge distribution for free:
 * segments added into virgin space carry a lot, segments added into a
 * region the rest of the structure has already pulled up to the channel
 * potential carry almost nothing. Charge ends up concentrated at the tip
 * and along outlying branches and is small deep inside the tree, exactly
 * as electrostatics demands.
 */
export function segmentSelfCoefficient(segLen, coreRadius) {
  const L = Math.max(segLen, coreRadius * 10);
  return 2 * K_E * Math.log(L / coreRadius) / L;   // volts per coulomb
}

/**
 * Charge for a new segment such that its own potential closes the gap
 * between the channel potential and what the rest of the world already
 * provides at that point.
 */
export function segmentCharge(phiChannel, phiExternal, segLen, coreRadius, capLambda) {
  const coeff = segmentSelfCoefficient(segLen, coreRadius);
  let q = (phiChannel - phiExternal) / coeff;
  if (capLambda !== undefined) {
    const qMax = capLambda * segLen;
    if (q > qMax) q = qMax; else if (q < -qMax) q = -qMax;
  }
  return q;
}
