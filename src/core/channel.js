/**
 * channel.js — the discharge tree.
 *
 * A flash is a graph, not a polyline. Every node except a root has one
 * parent, so the structure is a forest: typically two trees sharing an
 * initiation point, one grown by the negative end of the bidirectional
 * leader and one by the positive end. Segments are (parent -> node)
 * pairs, which makes the whole thing renderable as a flat instanced
 * buffer and traversable in creation order without recursion.
 *
 * Per-node state carries the physics the renderer and the acoustics both
 * need: deposited charge, arc length from the root, distance from the
 * eventual attachment point (which sets when the return-stroke front
 * arrives), instantaneous current, channel temperature and luminosity.
 */

const INIT_CAP = 8192;

export const NODE = {
  TIP: 1,          // currently an active growth point
  GROUNDED: 2,     // reached the earth or a struck object
  DEAD: 4,         // growth stalled: no candidate above threshold
  PRUNED: 8,       // branch not retraced by a dart leader
  UPWARD: 16,      // part of an upward connecting leader
  MAIN: 32,        // lies on the main channel from ground to origin
};

export class Channel {
  constructor(cap = INIT_CAP) {
    this._alloc(cap);
    this.count = 0;
    this.roots = [];
    this.totalLength = 0;
    this.totalCharge = 0;
    /**
     * Extra undirected edges. The tree structure cannot express the one
     * thing that matters most in a cloud-to-ground flash: the junction
     * where a descending leader and an upward connecting leader meet. That
     * splice joins two separately rooted trees, so it lives here.
     */
    this.links = [];
    /** filled in by buildTopology() */
    this.children = null;
  }

  /** Splice two nodes together (used at the attachment point). */
  link(a, b) {
    this.links.push(a, b);
    this.children = null;
    this.totalLength += Math.hypot(
      this.x[a] - this.x[b], this.y[a] - this.y[b], this.z[a] - this.z[b]);
  }

