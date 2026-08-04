/**
 * flash.js — the whole event, start to finish.
 *
 * A flash is not a bolt; it is a sequence, and the parts happen on
 * timescales six orders of magnitude apart:
 *
 *   initiation      the ambient field first beats its local threshold
 *   stepped leader  ~20-50 ms, 2e5 m/s, branching downward
 *   attachment      the last ~100 m, decided by an upward connecting
 *                   leader that the descending one has provoked
 *   return stroke   ~100 us, 30 kA, a third of the speed of light
 *   pause           ~60 ms of darkness
 *   dart leader     ~1 ms, retracing the warm channel
 *   subsequent      12 kA, faster front, no branches
 *   ...repeat, 3-5 times on average, up to a dozen or more
 *   continuing      100-200 A for up to half a second, in a third of flashes
 *
 * This module drives that sequence on a single simulated clock so the
 * viewer can slow any part of it down and watch it in isolation, while
 * the relative timings stay exactly what nature uses.
 */

import { CLOUD, RETURN_STROKE, FLASH, STEPPED_LEADER, ATTACHMENT } from './constants.js';
import { FieldSolver } from './field.js';
import { Channel, NODE } from './channel.js';
import { LeaderGrower, findInitiationPoint } from './leader.js';
import { ReturnStroke, DartLeader, ContinuingCurrent } from './returnstroke.js';
import { ChannelThermal, strikingDistance, peakCurrentFromLeaderCharge } from './current.js';
import { makeRng } from './rng.js';
import { propagationField } from './atmosphere.js';

export const FlashType = {
  NEGATIVE_CG: 'negative-cg',
  POSITIVE_CG: 'positive-cg',
  INTRACLOUD: 'intracloud',
};

export const Phase = {
  IDLE: 'idle',
  INITIATION: 'initiation',
  LEADER: 'leader',
  ATTACHMENT: 'attachment',
  RETURN_STROKE: 'return-stroke',
  INTERSTROKE: 'interstroke',
  DART: 'dart-leader',
  CONTINUING: 'continuing-current',
  DONE: 'done',
};

/**
 * The charge structure that actually produces each kind of flash.
 *
 * Flash type is not a rendering choice — it is a consequence of where the
 * charge sits. An upright tripole makes negative CG and intracloud
 * flashes; a positive CG needs the sheared, anvil-displaced structure of a
 * mature or dissipating storm, because otherwise a descending positive
 * leader would have to cross the main negative charge to reach the ground.
 */
export function defaultRegionsFor(type) {
  if (type === FlashType.POSITIVE_CG) {
    return [
      { ...CLOUD.ANVIL.UPPER_POS }, { ...CLOUD.ANVIL.MAIN_NEG },
      { ...CLOUD.ANVIL.LOWER_POS },
    ];
  }
  return [{ ...CLOUD.UPPER_POS }, { ...CLOUD.MAIN_NEG }, { ...CLOUD.LOWER_POS }];
}

/** A grounded object a leader can attach to. */
export function makeTarget(x, y, height, radius, name) {
  return {
    x, y, height, radius, name,
    // Field enhancement at the tip of a slender grounded object. For a
    // hemisphere on a plane the factor is 3; for a rod of height h and
    // radius r it rises towards h/r. A 100 m mast is a far better target
    // than a 100 m hill for exactly this reason.
    enhancement: Math.min(60, 1 + 2 * Math.max(1, height) / Math.max(0.5, radius)),
    ucl: null,
  };
}

