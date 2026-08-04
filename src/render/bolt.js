/**
 * bolt.js — drawing the channel.
 *
 * A lightning channel is a centimetre-wide thread of 30 000 K plasma that
 * looks metres wide because it is blindingly overexposed against a dark
 * sky. Rendering it as geometry of its real width would produce an
 * invisible hairline; rendering it as a fat glowing tube loses the thing
 * that makes lightning legible, which is the hard bright core inside a
 * soft halo. So each segment is drawn as a view-aligned capsule whose
 * fragment shader evaluates two radial profiles at once: a tight core
 * that saturates to white and a wide inverse-square halo carrying the
 * blackbody colour of the plasma at that segment's temperature.
 *
 * Segments are subdivided on the way to the GPU. The physics runs at a
 * step length of tens of metres, but real channels are tortuous at every
 * scale down to centimetres, so each physical segment is split and its
 * midpoints displaced by a deterministic fractal offset. This adds no
 * physics; it restores the small-scale structure the simulation's
 * resolution cannot represent, and it is seeded per node so a channel
 * never shimmers between frames.
 */

import * as THREE from 'three';
import { blackbodyRGB } from '../core/current.js';

const VERT = /* glsl */`
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec3 aColor;
  attribute float aIntensity;
  attribute float aRadius;

  uniform vec2 uViewport;
  uniform float uFovScale;     // 2 tan(fov/2) / viewportHeight
  uniform float uMinPixels;
  uniform float uWidthScale;

  varying vec2 vLocal;         // (along, across) in units of the capsule radius
  varying float vHalfLen;      // half length, same units
  varying vec3 vColor;
  varying float vIntensity;

  void main() {
    vec3 s = (modelViewMatrix * vec4(aStart, 1.0)).xyz;
    vec3 e = (modelViewMatrix * vec4(aEnd, 1.0)).xyz;
    vec3 mid = 0.5 * (s + e);
    vec3 axis = e - s;
    float len = length(axis);
    if (len < 1e-6) axis = vec3(1.0, 0.0, 0.0); else axis /= len;

    // World radius, with a floor in screen space so a distant channel
    // stays visible rather than aliasing into nothing. Overexposed bright
    // objects genuinely do bloom past their geometric size.
    float dist = max(0.001, -mid.z);
    float pxWorld = uFovScale * dist;
    float radius = max(aRadius * uWidthScale, uMinPixels * pxWorld);

    // Perpendicular to the segment and to the view ray: the capsule's
    // silhouette from where the camera happens to be.
    vec3 toEye = normalize(-mid);
    vec3 across = cross(axis, toEye);
    float al = length(across);
    if (al < 1e-4) across = normalize(cross(axis, vec3(0.0, 0.0, 1.0)));
    else across /= al;

    float halfLen = 0.5 * len;
    // position.x in [-1,1] along, position.y in [-1,1] across.
    float u = position.x * (halfLen + radius);
    float v = position.y * radius;
    vec3 p = mid + axis * u + across * v;

    vLocal = vec2(u, v) / radius;
    vHalfLen = halfLen / radius;
    vColor = aColor;
    vIntensity = aIntensity;
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vLocal;
  varying float vHalfLen;
  varying vec3 vColor;
  varying float vIntensity;

  uniform float uCoreWidth;
  uniform float uGlowStrength;
  uniform float uExposure;

  void main() {
    // Distance from the capsule's axis, in radius units.
    float along = max(abs(vLocal.x) - vHalfLen, 0.0);
    float d = length(vec2(along, vLocal.y));

    // Two profiles. The core is a narrow gaussian that clips to white
    // because anything this hot is far beyond the sensor's range; the
    // halo is a soft inverse-square that carries the plasma's colour.
    float core = exp(-(d * d) / (uCoreWidth * uCoreWidth));
    float halo = 1.0 / (1.0 + 9.0 * d * d);
    halo *= halo;

    // The core is the thing that reads as lightning. Against a night sky
    // almost anything does; against a daylit photograph the channel has to
    // out-run a background already at half of full scale, so the core is
    // driven hard into clipping and the halo is kept narrow. A wide soft
    // halo at the same energy just fogs the image and the streak
    // disappears into it.
    vec3 c = vColor * (halo * uGlowStrength) + vec3(1.0) * core * 2.2;
    float a = clamp(core + halo, 0.0, 1.0);
    if (a < 0.002) discard;

    gl_FragColor = vec4(c * vIntensity * uExposure, 1.0);
  }
`;

