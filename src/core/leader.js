/**
 * leader.js - stepped-leader propagation by the Dielectric Breakdown Model.
 *
 * Niemeyer, Pietronero and Wiesmann (1984) proposed that a branched
 * discharge can be grown one bond at a time from a stochastic rule whose
 * only input is the local electric field:
 *
 *     p_i  =  (E_i - E_c)^eta / sum_j (E_j - E_c)^eta      for E_i > E_c
 *
 * eta selects the morphology, and with it the fractal dimension:
 * eta = 0 gives a space-filling Eden cluster, eta = 1 reproduces
 * diffusion-limited aggregation, and large eta collapses the structure
 * to a single filament. Photographed lightning channels sit around
 * D = 1.1-1.4 in projection, which this model reaches for eta ~ 1.5-3.
 *
 * Three deliberate departures from the 1984 lattice formulation, each of
 * which makes the result more like real lightning rather than less:
 *
 *  - Candidates are drawn from a Fibonacci sphere rather than the 26
 *    neighbours of a cubic lattice. A lattice imprints its own axes on
 *    the channel; a real leader has no preferred direction, and a
 *    quasi-uniform direction set removes the artefact without changing
 *    the statistics of the rule.
 *
 *  - Every active tip advances once per round rather than one bond being
 *    chosen globally per iteration. Branches on a real leader grow
 *    simultaneously, and rounds give the simulation an honest clock:
 *    one round is one step, taking step_length / v_leader seconds.
 *
 *  - The threshold E_c is the density-scaled *leader* propagation field
 *    (~200 kV/m x delta for a negative leader, ~125 for a positive one),
 *    not the microscopic streamer or breakdown field. At a resolution of
 *    tens of metres the enormous field enhancement at the tip is
 *    unresolved, and this is the standard effective threshold used by
 *    3-D fractal lightning models.
 *
 * The asymmetry between the two thresholds is the reason positive
 * leaders are so much smoother and less branched than negative ones, and
 * therefore why a positive cloud-to-ground flash looks like a single
 * clean stroke while a negative one looks like a root system.
 */

import { DBM, STEPPED_LEADER, FIELDS } from './constants.js';
import { propagationField, stepLengthScale, relativeDensity } from './atmosphere.js';
import { segmentCharge, segmentSelfCoefficient } from './field.js';
import { fibonacciSphere } from './rng.js';
import { NODE } from './channel.js';

/** Precomputed candidate directions, +z forward. Trimmed to the forward cone. */
function buildCandidateSet(n, maxTurnCos) {
  const all = fibonacciSphere(n);
  const kept = [];
  for (let i = 0; i < n; i++) {
    const z = all[i * 3 + 2];
    if (z >= maxTurnCos) kept.push(all[i * 3], all[i * 3 + 1], z);
  }
  return new Float32Array(kept);
}

