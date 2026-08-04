/**
 * returnstroke.js — the bright part.
 *
 * The moment the descending leader touches something grounded, the whole
 * channel is shorted to earth. A neutralisation wave runs back up it at
 * roughly a third of the speed of light, and the several coulombs the
 * leader spent thirty milliseconds carefully distributing along fifteen
 * kilometres of air are drained in under a hundred microseconds. That
 * ratio — tens of milliseconds to charge, tens of microseconds to
 * discharge — is the whole reason lightning is violent.
 *
 * The model here is the MTLE (modified transmission line, exponential),
 * the engineering standard: the base current waveform, delayed by the
 * front's travel time to each point and attenuated as exp(-z/lambda) with
 * lambda ~ 2 km. It is the model that reproduces measured remote electric
 * and magnetic fields, so it also gets the *distribution* of light along
 * the channel right, which is what a viewer actually sees.
 */

import { RETURN_STROKE } from './constants.js';
import {
  HeidlerWaveform, returnStrokeSpeed, mtleAttenuation, ChannelThermal,
} from './current.js';
import { NODE } from './channel.js';

export class ReturnStroke {
  /**
   * @param {object} o
   *   channel        Channel
   *   startNode      node where the channel meets ground
   *   peakCurrent    A
   *   waveshape      {front, half} in seconds
   *   speedBase      m/s at the channel base
   *   branchFactor   how much of the current a branch takes at a junction
   */
  constructor(o) {
    this.channel = o.channel;
    this.start = o.startNode;
    this.peak = o.peakCurrent;
    this.wave = new HeidlerWaveform(o.waveshape || RETURN_STROKE.WAVESHAPE_FIRST,
      o.peakCurrent);
    this.speedBase = o.speedBase || RETURN_STROKE.SPEED_BASE;
    this.branchFactor = o.branchFactor ?? 0.55;
    this.thermal = o.thermal || new ChannelThermal();
    this.mtleLambda = o.mtleLambda || RETURN_STROKE.MTLE_LAMBDA;

    this.t = 0;
    this.chargeTransferred = 0;
    this.energy = 0;
    this.peakSoFar = 0;
    this.peakEnergy = 0;
    this.peakTemperature = 0;
    this.finished = false;

    const n = this.channel.count;
    this.arrival = new Float32Array(n);
    this.pathDist = new Float32Array(n);  // m along the channel from the base
    this.W = new Float32Array(n);         // J/m of stored channel energy
    this.branchAtten = new Float32Array(n);
    this._computeArrivals();

    /** Duration to simulate: long enough for the tail to die away. */
    this.duration = Math.max(this.wave.tau2 * 8, 400e-6) + this.maxArrival;
  }