  _alloc(cap) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.parent = new Int32Array(cap);
    this.arcLen = new Float32Array(cap);   // m from root along the channel
    this.pathLen = new Float32Array(cap);  // m from attachment point
    this.segLen = new Float32Array(cap);   // m, length of (parent -> this)
    this.charge = new Float64Array(cap);   // C deposited on this segment
    this.phiAmb = new Float64Array(cap);   // V, cloud potential at the node
    this.phiOther = new Float64Array(cap); // V, rest of the channel's contribution
    this.selfCoeff = new Float64Array(cap);// V/C, segment self-potential coefficient
    /**
     * Effective electrical length from the initiation point: real length,
     * but with each segment weighted by how many junctions the current
     * feeding it has had to squeeze through. Multiplying by the internal
     * gradient gives the potential drop from the origin to that node.
     */
    this.dropLen = new Float32Array(cap);
    /**
     * Which leader grew this node. A cloud-to-ground flash has at least
     * two independent conductors in the air at once — the descending
     * leader, floating and neutral, and the upward connecting leader,
     * clamped to earth — and each solves its own charges against its own
     * boundary condition until the moment they splice together.
     */
    this.owner = new Uint8Array(cap);
    this.lum = new Float32Array(cap);      // 0..1+ optical output
    this.temp = new Float32Array(cap);     // K
    this.current = new Float32Array(cap);  // A
    this.birth = new Float32Array(cap);    // s, sim time the segment formed
    this.level = new Uint8Array(cap);      // branch generation, 0 = trunk
    this.flags = new Uint8Array(cap);
    this.polarity = new Int8Array(cap);    // -1 negative leader, +1 positive
  }

  _grow() {
    const old = {
      x: this.x, y: this.y, z: this.z, parent: this.parent, arcLen: this.arcLen,
      pathLen: this.pathLen, segLen: this.segLen, charge: this.charge,
      phiAmb: this.phiAmb, phiOther: this.phiOther, selfCoeff: this.selfCoeff,
      dropLen: this.dropLen, owner: this.owner,
      lum: this.lum, temp: this.temp, current: this.current, birth: this.birth,
      level: this.level, flags: this.flags, polarity: this.polarity,
    };
    this._alloc(this.cap * 2);
    for (const k of Object.keys(old)) this[k].set(old[k]);
  }

  clear() {
    this.count = 0;
    this.roots.length = 0;
    this.totalLength = 0;
    this.totalCharge = 0;
    this.children = null;
    this.flags.fill(0);
    this.lum.fill(0);
    this.current.fill(0);
    this.temp.fill(0);
  }

  /**
   * Append a node. `parent` of -1 starts a new tree.
   * Returns the new node index.
   */
  add(x, y, z, parent, opts = {}) {
    if (this.count >= this.cap) this._grow();
    const i = this.count++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.parent[i] = parent;
    this.charge[i] = opts.charge || 0;
    this.phiAmb[i] = opts.phiAmb || 0;
    this.phiOther[i] = opts.phiOther || 0;
    this.selfCoeff[i] = opts.selfCoeff || 0;
    this.owner[i] = opts.owner || 0;
    this.lum[i] = opts.lum || 0;
    this.temp[i] = opts.temp || 0;
    this.current[i] = 0;
    this.birth[i] = opts.birth || 0;
    this.level[i] = opts.level || 0;
    this.flags[i] = opts.flags || 0;
    this.polarity[i] = opts.polarity || -1;

    if (parent < 0) {
      this.roots.push(i);
      this.arcLen[i] = 0;
      this.segLen[i] = 0;
      this.dropLen[i] = 0;
    } else {
      const d = Math.hypot(x - this.x[parent], y - this.y[parent], z - this.z[parent]);
      this.segLen[i] = d;
      this.arcLen[i] = this.arcLen[parent] + d;
      // Only this segment's own length is penalised for its branch order;
      // the trunk it hangs off keeps the weight it already had.
      this.dropLen[i] = this.dropLen[parent] + d * (opts.dropWeight || 1);
      this.totalLength += d;
    }
    this.totalCharge += this.charge[i];
    this.children = null;   // topology invalidated
    return i;
  }

  setFlag(i, f) { this.flags[i] |= f; }
  clearFlag(i, f) { this.flags[i] &= ~f; }
  hasFlag(i, f) { return (this.flags[i] & f) !== 0; }

  /** Adjacency lists, built on demand (return stroke, pruning, acoustics). */
  buildTopology() {
    if (this.children) return this.children;
    const ch = new Array(this.count);
    for (let i = 0; i < this.count; i++) ch[i] = null;
    for (let i = 0; i < this.count; i++) {
      const p = this.parent[i];
      if (p >= 0) (ch[p] || (ch[p] = [])).push(i);
    }
    for (let k = 0; k < this.links.length; k += 2) {
      const a = this.links[k], b = this.links[k + 1];
      (ch[a] || (ch[a] = [])).push(b);
      (ch[b] || (ch[b] = [])).push(a);
    }
    this.children = ch;
    return ch;
  }

  /** Straight-line distance between two nodes. */
  gap(a, b) {
    return Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b], this.z[a] - this.z[b]);
  }

  /**
   * Breadth-first distance along the channel from a starting node, in
   * both directions (a return-stroke front runs up the trunk and then
   * out into every branch it passes). Fills pathLen[] and returns the
   * traversal order, which is also the order the front illuminates.
   */
  propagateDistanceFrom(start) {
    const ch = this.buildTopology();
    const n = this.count;
    const dist = this.pathLen;
    dist.fill(Infinity, 0, n);
    const order = new Int32Array(n);
    let head = 0, tail = 0;
    dist[start] = 0;
    order[tail++] = start;
    while (head < tail) {
      const i = order[head++];
      const di = dist[i];
      const p = this.parent[i];
      if (p >= 0 && dist[p] === Infinity) {
        dist[p] = di + this.segLen[i];
        order[tail++] = p;
      }
      const kids = ch[i];
      if (kids) {
        for (let k = 0; k < kids.length; k++) {
          const j = kids[k];
          if (dist[j] === Infinity) {
            // Geometric distance, so spliced edges are measured correctly.
            dist[j] = di + (this.parent[j] === i ? this.segLen[j] : this.gap(i, j));
            order[tail++] = j;
          }
        }
      }
    }
    // Anything unreachable (a separate tree) gets a very late arrival.
    for (let i = 0; i < n; i++) if (!Number.isFinite(dist[i])) dist[i] = 1e9;
    return order.subarray(0, tail);
  }

  /** Mark the unique path from `node` back to its root as the main channel. */
  markMainPath(node) {
    let i = node;
    let len = 0;
    while (i >= 0) {
      this.flags[i] |= NODE.MAIN;
      len += this.segLen[i];
      i = this.parent[i];
    }
    return len;
  }

  /** Indices currently flagged as active tips. */
  tips() {
    const out = [];
    for (let i = 0; i < this.count; i++) if (this.flags[i] & NODE.TIP) out.push(i);
    return out;
  }

  /** Lowest node in the tree — the one that will attach to ground. */
  lowestNode() {
    let best = -1, bz = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.z[i] < bz) { bz = this.z[i]; best = i; }
    }
    return best;
  }

  /** Bounding box, for camera framing and acoustic bookkeeping. */
  bounds() {
    if (!this.count) return null;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.x[i] < x0) x0 = this.x[i]; if (this.x[i] > x1) x1 = this.x[i];
      if (this.y[i] < y0) y0 = this.y[i]; if (this.y[i] > y1) y1 = this.y[i];
      if (this.z[i] < z0) z0 = this.z[i]; if (this.z[i] > z1) z1 = this.z[i];
    }
    return { x0, y0, z0, x1, y1, z1 };
  }

  /**
   * Total deposited charge magnitude — the charge a return stroke has to
   * neutralise, and hence (divided by the stroke duration) the scale of
   * the current it must carry.
   */
  chargeMagnitude() {
    let s = 0;
    for (let i = 0; i < this.count; i++) s += Math.abs(this.charge[i]);
    return s;
  }
}