export class LeaderGrower {
  /**
   * @param {object} o
   *   solver   FieldSolver
   *   channel  Channel
   *   rng      seeded rng
   *   params   see defaults below
   */
  constructor(o) {
    this.solver = o.solver;
    this.channel = o.channel;
    this.rng = o.rng;
    /** Distinguishes this conductor's nodes from any other leader's. */
    this.id = o.id ?? (LeaderGrower._nextId = (LeaderGrower._nextId || 0) + 1);

    this.params = Object.assign({
      eta: DBM.ETA_DEFAULT,
      stepLength: 26,                 // m at sea level, scaled by 1/delta
      stepJitter: 0.35,
      candidates: 72,                 // sampled before the forward-cone trim
      maxTurnCos: DBM.MAX_TURN_COS,   // widest turn one step may take
      selfAvoid: DBM.SELF_AVOID_FACTOR,
      /**
       * Probability that a step also takes its strongest rival bond, when
       * that rival is as favourable as the one chosen. A stepped leader
       * makes tens of branches over hundreds of steps, so this is small.
       */
      branchiness: 0.10,
      branchMinAngleCos: Math.cos(0.38),  // ~22 deg from the chosen bond
      /**
       * Enough simultaneous growth points that branching is limited by the
       * field competition the DBM describes rather than by this number.
       * Branches starve themselves through `branchDrop`; the cap is only
       * here to bound the cost.
       */
      maxTips: 20,
      maxNodes: 5200,
      /**
       * A flash's in-cloud channel really does run to tens of kilometres —
       * intracloud discharges routinely span 5-10 km horizontally with
       * dense branching — so this bound is generous. It exists to stop a
       * runaway, not to shape the result.
       */
      maxChannelLength: 100000,
      /**
       * Current divides at every junction, so a deep branch is fed through
       * a longer, more resistive path and its tip sits at a lower
       * potential than the trunk's. Scaling the internal gradient with
       * branch generation is what starves higher-order branches and stops
       * the tree growing without bound - the same reason a real leader's
       * side branches peter out after a few hundred metres while the
       * trunk drives all the way to the ground.
       */
      branchDrop: 2.5,
      /** length of the corona/streamer zone the bond field is averaged over */
      streamerZone: 220,
      /** rounds a tip may sit below threshold before it is abandoned */
      maxStallRounds: 90,
      speed: STEPPED_LEADER.SPEED_MEDIAN,
      thresholdScale: 1.0,
      coronaRadius: STEPPED_LEADER.CORONA_RADIUS,
      coreRadius: STEPPED_LEADER.CORE_RADIUS,
      /**
       * Effective potential gradient along the leader channel.
       *
       * A stepped leader's tip is measured at around -50 MV by the time it
       * nears the ground, while the charge region it grew out of sits at
       * -100 to -200 MV. Losing over a hundred megavolts across five
       * kilometres of channel is a gradient of order 10 kV/m. This is not
       * the ohmic gradient of the thermalised core, which is a few hundred
       * volts per metre; it is the gradient of the whole leader system,
       * corona sheath and unthermalised sections included.
       *
       * It also keeps the growth rule honest. The DBM can only tell one
       * direction from another when the tip's overpotential is comparable
       * to (threshold field) x (streamer-zone length) — a few tens of
       * megavolts here. Without the drop the tip would sit hundreds of
       * megavolts away from its surroundings, every direction would clear
       * the threshold by the same overwhelming margin, and the leader
       * would random-walk instead of driving for the ground.
       */
      internalField: 7000,
      maxLineCharge: STEPPED_LEADER.LINE_CHARGE_MAX,
      /**
       * How strongly a step remembers the last one. Real stepped leaders
       * are tortuous but not diffusive — successive steps are correlated —
       * and this is what produces wander on several scales at once rather
       * than white-noise zigzag. Raising it straightens the channel and
       * lowers the ratio of path length to straight-line descent.
       */
      directionMemory: 0.85,
      groundZ: 0,
      /** called with (tipIndex, x, y, z) the first time a tip drops below
       *  `attachAltitude`; the flash sequencer uses it to run attachment. */
      onLowTip: null,
      attachAltitude: 400,
    }, o.params || {});

    this.dirs = buildCandidateSet(this.params.candidates, this.params.maxTurnCos);
    this.nDirs = this.dirs.length / 3;

    this.tips = [];
    this.originPotential = 0;
    this.floating = true;
    this._sumW = 0;
    this._sumNum = 0;
    this.simTime = 0;
    this.rounds = 0;
    this.stalled = false;
    this.groundContact = -1;
    this.lowTipReported = false;

    this._loc = { phi: 0, ex: 0, ey: 0, ez: 0, near: [], nearImg: [], cx: 0, cy: 0, cz: 0 };
    this._amb = { phi: 0, ex: 0, ey: 0, ez: 0 };
    this._w = new Float64Array(this.nDirs);
    this._cd = new Float64Array(this.nDirs * 3);
    this._ok = new Uint8Array(this.nDirs);
    /** running statistics for the HUD */
    this.stats = {
      steps: 0, branches: 0, deadTips: 0,
      lastStepLength: 0, lastTipField: 0, lastThreshold: 0,
      minAltitude: Infinity, chargeDeposited: 0,
      /**
       * Mean field-excess ratio of the bond actually taken against the
       * best available: (E_chosen - E_c) / (E_best - E_c), averaged over
       * every step. This is the cleanest measure of what eta does. At
       * eta = 0 the choice is uniform over admissible bonds and this sits
       * well below one; as eta rises the rule concentrates on the
       * strongest bond and it approaches one.
       *
       * Note it has to be the *field* ratio, not the weight ratio: the
       * weights are already raised to eta, so measuring those would
       * confound the thing being measured with the thing measuring it.
       */
      selectionSharpness: 0,
      _sharpSum: 0,
    };
  }