  /**
   * Travel time of the front to every node, integrating the height
   * dependent speed segment by segment. Branches light up only after the
   * front has swept past the junction that feeds them, which is why the
   * bottom of a flash brightens a hair before its branches do — visible
   * on any high-speed recording.
   */
  _computeArrivals() {
    const ch = this.channel;
    const kids = ch.buildTopology();
    const n = ch.count;
    this.arrival.fill(Infinity);
    this.branchAtten.fill(1);
    this.pathDist.fill(0);
    const order = new Int32Array(n);
    let head = 0, tail = 0;
    this.arrival[this.start] = 0;
    this.branchAtten[this.start] = 1;
    order[tail++] = this.start;
    let maxT = 0;

    const visit = (from, to, len) => {
      if (this.arrival[to] !== Infinity) return;
      const zMid = 0.5 * (ch.z[from] + ch.z[to]);
      const v = returnStrokeSpeed(zMid, this.speedBase);
      const t = this.arrival[from] + len / v;
      this.arrival[to] = t;
      // MTLE attenuates with distance from wherever the current was
      // injected. The standard form uses height above ground, which is
      // right for a ground stroke and meaningless for an in-cloud one;
      // straight-line distance from the injection point reduces to height
      // in the first case and stays sensible in the second.
      //
      // It matters that this is the straight-line distance and not the
      // length of channel travelled: a tortuous channel covers half again
      // as much path as height, and charging MTLE for that wander would
      // extinguish the top of the flash long before it should go dark.
      this.pathDist[to] = Math.hypot(
        ch.x[to] - ch.x[this.start],
        ch.y[to] - ch.y[this.start],
        ch.z[to] - ch.z[this.start]);
      if (t > maxT) maxT = t;
      // Current divides where the channel does.
      const levelJump = Math.max(0, ch.level[to] - ch.level[from]);
      this.branchAtten[to] = this.branchAtten[from] *
        Math.pow(this.branchFactor, levelJump);
      order[tail++] = to;
    };

    while (head < tail) {
      const i = order[head++];
      const p = ch.parent[i];
      if (p >= 0) visit(i, p, ch.segLen[i]);
      const kl = kids[i];
      if (kl) {
        for (let k = 0; k < kl.length; k++) {
          const j = kl[k];
          visit(i, j, ch.parent[j] === i ? ch.segLen[j] : ch.gap(i, j));
        }
      }
    }
    for (let i = 0; i < n; i++) if (!Number.isFinite(this.arrival[i])) this.arrival[i] = 1e9;
    this.maxArrival = maxT;
    this.order = order.subarray(0, tail);

    // Fold the two current-reduction factors into one per-node multiplier
    // so the hot loop does a single multiply.
    this.atten = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.atten[i] = mtleAttenuation(this.pathDist[i], this.mtleLambda) *
        this.branchAtten[i];
    }
  }

  /**
   * Integrate forward by dt of simulated time, sub-stepping so the thermal
   * ODE stays stable through the microsecond-scale current front.
   */
  advance(dt) {
    if (this.finished) return;
    const ch = this.channel;
    const n = ch.count;
    // Resolve the front finely, then coarsen through the tail where
    // nothing changes quickly and most of the wall-clock cost would be.
    const onFront = this.t < this.maxArrival + 6 * this.wave.tPeak;
    const maxSub = onFront
      ? Math.min(this.wave.tau1 * 0.5, 2e-6)
      : Math.max(this.wave.tau2 * 0.08, 4e-6);
    const steps = Math.max(1, Math.min(48, Math.ceil(dt / maxSub)));
    const h = dt / steps;

    for (let s = 0; s < steps; s++) {
      this.t += h;
      let iBase = 0;
      const tNow = this.t;
      for (let i = 0; i < n; i++) {
        const te = tNow - this.arrival[i];
        // Nothing to do for channel the front has not reached yet and that
        // holds no residual heat. Early in a stroke that is most of it.
        if (te <= 0 && this.W[i] <= 0) continue;
        let I = 0;
        if (te > 0) {
          I = this.wave.current(te) * this.atten[i];
        }
        ch.current[i] = I;
        const W = this.thermal.step(this.W[i], I, h);
        this.W[i] = W;
        ch.temp[i] = this.thermal.temperature(W);
        ch.lum[i] = this.thermal.luminance(W);
        if (W > this.peakEnergy) this.peakEnergy = W;
        if (i === this.start) iBase = I;
        this.energy += I * I * this.thermal.Rp * ch.segLen[i] * h;
      }
      this.chargeTransferred += iBase * h;
      if (iBase > this.peakSoFar) this.peakSoFar = iBase;
    }
    this.peakTemperature = this.thermal.temperature(this.peakEnergy);

    // Neutralise the leader charge as the front sweeps past. A subsequent
    // stroke has to start from a channel that no longer holds the charge
    // this one just drained.
    const frac = Math.min(1, this.t / Math.max(this.maxArrival, 1e-9));
    this.neutralised = frac;

    if (this.t >= this.duration) this.finished = true;
  }

  /** Base current right now, in amperes. */
  get baseCurrent() {
    return this.channel.current[this.start] || 0;
  }
}

/**
 * Dart leader: the fast, unbranched leader that retraces a still-warm
 * channel to set up a subsequent stroke.
 *
 * It travels a hundred times faster than the stepped leader (1-2e7 m/s
 * against 2e5) for the simple reason that it is not breaking down virgin
 * air — the previous stroke left a hot, partly ionised path, and the dart
 * only has to re-heat it. That is also why subsequent strokes are almost
 * never branched: the dart follows one channel, so the branches the
 * stepped leader made are not re-illuminated.
 */