/** Deterministic hash -> [-1, 1], so tortuosity never flickers. */
function hash1(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export class BoltRenderer {
  /**
   * @param {object} o
   *   maxSegments   upper bound on drawn sub-segments
   *   subdivisions  how many render sub-segments per physical segment
   */
  constructor(o = {}) {
    this.subdiv = o.subdivisions ?? 3;
    this.maxSegments = o.maxSegments ?? 60000;
    this.tortuosity = o.tortuosity ?? 0.16;

    const quad = new Float32Array([
      -1, -1, 1, -1, 1, 1,
      -1, -1, 1, 1, -1, 1,
    ]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(quad, 2));

    const n = this.maxSegments;
    this.aStart = new Float32Array(n * 3);
    this.aEnd = new Float32Array(n * 3);
    this.aColor = new Float32Array(n * 3);
    this.aIntensity = new Float32Array(n);
    this.aRadius = new Float32Array(n);

    const attr = (arr, size) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('aStart', attr(this.aStart, 3));
    geo.setAttribute('aEnd', attr(this.aEnd, 3));
    geo.setAttribute('aColor', attr(this.aColor, 3));
    geo.setAttribute('aIntensity', attr(this.aIntensity, 1));
    geo.setAttribute('aRadius', attr(this.aRadius, 1));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4000, 0), 40000);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uViewport: { value: new THREE.Vector2(1, 1) },
        uFovScale: { value: 0.001 },
        // A channel five kilometres away is a sub-pixel feature. Without a
        // floor on its screen width it aliases into a dotted line and
        // loses most of its brightness to coverage; 2.2 pixels is enough
        // for the core to survive resampling.
        uMinPixels: { value: 2.2 },
        uWidthScale: { value: 1.0 },
        uCoreWidth: { value: 0.30 },
        uGlowStrength: { value: 0.6 },
        // Segments overlap heavily under additive blending — three
        // sub-segments per physical step, plus every branch crossing the
        // trunk in projection — so the per-segment level has to sit well
        // below one for the *sum* to land where it should.
        uExposure: { value: 0.55 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.geometry = geo;

    /** Brightest points, handed to the lighting of everything else. */
    this.lights = [];
    this.totalRadiance = 0;

    /**
     * Retinal persistence.
     *
     * A return stroke is over in a couple of hundred microseconds, and a
     * whole multi-stroke flash spends most of its few hundred milliseconds
     * completely dark. Nobody has ever seen that. The eye integrates over
     * roughly a tenth of a second, so what a person actually perceives is
     * the union of everything that happened in that window, held up as one
     * bright bolt — and a camera on any normal exposure does the same
     * thing. Without modelling that, a physically correct simulation shows
     * a channel that flickers into nothing between strokes and looks
     * wrong precisely because it is right.
     *
     * The decay runs on wall-clock time, not simulated time, because it is
     * a property of the observer rather than of the lightning.
     */
    this.persistence = new Float32Array(0);
    this.persistenceTau = o.persistenceTau ?? 0.11;   // seconds, human vision
    this.persistenceGain = o.persistenceGain ?? 0.85;
  }

  resetPersistence() { this.persistence.fill(0); }

  setViewport(width, height, fovDegrees) {
    this.material.uniforms.uViewport.value.set(width, height);
    this.material.uniforms.uFovScale.value =
      2 * Math.tan(THREE.MathUtils.degToRad(fovDegrees) * 0.5) / height;
  }

  /**
   * Rebuild the instance buffers from the current channel state.
   *
   * @param {Channel} channel
   * @param {object} opts  {minLum, widthScale, maxLights, worldScale}
   */
  update(channel, opts = {}) {
    const minLum = opts.minLum ?? 0.004;
    const sub = this.subdiv;
    const tort = this.tortuosity;
    const S = this.aStart, E = this.aEnd, C = this.aColor,
      I = this.aIntensity, R = this.aRadius;

    let k = 0;
    let radiance = 0;
    const lights = [];
    const n = channel.count;

    // Advance the observer's persistence: the instantaneous channel, or
    // whatever is left of what it was a moment ago, whichever is brighter.
    if (this.persistence.length < n) {
      const p = new Float32Array(Math.max(n, 1024));
      p.set(this.persistence);
      this.persistence = p;
    }
    const decay = this.persistenceTau > 0
      ? Math.exp(-(opts.dtWall ?? 1 / 60) / this.persistenceTau) : 0;
    const P = this.persistence;
    const gain = this.persistenceGain;
    for (let i = 0; i < n; i++) {
      const held = P[i] * decay;
      const now = channel.lum[i];
      P[i] = now > held ? now : held;
    }

    for (let i = 0; i < n; i++) {
      const p = channel.parent[i];
      if (p < 0) continue;
      const lum = Math.max(channel.lum[i], P[i] * gain);
      if (lum < minLum) continue;
      if (k + sub > this.maxSegments) break;

      const col = blackbodyRGB(Math.max(2500, channel.temp[i] || 8000));
      // Radius grows with luminosity: a hotter channel really is optically
      // thick over a larger radius, and the eye reads brightness as size.
      // A brighter channel really is optically thick over a larger radius,
      // and the eye reads intensity partly as size, so width tracks
      // luminosity rather than being fixed.
      const rad = (1.2 + 4.2 * Math.min(1.6, lum)) * (opts.radiusScale ?? 1);

      const x0 = channel.x[p], y0 = channel.y[p], z0 = channel.z[p];
      const x1 = channel.x[i], y1 = channel.y[i], z1 = channel.z[i];
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

      // A frame perpendicular to the segment, for the fractal offsets.
      let ax = -dy, ay = dx, az = 0;
      if (Math.abs(dx) + Math.abs(dy) < 1e-3) { ax = 1; ay = 0; az = 0; }
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al; ay /= al; az /= al;
      const bx = (dy * az - dz * ay) / segLen;
      const by = (dz * ax - dx * az) / segLen;
      const bz = (dx * ay - dy * ax) / segLen;

      const amp = tort * segLen;
      let px = x0, py = y0, pz = z0;
      for (let s = 1; s <= sub; s++) {
        const t = s / sub;
        let qx = x0 + dx * t, qy = y0 + dy * t, qz = z0 + dz * t;
        if (s < sub) {
          // Offsets taper to zero at the endpoints so sub-segments join.
          const w = Math.sin(Math.PI * t) * amp;
          const h1 = hash1(i * 7.13 + s * 3.77);
          const h2 = hash1(i * 11.9 + s * 5.31);
          qx += (ax * h1 + bx * h2) * w;
          qy += (ay * h1 + by * h2) * w;
          qz += (az * h1 + bz * h2) * w;
        }
        const j3 = k * 3;
        S[j3] = px; S[j3 + 1] = pz; S[j3 + 2] = py;   // sim z is world up
        E[j3] = qx; E[j3 + 1] = qz; E[j3 + 2] = qy;
        C[j3] = col[0]; C[j3 + 1] = col[1]; C[j3 + 2] = col[2];
        I[k] = lum;
        R[k] = rad;
        k++;
        px = qx; py = qy; pz = qz;
      }

      radiance += lum * segLen;
      if (lum > 0.12) lights.push({ x: x1, y: z1, z: y1, lum, seg: segLen, col });
    }

    this.geometry.instanceCount = k;
    this.segmentCount = k;
    this.totalRadiance = radiance;

    for (const a of ['aStart', 'aEnd', 'aColor', 'aIntensity', 'aRadius']) {
      const at = this.geometry.getAttribute(a);
      at.addUpdateRange ? at.addUpdateRange(0, k * at.itemSize) : 0;
      at.needsUpdate = true;
    }

    this._pickLights(lights, opts.maxLights ?? 6);
  }

  /**
   * Reduce the channel to a handful of point lights for everything else in
   * the scene to be lit by. Chosen by luminosity times length, then spread
   * apart so a single bright metre of channel does not take every slot —
   * the whole bolt illuminates the landscape, not just its brightest inch.
   */
  _pickLights(candidates, maxLights) {
    candidates.sort((a, b) => (b.lum * b.seg) - (a.lum * a.seg));
    const out = [];
    const minSep = 260;
    for (const c of candidates) {
      let ok = true;
      for (const o of out) {
        const d = Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z);
        if (d < minSep) { o.lum += c.lum * 0.35; ok = false; break; }
      }
      if (ok) out.push({ ...c });
      if (out.length >= maxLights) break;
    }
    this.lights = out;
  }

  setExposure(v) { this.material.uniforms.uExposure.value = v; }
  setWidthScale(v) { this.material.uniforms.uWidthScale.value = v; }
  setGlow(v) { this.material.uniforms.uGlowStrength.value = v; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