  /**
   * Start a bidirectional leader.
   *
   * Kasemir (1960) recognised that a lightning channel in a cloud is not
   * attached to anything: it is an isolated conductor that must carry
   * zero net charge. Its potential therefore *floats* to whatever value
   * makes the charges induced along it cancel - roughly the average of
   * the ambient potential over its own length.
   *
   * That single condition explains the whole opening act of a negative
   * cloud-to-ground flash. The positive end, needing a weaker field,
   * climbs first into the main negative charge region; as it does, the
   * average ambient potential over the channel plunges, dragging the
   * floating potential down with it; and only then does the negative end
   * find itself tens of megavolts below its surroundings and start
   * driving for the ground. The in-cloud leader has to tap the charge
   * reservoir before the visible bolt can go anywhere.
   */
  seed(x, y, z, upwardIsNegative) {
    const amb = this.solver.ambient.eval(x, y, z, this._amb);
    this.originPotential = amb.phi;
    this.floating = true;

    const down = upwardIsNegative ? +1 : -1;   // polarity of the downward end
    const up = -down;

    const a = this._spawnTree(x, y, z, 0, 0, -1, down);
    const b = this._spawnTree(x, y, z, 0, 0, +1, up);
    return { down: a, up: b };
  }

  /**
   * Start a single-ended leader. An upward connecting leader from a
   * grounded object is *not* floating: it is clamped to earth potential,
   * which is exactly why it can pour charge into the sky the way an
   * isolated in-cloud leader cannot.
   */
  seedSingle(x, y, z, dx, dy, dz, polarity, potential = 0) {
    this.originPotential = potential;
    this.floating = false;
    return this._spawnTree(x, y, z, dx, dy, dz, polarity);
  }

  _spawnTree(x, y, z, dx, dy, dz, polarity) {
    const phiAmb = this.solver.ambient.potential(x, y, z);
    const coeff = segmentSelfCoefficient(this.params.stepLength, this.params.coreRadius);
    const node = this.channel.add(x, y, z, -1, {
      flags: NODE.TIP, polarity, birth: this.simTime, owner: this.id,
      phiAmb, phiOther: 0, selfCoeff: coeff,
    });
    // Keep charge indices aligned 1:1 with node indices.
    this.solver.channel.add(x, y, z, 0);
    this._accumNeutrality(node, polarity, phiAmb, 0, coeff);
    const tip = {
      node, dx, dy, dz, polarity, alive: true, level: 0,
      arc: 0, steps: 0,
    };
    this.tips.push(tip);
    return tip;
  }

  /**
   * Running sums for the neutrality condition. Requiring sum(q_i) = 0 with
   * q_i = (phi_channel(i) - phi_external(i)) / coeff_i gives
   *
   *   phi_float = sum(w_i * (phi_ext_i + pol_i E_int arc_i)) / sum(w_i),
   *   w_i = 1 / coeff_i,
   *
   * and since coeff_i ~ 1/segment length, that is a length-weighted mean
   * of the ambient potential the channel has passed through.
   */
  _accumNeutrality(node, polarity, phiAmb, phiOther, coeff) {
    const w = 1 / coeff;
    this._sumW += w;
    this._sumNum += w * (phiAmb + phiOther
      + polarity * this.params.internalField * this.channel.dropLen[node]);
  }