export class DartLeader {
  /**
   * @param {Channel} channel
   * @param {number} fromNode  cloud end of the path
   * @param {number} toNode    ground end of the path
   */
  constructor(channel, fromNode, toNode, speed) {
    this.channel = channel;
    this.speed = speed;
    this.t = 0;
    this.finished = false;

    // The path is the unique route through the graph between the two ends.
    const dist = channel.propagateDistanceFrom(toNode);
    void dist;
    this.path = this._tracePath(fromNode, toNode);
    this.length = 0;
    this.cum = new Float32Array(this.path.length);
    for (let i = 1; i < this.path.length; i++) {
      this.length += channel.gap(this.path[i - 1], this.path[i]);
      this.cum[i] = this.length;
    }
    this.duration = this.length / speed;
  }

  _tracePath(from, to) {
    const ch = this.channel;
    const kids = ch.buildTopology();
    const n = ch.count;
    const prev = new Int32Array(n).fill(-1);
    const seen = new Uint8Array(n);
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    q[tail++] = from; seen[from] = 1;
    while (head < tail) {
      const i = q[head++];
      if (i === to) break;
      const p = ch.parent[i];
      if (p >= 0 && !seen[p]) { seen[p] = 1; prev[p] = i; q[tail++] = p; }
      const kl = kids[i];
      if (kl) for (let k = 0; k < kl.length; k++) {
        const j = kl[k];
        if (!seen[j]) { seen[j] = 1; prev[j] = i; q[tail++] = j; }
      }
    }
    const path = [];
    for (let i = to; i >= 0; i = prev[i]) { path.push(i); if (i === from) break; }
    path.reverse();
    return path;
  }

  advance(dt) {
    this.t += dt;
    const front = this.t * this.speed;
    const ch = this.channel;
    for (let i = 0; i < this.path.length; i++) {
      const node = this.path[i];
      const behind = front - this.cum[i];
      if (behind < 0) continue;
      // A short, bright tip with a decaying tail behind it.
      const glow = Math.exp(-behind / 400) * 0.55 + 0.06;
      if (glow > ch.lum[node]) {
        ch.lum[node] = glow;
        ch.temp[node] = 12000;
      }
    }
    if (this.t >= this.duration) this.finished = true;
  }

  get tipIndex() {
    const front = this.t * this.speed;
    let i = 0;
    while (i < this.path.length - 1 && this.cum[i + 1] < front) i++;
    return this.path[i];
  }
}

/**
 * Continuing current: a low, steady current (100-200 A) that keeps
 * flowing down an already established channel for tens to hundreds of
 * milliseconds after a stroke. It is present in roughly a third to a half
 * of negative flashes, transfers most of the charge in those flashes, and
 * is what actually sets fires and burns holes in aircraft skins — the
 * damage mechanism is heat delivered slowly, not the 30 kA spike.
 *
 * M-components ride on top of it: brief re-brightenings a few hundred
 * microseconds wide, each adding a hundred amps or two. On a video they
 * are the flickers that make a bolt appear to pulse.
 */
export class ContinuingCurrent {
  constructor(o) {
    this.channel = o.channel;
    this.path = o.path;
    this.current = o.current;
    this.duration = o.duration;
    this.rng = o.rng;
    this.thermal = o.thermal || new ChannelThermal();
    this.t = 0;
    this.finished = false;
    this.charge = 0;
    this.mComponents = [];
    // Schedule the M-components up front so they are reproducible.
    let mt = 0;
    while (true) {
      mt += this.rng.logNormal(4e-3, 0.8);
      if (mt > this.duration) break;
      this.mComponents.push({ t: mt, amp: this.rng.logNormal(180, 0.6) });
    }
    this.W = new Float32Array(this.channel.count);
  }

  advance(dt) {
    this.t += dt;
    let I = this.current;
    for (const m of this.mComponents) {
      const te = this.t - m.t;
      if (te > 0 && te < 6e-3) {
        // Rise in a few hundred microseconds, fall over a couple of ms.
        I += m.amp * Math.min(1, te / 4e-4) * Math.exp(-te / 1.5e-3);
      }
    }
    this.charge += I * dt;
    const ch = this.channel;
    for (let k = 0; k < this.path.length; k++) {
      const i = this.path[k];
      ch.current[i] = I;
      this.W[i] = this.thermal.step(this.W[i], I, dt);
      ch.temp[i] = this.thermal.temperature(this.W[i]);
      ch.lum[i] = Math.max(ch.lum[i], this.thermal.luminance(this.W[i]));
      ch.setFlag(i, NODE.MAIN);
    }
    this.instant = I;
    if (this.t >= this.duration) this.finished = true;
  }
}