export class Flash {
  constructor(opts = {}) {
    this.opts = opts;
    this.seed = opts.seed ?? (Date.now() & 0x7fffffff);
    this.rng = makeRng(this.seed);
    this.type = opts.type || FlashType.NEGATIVE_CG;

    this.regions = opts.regions || defaultRegionsFor(this.type);

    /**
     * Nudge the whole charge structure a little, per flash.
     *
     * A thunderstorm is not a fixed object firing repeatedly from one
     * point: the cell moves, updrafts come and go, and successive flashes
     * come from different parts of it kilometres apart. Without this the
     * charge geometry is identical every time and every flash retraces
     * much the same trunk, which reads as a loop rather than a storm.
     */
    const jitter = opts.stormJitter || 0;
    if (jitter > 0) {
      const a = this.rng() * Math.PI * 2;
      const r = jitter * Math.sqrt(this.rng());
      this.drift = { x: Math.cos(a) * r, y: Math.sin(a) * r };
      this.regions = this.regions.map(rg => ({
        ...rg,
        x: (rg.x || 0) + this.drift.x,
        y: (rg.y || 0) + this.drift.y,
      }));
    } else {
      this.drift = { x: 0, y: 0 };
    }
    if (opts.stormIntensity && opts.stormIntensity !== 1) {
      this.regions = this.regions.map(r => ({ ...r, charge: r.charge * opts.stormIntensity }));
    }

    this.solver = new FieldSolver(this.regions);
    this.channel = new Channel();
    this.thermal = new ChannelThermal();
    this.targets = opts.targets || [];

    this.time = 0;             // simulated seconds since initiation
    this.phase = Phase.IDLE;
    this.phaseTime = 0;
    this.strokes = [];         // completed stroke records
    this.strokeIndex = 0;
    this.events = [];          // human-readable log for the HUD
    this.groundNode = -1;
    this.attachPoint = null;
    this.uclGrowers = [];
    this.rs = null;
    this.dart = null;
    this.cc = null;
    this.nextStrokeAt = 0;
    this.maxRoundsPerUpdate = opts.maxRoundsPerUpdate || 24;

    this._begin();
  }

  log(msg, extra) {
    this.events.push({ t: this.time, msg, ...extra });
    if (this.events.length > 200) this.events.shift();
  }

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  _begin() {
    const negZ = this.regions.find(r => r.charge < 0)?.z ?? CLOUD.MAIN_NEG.z;
    const topZ = this.regions.reduce((m, r) => Math.max(m, r.z), 0);

    // Where a flash of this kind starts. Negative CG flashes begin below
    // the main negative charge, in the gap it forms with the lower
    // positive region; intracloud flashes begin above it; a positive CG
    // begins out under the displaced anvil, downshear of the storm core.
    const scale = this.opts.thresholdScale || 1;

    // Centre the search on the storm, not on the origin. The storm can be
    // put anywhere — dropped onto a spot in a photograph, for instance —
    // and a search box nailed to (0, 0) would then be looking at empty air
    // several kilometres from any charge.
    const neg = this.regions.find(r => r.charge < 0) || this.regions[0] || {};
    const cx = neg.x || 0;
    const cy = neg.y || 0;

    let band;
    if (this.type === FlashType.NEGATIVE_CG) {
      band = {
        zMin: 1200, zMax: negZ,
        xMin: cx - 5000, xMax: cx + 5000, yMin: cy - 5000, yMax: cy + 5000,
      };
    } else if (this.type === FlashType.POSITIVE_CG) {
      // The gap between the displaced anvil charge and the storm core.
      const anvil = this.regions.reduce(
        (m, r) => ((r.charge > 0 && r.z > negZ) ? r : m), null);
      const ax = anvil ? (anvil.x || 0) : cx;
      const anvilZ = anvil ? anvil.z : topZ;
      const lo = Math.min(cx, ax), hi = Math.max(cx, ax);
      band = {
        zMin: negZ - 1000, zMax: anvilZ,
        xMin: lo + (hi - lo) * 0.2, xMax: hi + (hi - lo) * 0.15,
        yMin: cy - 3000, yMax: cy + 3000, nx: 21,
      };
    } else {
      band = {
        zMin: negZ, zMax: topZ + 1200,
        xMin: cx - 5000, xMax: cx + 5000, yMin: cy - 5000, yMax: cy + 5000,
      };
    }

    this.initiation = findInitiationPoint(this.solver.ambient,
      { ...band, thresholdScale: scale, rng: this.rng });

    if (!this.initiation.exceeded) {
      // The requested kind of flash cannot start in this storm. Rather
      // than pretend, look everywhere: if the storm can discharge at all,
      // it will do so wherever it is actually able to.
      const anywhere = findInitiationPoint(this.solver.ambient, {
        xMin: cx - 12000, xMax: cx + 12000, yMin: cy - 8000, yMax: cy + 8000,
        zMin: 1000, zMax: topZ + 2000, nx: 25, ny: 17, nz: 50,
        thresholdScale: scale, rng: this.rng,
      });
      if (anywhere.exceeded) {
        this.log(`no ${this.type} possible here — the strongest field is at ` +
          `${(anywhere.z / 1000).toFixed(1)} km, so the storm goes intracloud instead`);
        this.type = FlashType.INTRACLOUD;
        this.initiation = anywhere;
      }
    }

    // For an intracloud or positive flash the *negative* end is the one
    // that climbs, because it is heading for the upper positive charge.
    const upwardIsNegative = this.type !== FlashType.NEGATIVE_CG;

    const params = Object.assign({
      eta: this.opts.eta,
      branchiness: this.opts.branchiness,
      stepLength: this.opts.stepLength,
      speed: this.opts.leaderSpeed,
      thresholdScale: this.opts.thresholdScale,
      maxNodes: this.opts.maxNodes,
      maxTips: this.opts.maxTips,
      attachAltitude: 900,
      onLowTip: () => { },
    }, this.opts.leaderParams || {});
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];