  /**
   * Update the floating potential and re-solve every segment's charge.
   *
   * The closed form for the floating potential assumes every segment can
   * carry whatever charge the boundary condition asks of it. Segments hit
   * the physical ceiling on line charge density all the time — most of all
   * in a strong storm, where the potentials are largest — and once some of
   * them are pinned, that closed form no longer gives a neutral channel.
   *
   * So after assigning charges, any residual is nulled by shifting the
   * floating potential, counting only the segments that still have
   * headroom. A shift of dPhi moves each unpinned charge by dPhi/coeff, so
   * the correction is exact to first order and converges in a couple of
   * passes. Without it a saturated channel drifts to several coulombs of
   * net charge, and an isolated conductor cannot do that.
   */
  _relaxCharges() {
    const ch = this.channel;
    const cc = this.solver.channel;
    const P = this.params;
    if (this.floating && this._sumW > 0) {
      this.originPotential = this._sumNum / this._sumW;
    }
    const cap = P.maxLineCharge;
    const Eint = P.internalField;
    const mine = this.id;
    let phi = this.originPotential;

    const passes = this.floating ? 8 : 1;
    for (let pass = 0; pass < passes; pass++) {
      let net = 0, headroom = 0;
      for (let i = 0; i < ch.count; i++) {
        // Only this leader's own channel. The descending leader and an
        // upward connecting leader share the graph but not the boundary
        // condition, and solving one against the other's potential would
        // charge the whole flash to a nonsense value.
        if (ch.owner[i] !== mine) continue;
        const phiCh = phi - ch.polarity[i] * Eint * ch.dropLen[i];
        const coeff = ch.selfCoeff[i];
        let q = (phiCh - ch.phiAmb[i] - ch.phiOther[i]) / coeff;
        const qMax = cap * Math.max(ch.segLen[i], P.stepLength);
        if (q > qMax) q = qMax;
        else if (q < -qMax) q = -qMax;
        else headroom += 1 / coeff;
        net += q;
        ch.charge[i] = q;
        cc.setCharge(i, q);
      }
      if (!this.floating || headroom <= 0) break;
      if (Math.abs(net) < 1e-9) break;
      phi -= net / headroom;
    }
    this.originPotential = phi;
    cc.refreshCells();
  }

  get aliveTips() {
    let n = 0;
    for (const t of this.tips) if (t.alive) n++;
    return n;
  }

  get finished() {
    return this.stalled || this.aliveTips === 0 ||
      this.channel.count >= this.params.maxNodes ||
      this.channel.totalLength >= this.params.maxChannelLength;
  }

  /**
   * Advance every live tip by one step. Returns the simulated time the
   * round consumed, so the caller's clock stays physical: step length
   * divided by the measured mean leader speed.
   */
  round() {
    const P = this.params;
    if (this.finished) return 0;

    let stepSum = 0, stepCount = 0;
    const newTips = [];

    for (let ti = 0; ti < this.tips.length; ti++) {
      const tip = this.tips[ti];
      if (!tip.alive) continue;
      const grown = this._growTip(tip, newTips);
      if (grown > 0) { stepSum += grown; stepCount++; }
    }

    for (const t of newTips) {
      if (this.tips.length < P.maxTips * 3) this.tips.push(t);
    }
    this.rounds++;
    // The channel is one conductor: every new segment shifts its floating
    // potential, and every charge on it has to be re-solved.
    this._relaxCharges();

    // A round in which nothing advanced still takes time: the leader is
    // pausing between steps, which is precisely what "stepped" means.
    const ds = stepCount > 0 ? stepSum / stepCount : P.stepLength;
    const dt = ds / P.speed;
    this.simTime += dt;
    return dt;
  }

  _growTip(tip, newTips) {
    const P = this.params;
    const ch = this.channel;
    const cc = this.solver.channel;
    const rng = this.rng;
    const i = tip.node;
    const px = ch.x[i], py = ch.y[i], pz = ch.z[i];

    // --- step length: shorter in dense air near the ground -------------
    let ds = P.stepLength * stepLengthScale(pz) *
      (1 + P.stepJitter * (rng() * 2 - 1));
    ds = Math.max(STEPPED_LEADER.STEP_LENGTH_MIN,
      Math.min(STEPPED_LEADER.STEP_LENGTH_MAX, ds));

    const rAvoid = ds * P.selfAvoid;
    const rAvoid2 = rAvoid * rAvoid;

    // Length of the streamer zone ahead of the tip. A leader does not
    // respond to the field one step ahead - right at the tip that field is
    // megavolts per metre in every direction and would say "go" no matter
    // where you pointed. What decides whether a leader advances is the
    // *average* field across its corona zone, the region of streamers that
    // has to be sustained before the channel can thermalise into it. That
    // averaging length is what makes a threshold meaningful, and it is why
    // the effective propagation fields quoted for fractal lightning models
    // (~200 kV/m negative, ~125 kV/m positive) are hundreds of times below
    // the streamer-scale breakdown field.
    const probe = Math.max(60, Math.min(600,
      P.streamerZone * Math.sqrt(stepLengthScale(pz))));
    const rNear = Math.max(2.2 * probe, 8 * ds);

    // --- local view of the field ---------------------------------------
    const loc = cc.buildLocal(px, py, pz, rNear, this._loc);
    const amb = this.solver.ambient.eval(px, py, pz, this._amb);

    const Ec = propagationField(pz, tip.polarity, P.thresholdScale);
    // Bond field of the DBM: the potential drop between the channel and a
    // candidate point, over the step length. A negative leader grows where
    // the surrounding potential is *higher* than the channel's; a positive
    // leader where it is lower.
    const polSign = tip.polarity < 0 ? 1 : -1;
    const phiChannelTip = this.originPotential
      - tip.polarity * P.internalField * ch.dropLen[i];

    // --- orthonormal frame about the current direction of advance -------
    let wx = tip.dx, wy = tip.dy, wz = tip.dz;
    const wl = Math.hypot(wx, wy, wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
    let ux, uy, uz;
    if (Math.abs(wz) < 0.9) { ux = -wy; uy = wx; uz = 0; }
    else { ux = 0; uy = -wz; uz = wy; }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = wy * uz - wz * uy, vy = wz * ux - wx * uz, vz = wx * uy - wy * ux;
    const spin = rng() * Math.PI * 2;
    const cs = Math.cos(spin), sn = Math.sin(spin);

    // --- evaluate every candidate bond ----------------------------------
    const dirs = this.dirs, n = this.nDirs;
    const W = this._w, CD = this._cd, OK = this._ok;
    let wTotal = 0, wMax = 0, best = -1, bestE = 0;
    const near = loc.near;
    const nn = near.length;
    const eps2 = cc.soft2;
    const K = 8.9875517873681764e9;

    for (let k = 0; k < n; k++) {
      OK[k] = 0;
      W[k] = 0;
      const a = dirs[k * 3], b = dirs[k * 3 + 1], c = dirs[k * 3 + 2];
      const ra = a * cs - b * sn, rb = a * sn + b * cs;
      const dx = ux * ra + vx * rb + wx * c;
      const dy = uy * ra + vy * rb + wy * c;
      const dz = uz * ra + vz * rb + wz * c;
      const sx = px + dx * ds, sy = py + dy * ds, sz = pz + dz * ds;
      CD[k * 3] = dx; CD[k * 3 + 1] = dy; CD[k * 3 + 2] = dz;

      // The bond is judged at the far end of the streamer zone, but the
      // channel only advances by one step, so the two points differ.
      let L = probe;
      if (pz + dz * L <= P.groundZ && dz < 0) L = Math.max(ds, (pz - P.groundZ) / -dz);
      const cx = px + dx * L, cy = py + dy * L, cz = pz + dz * L;

      if (sz <= P.groundZ) {
        // The bond would punch through the surface: record the contact and
        // let the flash sequencer decide what it struck.
        if (this.groundContact < 0) this.groundContact = tip.node;
        tip.alive = false;
        ch.setFlag(i, NODE.GROUNDED);
        ch.clearFlag(i, NODE.TIP);
        return 0;
      }

      // Potential at the far end of the streamer zone: the cloud's
      // contribution to first order about the tip (it varies on kilometre
      // scales, so this is accurate to a fraction of a percent), plus the
      // channel's far-field expansion, plus every nearby channel charge
      // summed properly. The same loop measures how close the *step* would
      // come to existing channel, since space charge forbids two branches
      // occupying the same place.
      let phi = amb.phi - (amb.ex * dx + amb.ey * dy + amb.ez * dz) * L
        + loc.phi - (loc.ex * (cx - px) + loc.ey * (cy - py) + loc.ez * (cz - pz));
      let blocked = false;
      for (let j = 0; j < nn; j++) {
        const s = near[j];
        if (s !== i) {
          const ax = sx - cc.x[s], ay = sy - cc.y[s], az = sz - cc.z[s];
          if (ax * ax + ay * ay + az * az < rAvoid2) { blocked = true; break; }
        }
        const qx = cx - cc.x[s], qy = cy - cc.y[s], qz = cz - cc.z[s];
        phi += K * cc.q[s] / Math.sqrt(qx * qx + qy * qy + qz * qz + eps2);
      }
      if (blocked) continue;
      const img = loc.nearImg;
      for (let j = 0; j < img.length; j++) {
        const s = img[j];
        const qx = cx - cc.x[s], qy = cy - cc.y[s], qz = cz + cc.z[s];
        phi -= K * cc.q[s] / Math.sqrt(qx * qx + qy * qy + qz * qz + eps2);
      }

      const Eeff = polSign * (phi - phiChannelTip) / L;
      if (Eeff <= Ec) continue;
      const w = Math.pow(Eeff - Ec, P.eta);
      W[k] = w; OK[k] = 1;
      wTotal += w;
      if (w > wMax) { wMax = w; best = k; bestE = Eeff; }
    }

    if (best < 0) {
      // Nowhere the field can currently sustain a leader. The tip does not
      // die yet - it goes dormant and is retried every round. This matters:
      // the descending negative end of a negative CG flash normally cannot
      // move at all until the ascending positive end has burrowed far
      // enough into the negative charge region to drag the channel's
      // floating potential down. It waits, then goes. Only a tip that has
      // been stuck for a long time is written off, and most branches on a
      // real leader do end that way.
      tip.stall = (tip.stall || 0) + 1;
      if (tip.stall > P.maxStallRounds) {
        tip.alive = false;
        ch.clearFlag(i, NODE.TIP);
        ch.setFlag(i, NODE.DEAD);
        this.stats.deadTips++;
      }
      return 0;
    }
    tip.stall = 0;

    // --- DBM selection ---------------------------------------------------
    const chosen = rng.weightedIndex(W, wTotal);
    const useIdx = W[chosen] > 0 ? chosen : best;
    this.stats._sharpSum += Math.pow(W[useIdx] / wMax, 1 / Math.max(0.05, P.eta));
    this.stats.selectionSharpness = this.stats._sharpSum / (this.stats.steps + 1);
    this._extend(tip, useIdx, ds, amb.phi);
    this.stats.lastStepLength = ds;
    this.stats.lastTipField = bestE;
    this.stats.lastThreshold = Ec;

    // --- branching --------------------------------------------------------
    // A branch happens when a second bond is nearly as favourable as the
    // one taken and points somewhere genuinely different. Competition
    // between comparable bonds is exactly what DBM says branching is.
    if (this.tips.length + newTips.length < P.maxTips && P.branchiness > 0) {
      const bx = CD[useIdx * 3], by = CD[useIdx * 3 + 1], bz = CD[useIdx * 3 + 2];
      // A step forks in two at most, and only against its single strongest
      // competitor: the one bond that came closest to being taken while
      // pointing somewhere genuinely different. Considering every
      // runner-up instead would branch on essentially every step, because
      // a tip typically has a dozen admissible bonds.
      let rival = -1, rivalW = 0;
      for (let k = 0; k < n; k++) {
        if (!OK[k] || k === useIdx || W[k] <= rivalW) continue;
        const dot = CD[k * 3] * bx + CD[k * 3 + 1] * by + CD[k * 3 + 2] * bz;
        if (dot > P.branchMinAngleCos) continue;
        rival = k; rivalW = W[k];
      }
      if (rival >= 0) {
        // The DBM's own probability for that bond relative to the one
        // taken. Since the weights are (E - E_c)^eta, this carries eta's
        // effect on morphology directly: a rival with 80% of the winner's
        // field excess is 80% as likely to be taken at eta = 1 but only a
        // third as likely at eta = 5, which is what turns a bushy tree
        // into a single filament.
        const polarityFactor = tip.polarity < 0 ? 1.0 : 0.22;
        const p = P.branchiness * polarityFactor * (rivalW / wMax);
        if (rng() < p) {
          const nt = this._extend(tip, rival, ds, amb.phi, true);
          if (nt) { newTips.push(nt); this.stats.branches++; }
        }
      }
    }

    if (!this.lowTipReported && ch.z[tip.node] < P.attachAltitude && P.onLowTip) {
      this.lowTipReported = true;
      P.onLowTip(tip, ch.x[tip.node], ch.y[tip.node], ch.z[tip.node]);
    }
    return ds;
  }

  /**
   * Commit one bond: add the node, work out the charge the new length of
   * channel holds, and hand that charge to the field solver so the next
   * round already sees its own screening.
   */
  _extend(tip, k, ds, ambPhi, asBranch = false) {
    const P = this.params;
    const ch = this.channel;
    const cc = this.solver.channel;
    const CD = this._cd;
    const i = tip.node;
    const dx = CD[k * 3], dy = CD[k * 3 + 1], dz = CD[k * 3 + 2];
    const nx = ch.x[i] + dx * ds, ny = ch.y[i] + dy * ds, nz = ch.z[i] + dz * ds;

    // The channel is a conductor: its potential is the floating potential
    // less the resistive drop accumulated along the length of channel the
    // leader current has to flow through.
    const arc = ch.arcLen[i] + ds;
    const newLevel = Math.min(255, tip.level + (asBranch ? 1 : 0));
    const dropWeight = 1 + P.branchDrop * newLevel;
    const phiChannel = this.originPotential - tip.polarity * P.internalField *
      (ch.dropLen[i] + ds * dropWeight);

    // Everything except this segment already contributes some potential
    // here. The segment carries exactly the charge needed to make up the
    // difference - one Gauss-Seidel sweep of the equipotential condition.
    const phiAmb = this.solver.ambient.potential(nx, ny, nz);
    const phiOther = cc.potentialLocal(this._loc, nx, ny, nz);
    const coeff = segmentSelfCoefficient(ds, P.coreRadius);
    const q = segmentCharge(phiChannel, phiAmb + phiOther, ds, P.coreRadius, P.maxLineCharge);

    const node = ch.add(nx, ny, nz, i, {
      charge: q, dropWeight, owner: this.id,
      phiAmb, phiOther, selfCoeff: coeff,
      birth: this.simTime,
      level: newLevel,
      polarity: tip.polarity,
      flags: NODE.TIP,
      lum: 0.35,
      temp: 8000,     // a leader channel runs far cooler than a return stroke
    });
    cc.add(nx, ny, nz, q);
    this._accumNeutrality(node, tip.polarity, phiAmb, phiOther, coeff);
    this.stats.chargeDeposited += Math.abs(q);
    this.stats.steps++;
    if (nz < this.stats.minAltitude) this.stats.minAltitude = nz;

    if (asBranch) {
      // The parent keeps its own tip; the branch gets a fresh one.
      return {
        node, dx, dy, dz, polarity: tip.polarity, alive: true,
        level: tip.level + 1, arc, steps: 0,
      };
    }

    ch.clearFlag(i, NODE.TIP);
    tip.node = node;
    tip.arc = arc;
    tip.steps++;
    // Direction memory: successive steps are correlated, which is what
    // produces tortuosity on several scales instead of white-noise zigzag.
    const m = P.directionMemory;
    let ndx = dx + m * tip.dx, ndy = dy + m * tip.dy, ndz = dz + m * tip.dz;
    const l = Math.hypot(ndx, ndy, ndz) || 1;
    tip.dx = ndx / l; tip.dy = ndy / l; tip.dz = ndz / l;
    return null;
  }

  /** Kill every tip; used when attachment ends the leader phase. */
  freeze() {
    for (const t of this.tips) {
      if (t.alive) {
        t.alive = false;
        this.channel.clearFlag(t.node, NODE.TIP);
      }
    }
  }

  /** Descent speed actually achieved, for comparison with the 1-25e5 m/s
   *  range reported from streak photography. */
  measuredDescentSpeed(startZ) {
    if (this.simTime <= 0) return 0;
    const drop = startZ - this.stats.minAltitude;
    return drop / this.simTime;
  }
}

/**
 * Locate where a flash begins.
 *
 * Nature starts a flash wherever the ambient field first beats the local
 * inception threshold, which because the threshold falls with air density
 * is normally between two charge regions and well above the ground. The
 * search maximises E / E_init(z) rather than E alone, which is the
 * physically meaningful comparison.
 */
export function findInitiationPoint(ambient, opts = {}) {
  const {
    xMin = -6000, xMax = 6000, yMin = -6000, yMax = 6000,
    zMin = 1000, zMax = 12500,
    nx = 17, ny = 17, nz = 46,
    thresholdScale = 1.0,
    /** Supply a seeded rng to scatter initiation instead of taking the argmax. */
    rng = null,
  } = opts;

  const tmp = { phi: 0, ex: 0, ey: 0, ez: 0 };

  // Coarse sweep first, then refine.
  //
  // Evaluating the cloud's field is a few hundred Coulomb terms, and a
  // dense sweep of the whole search volume is millions of them — enough
  // to drop a frame every time a flash is created, which at high flash
  // rates is every few frames. The field is smooth on the scale of
  // hundreds of metres, so a coarse grid finds the right neighbourhood
  // and a small local grid sharpens it, for a tenth of the work.
  const scan = (x0, x1, y0, y1, z0, z1, cx, cy, cz, collect) => {
    let best = 0, bi = -1;
    for (let iz = 0; iz < cz; iz++) {
      const z = cz > 1 ? z0 + (z1 - z0) * (iz / (cz - 1)) : 0.5 * (z0 + z1);
      const Ec = FIELDS.E_INIT * relativeDensity(z) * thresholdScale;
      for (let iy = 0; iy < cy; iy++) {
        const y = cy > 1 ? y0 + (y1 - y0) * (iy / (cy - 1)) : 0.5 * (y0 + y1);
        for (let ix = 0; ix < cx; ix++) {
          const x = cx > 1 ? x0 + (x1 - x0) * (ix / (cx - 1)) : 0.5 * (x0 + x1);
          ambient.eval(x, y, z, tmp);
          const E = Math.hypot(tmp.ex, tmp.ey, tmp.ez);
          const ratio = E / Ec;
          if (ratio > best) { best = ratio; bi = collect ? collect.length : -1; }
          if (collect && ratio > 0.01) collect.push(x, y, z, E, ratio);
        }
      }
    }
    return { best, bi };
  };

  const cand = [];
  const cx = Math.max(5, Math.round(nx * 0.55));
  const cy = Math.max(5, Math.round(ny * 0.55));
  const cz = Math.max(8, Math.round(nz * 0.45));
  const { best: bestRatio } = scan(xMin, xMax, yMin, yMax, zMin, zMax, cx, cy, cz, cand);
  if (!cand.length) return { x: 0, y: 0, z: zMin, field: 0, ratio: 0, exceeded: false };

  // Where a flash starts is not the arithmetic maximum of the field.
  //
  // The ambient field is smooth over hundreds of metres, and what tips a
  // particular spot over is a local enhancement the model does not
  // resolve — a hydrometeor, a pocket of charge. Taking the strict argmax
  // makes every flash in a given storm begin at the same grid cell and
  // therefore follow much the same trunk, which is why a repeating storm
  // looks like it is playing a loop. Sampling among the places that are
  // nearly as favourable restores the scatter a real storm has, without
  // weakening the criterion: a cell at half the field excess is still
  // hundreds of times less likely to be chosen.
  let pick = 0;
  if (rng) {
    const floor = bestRatio * (opts.spread ?? 0.80);
    const w = [];
    let total = 0;
    for (let i = 0; i < cand.length; i += 5) {
      const r = cand[i + 4];
      const weight = r >= floor ? Math.pow(r / bestRatio, opts.sharpness ?? 12) : 0;
      w.push(weight);
      total += weight;
    }
    pick = rng.weightedIndex(w, total) * 5;
  } else {
    for (let i = 0; i < cand.length; i += 5) {
      if (cand[i + 4] >= bestRatio) { pick = i; break; }
    }
  }

  // Sharpen the chosen neighbourhood on a small local grid.
  const px = cand[pick], py = cand[pick + 1], pz = cand[pick + 2];
  const hx = (xMax - xMin) / Math.max(1, cx - 1);
  const hy = (yMax - yMin) / Math.max(1, cy - 1);
  const hz = (zMax - zMin) / Math.max(1, cz - 1);
  const fine = [];
  scan(px - hx, px + hx, py - hy, py + hy,
    Math.max(zMin, pz - hz), Math.min(zMax, pz + hz), 4, 4, 4, fine);
  let bx = px, by = py, bz = pz, bE = cand[pick + 3], bR = cand[pick + 4];
  for (let i = 0; i < fine.length; i += 5) {
    if (fine[i + 4] > bR) {
      bx = fine[i]; by = fine[i + 1]; bz = fine[i + 2];
      bE = fine[i + 3]; bR = fine[i + 4];
    }
  }

  return {
    x: bx, y: by, z: bz,
    field: bE, ratio: bR,
    bestRatio: Math.max(bestRatio, bR),
    exceeded: Math.max(bestRatio, bR) >= 1,
    candidates: cand.length / 5,
  };
}