    this.leader = new LeaderGrower({
      solver: this.solver, channel: this.channel, rng: this.rng, params,
    });
    this.leaderEnds = this.leader.seed(
      this.initiation.x, this.initiation.y, this.initiation.z, upwardIsNegative);

    this.phase = this.initiation.exceeded ? Phase.LEADER : Phase.INITIATION;
    this.log(this.initiation.exceeded
      ? `initiation at ${(this.initiation.z / 1000).toFixed(2)} km, ` +
        `E = ${(this.initiation.field / 1e3).toFixed(0)} kV/m`
      : `field too weak to initiate: E/Ec = ${this.initiation.ratio.toFixed(2)}`);
    if (!this.initiation.exceeded) this.phase = Phase.DONE;

    // Multiplicity, drawn once, from the observed distribution. The scale
    // lets a caller push the storm up or down the distribution without
    // changing its shape.
    const mScale = this.opts.multiplicityScale ?? 1;
    this.plannedStrokes = this.type === FlashType.POSITIVE_CG
      ? 1
      : Math.max(1, Math.min(FLASH.MULTIPLICITY_MAX,
        Math.round(this.rng.logNormal(FLASH.MULTIPLICITY_MEAN * mScale, 0.55))));
    this.hasContinuing = this.type !== FlashType.INTRACLOUD &&
      this.rng.chance(this.type === FlashType.POSITIVE_CG
        ? 0.8 : FLASH.CONTINUING_PROBABILITY);
  }

  /* ---------------------------------------------------------------- *
   * Main clock
   * ---------------------------------------------------------------- */

  /**
   * Advance the simulation by `dt` seconds of simulated time.
   *
   * `deadline` is a performance.now() timestamp past which the call gives
   * up and returns, leaving the rest of `dt` unspent. A single leader
   * round is milliseconds of work and a request for real-time playback is
   * tens of rounds, so without somewhere to stop this function is quite
   * capable of eating a whole frame on its own — and it does not help for
   * the caller to check the clock only between calls.
   */
  update(dt, deadline = Infinity) {
    this._deadline = deadline;
    let budget = dt;
    let guard = 0;
    while (budget > 1e-12 && guard++ < 400 && this.phase !== Phase.DONE) {
      const used = this._step(budget);
      if (used <= 0) break;
      budget -= used;
      this.time += used;
      this.phaseTime += used;
      if (deadline !== Infinity && performance.now() > deadline) break;
    }
    this._deadline = Infinity;
    this._decayLeaderGlow(dt);
    return dt - budget;
  }

  /** Has this call run out of its wall-clock allowance? */
  _outOfTime() {
    return this._deadline !== undefined && this._deadline !== Infinity &&
      performance.now() > this._deadline;
  }

  _setPhase(p) {
    this.phase = p;
    this.phaseTime = 0;
  }

  _step(budget) {
    switch (this.phase) {
      case Phase.LEADER: return this._stepLeader(budget);
      case Phase.ATTACHMENT: return this._stepAttachment(budget);
      case Phase.RETURN_STROKE: return this._stepReturnStroke(budget);
      case Phase.INTERSTROKE: return this._stepInterstroke(budget);
      case Phase.DART: return this._stepDart(budget);
      case Phase.CONTINUING: return this._stepContinuing(budget);
      default: return 0;
    }
  }

  /* ---------------------------------------------------------------- *
   * Stepped leader
   * ---------------------------------------------------------------- */

  _stepLeader(budget) {
    const g = this.leader;
    let used = 0;
    let rounds = 0;
    while (used < budget && rounds < this.maxRoundsPerUpdate && !g.finished) {
      used += g.round();
      rounds++;
      if (g.groundContact >= 0) break;
      if (this._checkAttachment()) break;
      // A growth round on a big, heavily branched leader is milliseconds
      // of Coulomb sums; twenty of them is a dropped frame.
      if (this._outOfTime()) break;
    }

    if (g.groundContact >= 0) {
      this._attachAt(g.groundContact, null);
      return Math.max(used, 1e-9);
    }
    if (this.uclGrowers.length) {
      this._setPhase(Phase.ATTACHMENT);
      return Math.max(used, 1e-9);
    }
    if (g.finished) {
      // No ground contact. That is not a failure — three quarters of all
      // flashes never leave the cloud.
      if (this.type === FlashType.INTRACLOUD) {
        this.log('intracloud discharge complete');
      } else {
        this.log(`leader stalled at ${g.stats.minAltitude.toFixed(0)} m — ` +
          `the flash stayed in the cloud`);
      }
      this._finishAsCloudFlash();
      return Math.max(used, 1e-9);
    }
    return Math.max(used, 1e-9);
  }

  /**
   * Does anything on the ground want to answer?
   *
   * This is the electrogeometric model, the criterion power engineers have
   * used since the 1970s and the one IEC 62305 turns into the rolling
   * sphere. The descending leader "chooses" nothing until it is within a
   * striking distance
   *
   *     r_s = 10 I^0.65   metres, I in kA          (Love)
   *
   * of something grounded; at that point the field at the object is high
   * enough to launch an upward connecting leader, and whichever object
   * gets one away first collects the stroke. Flat ground is worth about
   * 0.9 r_s, a slender mast rather more, which is precisely why a 100 m
   * tower protects the field around it and a 100 m hill does not.
   *
   * The prospective current is not assumed: it comes from the leader this
   * simulation actually grew, through I = lambda v.
   */
  _checkAttachment() {
    if (this.type === FlashType.INTRACLOUD) return false;
    if (this.uclGrowers.length) return true;

    const ch = this.channel;
    let low = -1, lowZ = Infinity;
    for (const t of this.leader.tips) {
      if (!t.alive) continue;
      if (ch.z[t.node] < lowZ) { lowZ = ch.z[t.node]; low = t.node; }
    }
    if (low < 0 || lowZ > 1500) return false;

    const tipX = ch.x[low], tipY = ch.y[low];
    const polarity = ch.polarity[low];
    // Line charge density over the lowest part of the channel gives the
    // prospective peak current, and that sets the striking distance.
    this.prospectiveCurrent = Math.max(3e3, Math.min(200e3,
      peakCurrentFromLeaderCharge(this._baseLineCharge(lowZ),
        RETURN_STROKE.SPEED_BASE)));
    const rs = this.strikingDistance = strikingDistance(this.prospectiveCurrent);

    // Candidate attachment points: every declared object, plus the patch of
    // bare ground directly beneath the tip.
    const candidates = this.targets.map(t => ({
      target: t, x: t.x, y: t.y, z: t.height, k: t.enhancement, reach: rs,
    }));
    candidates.push({
      target: null, x: tipX, y: tipY, z: 0.5, k: 1, reach: 0.9 * rs,
    });

    let best = null, bestScore = 0;
    for (const c of candidates) {
      const d = Math.hypot(c.x - tipX, c.y - tipY, c.z - lowZ);
      // A tall slender object reaches a little further than its height
      // alone would suggest, because its own field enhancement gets an
      // upward leader away sooner.
      const reach = c.reach * (1 + 0.25 * Math.log10(Math.max(1, c.k)));
      const score = reach / d;
      if (score > bestScore) { bestScore = score; best = c; best.dist = d; best.reach = reach; }
    }
    if (!best || bestScore < 1) return false;

    const out = { phi: 0, ex: 0, ey: 0, ez: 0 };
    this.solver.eval(best.x, best.y, best.z + 1, out);
    best.E = Math.hypot(out.ex, out.ey, out.ez) * Math.min(12, best.k);
    this.groundFieldNow = best.E;

    // Launch it. An upward connecting leader is grounded, so unlike the
    // in-cloud leader its potential is pinned at zero rather than floating.
    const up = new LeaderGrower({
      solver: this.solver, channel: this.channel, rng: this.rng,
      params: {
        stepLength: 12, streamerZone: 60, maxTips: 3, branchiness: 0.06,
        speed: ATTACHMENT.UCL_SPEED, internalField: 8000, branchDrop: 2,
        maxNodes: this.channel.count + 400, directionMemory: 1.2,
        maxStallRounds: 25,
      },
    });
    const dx = tipX - best.x, dy = tipY - best.y, dz = lowZ - best.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    up.seedSingle(best.x, best.y, best.z + 1, dx / L, dy / L, dz / L, -polarity, 0);
    for (let i = 0; i < this.channel.count; i++) {
      if (this.channel.polarity[i] === -polarity && this.channel.hasFlag(i, NODE.TIP)) {
        this.channel.setFlag(i, NODE.UPWARD);
      }
    }
    up.targetNode = low;
    this.uclGrowers.push(up);
    this.attachTargetName = best.target ? best.target.name : 'open ground';
    this.log(`upward connecting leader from ${this.attachTargetName}: ` +
      `leader tip ${best.dist.toFixed(0)} m away, striking distance ` +
      `${best.reach.toFixed(0)} m for a prospective ` +
      `${(this.prospectiveCurrent / 1e3).toFixed(0)} kA stroke ` +
      `(E = ${(best.E / 1e3).toFixed(0)} kV/m at the tip)`);
    return true;
  }

  _stepAttachment(budget) {
    const ch = this.channel;
    let used = 0, rounds = 0;
    while (used < budget && rounds < this.maxRoundsPerUpdate) {
      const dtL = this.leader.finished ? 0 : this.leader.round();
      let dtU = 0;
      for (const u of this.uclGrowers) if (!u.finished) dtU = Math.max(dtU, u.round());
      const dt = Math.max(dtL, dtU, 1e-7);
      used += dt;
      rounds++;

      // Have the two ends found each other? The final jump closes when the
      // gap can no longer hold off the potential difference across it.
      const jump = Math.max(25, 0.45 * (this.strikingDistance || 80));
      let bestGap = Infinity, bestPair = null;
      for (const u of this.uclGrowers) {
        for (const ut of u.tips) {
          if (!ut.alive) continue;
          for (const dt2 of this.leader.tips) {
            if (!dt2.alive) continue;
            const gap = ch.gap(ut.node, dt2.node);
            if (gap < bestGap) { bestGap = gap; bestPair = [dt2.node, ut.node]; }
          }
        }
      }
      if (bestPair && bestGap < jump) {
        this._attachAt(bestPair[0], bestPair[1], bestGap);
        return used;
      }
      if (this.leader.groundContact >= 0) {
        this._attachAt(this.leader.groundContact, null);
        return used;
      }
      if (this._outOfTime()) return used;
      const allDone = this.leader.finished &&
        this.uclGrowers.every(u => u.finished);
      if (allDone) {
        if (bestPair && bestGap < 4 * jump) {
          // Both ends ran out of steam within a final-jump distance of one
          // another. That gap breaks down: the flash connects.
          this._attachAt(bestPair[0], bestPair[1], bestGap);
        } else {
          this.log('attachment failed - the leaders never met');
          this._finishAsCloudFlash();
        }
        return used;
      }
    }
    return used;
  }

  /**
   * Splice the two channels and fire the return stroke.
   *
   * The peak current is not chosen. It follows from the leader that was
   * actually grown: the transmission-line relation I = lambda v, where
   * lambda is the line charge density the corona sheath ended up holding
   * near the bottom of the channel and v is the return-stroke speed.
   */
  _attachAt(downNode, upNode, gap = 0) {
    const ch = this.channel;
    this.leader.freeze();
    for (const u of this.uclGrowers) u.freeze();

    let start = downNode;
    if (upNode !== null && upNode !== undefined) {
      ch.link(downNode, upNode);
      // The stroke starts from the grounded end of the upward leader.
      let r = upNode;
      while (ch.parent[r] >= 0) r = ch.parent[r];
      start = r;
      this.junction = { down: downNode, up: upNode, gap };
      this.log(`attachment: junction ${gap.toFixed(0)} m above ` +
        `${this.attachTargetName || 'the ground'}, ` +
        `${ch.z[downNode].toFixed(0)} m altitude`);
    } else {
      this.log(`direct strike to ground at ` +
        `(${ch.x[downNode].toFixed(0)}, ${ch.y[downNode].toFixed(0)}) m`);
    }
    this.groundNode = start;
    this.attachPoint = { x: ch.x[start], y: ch.y[start], z: ch.z[start] };
    this.mainChannelLength = ch.markMainPath(downNode);

    this.lambdaBase = this._baseLineCharge(ch.z[start]);
    this._fireReturnStroke(true);
  }

  /**
   * Mean line charge density over the lowest kilometre of channel — the
   * stretch the return-stroke front sweeps first, and therefore the one
   * that sets the peak current through I = lambda v.
   */
  _baseLineCharge(fromZ) {
    const ch = this.channel;
    let q = 0, len = 0;
    for (let i = 0; i < ch.count; i++) {
      if (ch.z[i] < fromZ + 1000 && ch.segLen[i] > 0) {
        q += Math.abs(ch.charge[i]); len += ch.segLen[i];
      }
    }
    return len > 0 ? q / len : STEPPED_LEADER.LINE_CHARGE_TYPICAL;
  }

  _fireReturnStroke(first) {
    const positive = this.type === FlashType.POSITIVE_CG;
    let peak;
    if (first) {
      peak = peakCurrentFromLeaderCharge(this.lambdaBase, RETURN_STROKE.SPEED_BASE);
      // Keep it inside the observed distribution; the model's lambda can
      // wander, the physics of a 400 kA first stroke cannot.
      peak = Math.max(4e3, Math.min(250e3, peak));
    } else {
      peak = this.rng.logNormal(RETURN_STROKE.PEAK_SUBSEQ_MEDIAN,
        RETURN_STROKE.PEAK_LOGN_SIGMA);
    }
    const shape = positive ? RETURN_STROKE.WAVESHAPE_POSITIVE
      : (first ? RETURN_STROKE.WAVESHAPE_FIRST : RETURN_STROKE.WAVESHAPE_SUBSEQ);

    this.rs = new ReturnStroke({
      channel: this.channel,
      startNode: this.groundNode,
      peakCurrent: peak,
      waveshape: shape,
      speedBase: RETURN_STROKE.SPEED_BASE * (first ? 1 : 1.25),
      thermal: this.thermal,
      branchFactor: first ? 0.55 : 0.2,
    });
    this.strokeIndex++;
    this._setPhase(Phase.RETURN_STROKE);
    this.log(`return stroke ${this.strokeIndex}: ${(peak / 1e3).toFixed(1)} kA peak, ` +
      `front reaches the cloud in ${(this.rs.maxArrival * 1e6).toFixed(0)} us`);
  }

  _stepReturnStroke(budget) {
    const step = Math.min(budget, 4e-6);
    this.rs.advance(step);
    if (this.rs.peakTemperature > (this.peakTemp || 0)) {
      this.peakTemp = this.rs.peakTemperature;
    }
    if (this.rs.finished) {
      const q = this.rs.chargeTransferred;
      this.strokes.push({
        index: this.strokeIndex,
        peak: this.rs.peakSoFar,
        charge: q,
        energy: this.rs.energy,
        time: this.time,
      });
      this.log(`stroke ${this.strokeIndex} done: ${q.toFixed(2)} C transferred, ` +
        `${(this.rs.energy / 1e6).toFixed(1)} MJ into the channel`);
      // The stroke drained the leader charge; the field must know.
      this._neutraliseChannel();
      this._afterStroke();
    }
    return step;
  }

  _neutraliseChannel() {
    const ch = this.channel;
    const cc = this.solver.channel;
    for (let i = 0; i < ch.count; i++) {
      if (this.rs.arrival[i] < 1e8) { ch.charge[i] *= 0.06; cc.setCharge(i, ch.charge[i]); }
    }
    cc.refreshCells();
  }

  _afterStroke() {
    if (this.hasContinuing && this.strokeIndex >= this.plannedStrokes) {
      this._startContinuing();
      return;
    }
    if (this.strokeIndex >= this.plannedStrokes) {
      this._setPhase(Phase.DONE);
      this.log(`flash complete: ${this.strokeIndex} stroke` +
        `${this.strokeIndex > 1 ? 's' : ''}, ` +
        `${this.totalCharge.toFixed(1)} C to ground over ` +
        `${(this.time * 1e3).toFixed(0)} ms`);
      return;
    }
    this.interstroke = Math.max(FLASH.INTERSTROKE_MIN,
      this.rng.logNormal(FLASH.INTERSTROKE_MEDIAN, FLASH.INTERSTROKE_SIGMA));
    this._setPhase(Phase.INTERSTROKE);
  }

  _stepInterstroke(budget) {
    const step = Math.min(budget, this.interstroke - this.phaseTime);
    if (step <= 1e-9) {
      // Set up the dart leader down the surviving main channel.
      const cloudEnd = this._cloudEndOfMainChannel();
      this.dart = new DartLeader(this.channel, cloudEnd, this.groundNode,
        this.rng.logNormal(FLASH.DART_SPEED, 0.4));
      this._setPhase(Phase.DART);
      this.log(`dart leader ${this.strokeIndex + 1}: ` +
        `${(this.dart.speed / 1e6).toFixed(1)}e6 m/s down ` +
        `${(this.dart.length / 1000).toFixed(1)} km of warm channel`);
      return 1e-9;
    }
    return step;
  }

  _cloudEndOfMainChannel() {
    const ch = this.channel;
    let best = this.groundNode, bz = -Infinity;
    for (let i = 0; i < ch.count; i++) {
      if (ch.hasFlag(i, NODE.MAIN) && ch.z[i] > bz) { bz = ch.z[i]; best = i; }
    }
    return best;
  }

  _stepDart(budget) {
    const step = Math.min(budget, 20e-6);
    this.dart.advance(step);
    if (this.dart.finished) {
      // Recharge the retraced channel: the dart deposits charge again,
      // less than the stepped leader did, which is why subsequent strokes
      // carry less current.
      const ch = this.channel, cc = this.solver.channel;
      for (const i of this.dart.path) {
        ch.charge[i] = ch.charge[i] * 0.5 +
          Math.sign(ch.polarity[i] || -1) * 1.2e-4 * ch.segLen[i];
        cc.setCharge(i, ch.charge[i]);
      }
      cc.refreshCells();
      this._fireReturnStroke(false);
    }
    return step;
  }

  _startContinuing() {
    const ch = this.channel;
    const path = [];
    for (let i = 0; i < ch.count; i++) if (ch.hasFlag(i, NODE.MAIN)) path.push(i);
    this.cc = new ContinuingCurrent({
      channel: ch, path, rng: this.rng, thermal: this.thermal,
      current: this.rng.logNormal(FLASH.CONTINUING_CURRENT, 0.4),
      duration: this.rng.logNormal(FLASH.CONTINUING_DURATION, 0.7),
    });
    this._setPhase(Phase.CONTINUING);
    this.log(`continuing current: ${this.cc.current.toFixed(0)} A for ` +
      `${(this.cc.duration * 1e3).toFixed(0)} ms, ` +
      `${this.cc.mComponents.length} M-components`);
  }

  _stepContinuing(budget) {
    const step = Math.min(budget, 200e-6);
    this.cc.advance(step);
    if (this.cc.finished) {
      this.log(`continuing current delivered ${this.cc.charge.toFixed(1)} C`);
      this._setPhase(Phase.DONE);
    }
    return step;
  }

  _finishAsCloudFlash() {
    // An in-cloud discharge still neutralises charge and still lights the
    // cloud from inside; it just never touches anything.
    this.leader.freeze();
    const ch = this.channel;
    const cloudEnd = ch.lowestNode();
    this.rs = new ReturnStroke({
      channel: ch,
      startNode: cloudEnd,
      peakCurrent: this.rng.logNormal(9e3, 0.6),
      waveshape: { front: 6e-6, half: 60e-6 },
      speedBase: 5e7,
      thermal: this.thermal,
      branchFactor: 0.7,
    });
    this.plannedStrokes = 1;
    this.hasContinuing = false;
    this.strokeIndex++;
    this._setPhase(Phase.RETURN_STROKE);
  }

  /**
   * The leader channel glows faintly on its own, and each step flashes as
   * it forms. Both fade in a few hundred microseconds, which is why a
   * stepped leader is barely visible to the eye but obvious on a
   * high-speed camera.
   */
  _decayLeaderGlow(dt) {
    if (this.phase === Phase.RETURN_STROKE || this.phase === Phase.CONTINUING) return;
    const ch = this.channel;
    const tau = this.phase === Phase.DART ? 3e-4 : 1.2e-3;
    const f = Math.exp(-dt / tau);
    const floor = this.phase === Phase.LEADER || this.phase === Phase.ATTACHMENT
      ? 0.045 : 0.0;
    for (let i = 0; i < ch.count; i++) {
      const v = ch.lum[i] * f;
      ch.lum[i] = v > floor ? v : floor;
    }
  }

  /* ---------------------------------------------------------------- *
   * Reporting
   * ---------------------------------------------------------------- */

  get totalCharge() {
    let q = this.strokes.reduce((s, k) => s + k.charge, 0);
    // Include the stroke currently in progress, so the readout climbs
    // while the charge is actually being delivered rather than jumping
    // once it is over.
    if (this.rs && this.phase === Phase.RETURN_STROKE) q += this.rs.chargeTransferred;
    if (this.cc) q += this.cc.charge;
    return q;
  }

  get peakCurrent() {
    return this.strokes.reduce((m, k) => Math.max(m, k.peak), this.rs?.peakSoFar || 0);
  }

  get totalEnergy() {
    return this.strokes.reduce((s, k) => s + k.energy, 0);
  }

  get done() { return this.phase === Phase.DONE; }

  /** Everything the HUD wants, gathered once per frame. */
  telemetry() {
    const ch = this.channel;
    const g = this.leader;
    let lowest = Infinity, tips = 0;
    for (const t of g.tips) {
      if (!t.alive) continue;
      tips++;
      if (ch.z[t.node] < lowest) lowest = ch.z[t.node];
    }
    const tipPotential = this.groundNode >= 0
      ? null
      : g.originPotential + g.params.internalField *
        ch.dropLen[g.tips.find(t => t.alive)?.node ?? 0];

    return {
      time: this.time,
      phase: this.phase,
      seed: this.seed,
      type: this.type,
      nodes: ch.count,
      channelLength: ch.totalLength,
      branches: g.stats.branches,
      activeTips: tips,
      leaderAltitude: Number.isFinite(lowest) ? lowest : null,
      leaderSpeed: g.simTime > 0
        ? (this.initiation.z - g.stats.minAltitude) / g.simTime : 0,
      floatingPotential: g.originPotential,
      tipPotential,
      channelCharge: ch.chargeMagnitude(),
      netCharge: this.solver.channel.totalCharge,
      stepLength: g.stats.lastStepLength,
      bondField: g.stats.lastTipField,
      threshold: g.stats.lastThreshold,
      groundField: this.solver.groundField(
        this.attachPoint?.x ?? this.initiation.x,
        this.attachPoint?.y ?? this.initiation.y),
      strokeIndex: this.strokeIndex,
      plannedStrokes: this.plannedStrokes,
      current: this.rs && this.phase === Phase.RETURN_STROKE ? this.rs.baseCurrent
        : (this.cc && this.phase === Phase.CONTINUING ? this.cc.instant : 0),
      peakCurrent: this.peakCurrent,
      chargeTransferred: this.totalCharge,
      energy: this.totalEnergy,
      strikingDistance: this.strikingDistance,
      attachPoint: this.attachPoint,
      initiation: this.initiation,
      maxTemp: this._maxTemp(),
      peakTemp: this.peakTemp || 0,
      events: this.events,
    };
  }

  _maxTemp() {
    const ch = this.channel;
    let m = 0;
    for (let i = 0; i < ch.count; i++) if (ch.temp[i] > m) m = ch.temp[i];
    return m;
  }
}

/** Convenience: the propagation threshold at an altitude, for the HUD. */
export { propagationField };
