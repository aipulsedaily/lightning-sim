/**
 * ground.js — landscape and strike targets.
 *
 * The terrain exists to do one job: give the flash something to light. A
 * bolt against an empty sky has no scale; the same bolt over a horizon
 * with a mast on it is instantly ten kilometres away and two kilometres
 * tall. So the surface is a wide, gently rolling plane with a wet, dark,
 * strongly view-dependent response — because the ground under a storm is
 * soaked, and wet ground is what makes a flash reflect.
 *
 * Its lighting comes entirely from the channel. There is no sun; the only
 * light sources in the scene are the few brightest points of the plasma,
 * so illumination direction, colour and falloff all follow the bolt.
 */

import * as THREE from 'three';

const GROUND_VERT = /* glsl */`
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;

  uniform float uAmplitude;
  uniform float uScale;

  float hash(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y * 41.17);
  }

  float vnoise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
  }

  float terrain(vec2 p) {
    float h = 0.0, a = 1.0, f = 1.0;
    for (int i = 0; i < 5; i++) {
      h += a * vnoise(p * f);
      f *= 2.07; a *= 0.47;
    }
    return h;
  }

  void main() {
    vec3 p = position;
    float e = 12.0;
    float h  = terrain(p.xz * uScale);
    float hx = terrain((p.xz + vec2(e, 0.0)) * uScale);
    float hz = terrain((p.xz + vec2(0.0, e)) * uScale);
    // Flatten towards the middle so a strike has somewhere level to land.
    // ("flat" is a reserved interpolation qualifier in GLSL ES 3.0.)
    float levelness = smoothstep(0.0, 2600.0, length(p.xz));
    float amp = uAmplitude * levelness;
    p.y += h * amp;
    vHeight = h;

    vec3 dx = vec3(e, (hx - h) * amp, 0.0);
    vec3 dz = vec3(0.0, (hz - h) * amp, e);
    vNormal = normalize(cross(dz, dx));
    vWorld = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const GROUND_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;

  uniform int   uLightCount;
  uniform vec3  uLightPos[8];
  uniform vec3  uLightColor[8];
  uniform float uLightPower[8];
  uniform vec3  uCameraPos;
  uniform vec3  uAmbient;
  uniform vec3  uAlbedo;
  uniform float uWetness;
  uniform float uFogDensity;
  uniform vec3  uFogColor;
  uniform float uExposure;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(uCameraPos - vWorld);

    // Slight variation so the plane is not a single flat tone.
    vec3 albedo = uAlbedo * (0.75 + 0.5 * vHeight);

    vec3 diffuse = vec3(0.0);
    vec3 specular = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= uLightCount) break;
      vec3 d = uLightPos[i] - vWorld;
      float r2 = dot(d, d);
      vec3 l = d * inversesqrt(max(r2, 1.0));
      float ndl = max(dot(n, l), 0.0);
      float atten = uLightPower[i] / (r2 + 4000.0);
      diffuse += uLightColor[i] * ndl * atten;

      // Wet ground: a broad, grazing-angle sheen rather than a point
      // highlight, which is what a puddled field actually does.
      vec3 h = normalize(l + v);
      float spec = pow(max(dot(n, h), 0.0), 42.0);
      float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
      specular += uLightColor[i] * spec * atten * (0.25 + 2.5 * fres) * uWetness;
    }

    vec3 col = albedo * (uAmbient + diffuse) + specular;

    float dist = length(uCameraPos - vWorld);
    float fog = 1.0 - exp(-dist * uFogDensity);
    col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(col * uExposure, 1.0);
  }
`;

function lightUniforms() {
  const pos = [], col = [];
  for (let i = 0; i < 8; i++) { pos.push(new THREE.Vector3()); col.push(new THREE.Color()); }
  return {
    uLightCount: { value: 0 },
    uLightPos: { value: pos },
    uLightColor: { value: col },
    uLightPower: { value: new Float32Array(8) },
  };
}

/** Copy bolt lights into a material's uniforms. */
export function applyLights(material, lights, gain = 1) {
  const u = material.uniforms;
  const n = Math.min(8, lights.length);
  for (let i = 0; i < n; i++) {
    const l = lights[i];
    u.uLightPos.value[i].set(l.x, l.y, l.z);
    u.uLightColor.value[i].setRGB(l.col[0], l.col[1], l.col[2]);
    u.uLightPower.value[i] = l.lum * l.seg * gain;
  }
  u.uLightCount.value = n;
}

export class Ground {
  constructor(opts = {}) {
    const size = opts.size ?? 60000;
    const segs = opts.segments ?? 400;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: {
        uAmplitude: { value: opts.amplitude ?? 130 },
        uScale: { value: opts.noiseScale ?? 0.00035 },
        uCameraPos: { value: new THREE.Vector3() },
        uAmbient: { value: new THREE.Color(0.010, 0.011, 0.015) },
        uAlbedo: { value: new THREE.Color(0.085, 0.082, 0.070) },
        uWetness: { value: opts.wetness ?? 0.7 },
        uFogDensity: { value: opts.fogDensity ?? 4.5e-5 },
        uFogColor: { value: new THREE.Color(0.020, 0.021, 0.028) },
        uExposure: { value: 1.0 },
        ...lightUniforms(),
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  update(camera, lights, gain) {
    this.material.uniforms.uCameraPos.value.copy(camera.position);
    applyLights(this.material, lights, gain);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * The objects a leader can attach to, drawn as simple silhouettes.
 *
 * A lattice mast and a few trees are enough. Their real job is in the
 * physics — they are the candidates the electrogeometric model chooses
 * between — but seeing the bolt actually hit the mast rather than the
 * field beside it is what makes that model legible.
 */
export class Structures {
  constructor(targets, opts = {}) {
    this.group = new THREE.Group();
    this.material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          vNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vWorld;
        varying vec3 vNormal;
        uniform int   uLightCount;
        uniform vec3  uLightPos[8];
        uniform vec3  uLightColor[8];
        uniform float uLightPower[8];
        uniform vec3  uAmbient;
        uniform vec3  uAlbedo;
        uniform vec3  uCameraPos;
        uniform float uFogDensity;
        uniform vec3  uFogColor;
        uniform float uExposure;
        void main() {
          vec3 n = normalize(vNormal);
          vec3 col = uAmbient;
          for (int i = 0; i < 8; i++) {
            if (i >= uLightCount) break;
            vec3 d = uLightPos[i] - vWorld;
            float r2 = dot(d, d);
            vec3 l = d * inversesqrt(max(r2, 1.0));
            col += uLightColor[i] * max(dot(n, l), 0.12) * uLightPower[i] / (r2 + 3000.0);
          }
          col *= uAlbedo;
          float dist = length(uCameraPos - vWorld);
          col = mix(col, uFogColor, clamp(1.0 - exp(-dist * uFogDensity), 0.0, 1.0));
          gl_FragColor = vec4(col * uExposure, 1.0);
        }
      `,
      uniforms: {
        uAmbient: { value: new THREE.Color(0.014, 0.015, 0.020) },
        uAlbedo: { value: new THREE.Color(0.12, 0.12, 0.13) },
        uCameraPos: { value: new THREE.Vector3() },
        uFogDensity: { value: opts.fogDensity ?? 4.5e-5 },
        uFogColor: { value: new THREE.Color(0.020, 0.021, 0.028) },
        uExposure: { value: 1.0 },
        ...lightUniforms(),
      },
    });

    for (const t of targets) this.group.add(this._build(t));
  }

  _build(t) {
    const g = new THREE.Group();
    // Simulation is z-up; the renderer is y-up.
    g.position.set(t.x, 0, t.y);

    if (t.kind === 'tree') {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(t.radius * 0.3, t.radius * 0.45, t.height * 0.35, 6),
        this.material);
      trunk.position.y = t.height * 0.175;
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(t.radius * 2.4, t.height * 0.78, 8),
        this.material);
      crown.position.y = t.height * 0.6;
      g.add(trunk, crown);
    } else {
      // A tapering lattice mast: four legs and a few cross braces.
      const h = t.height;
      const legs = 4;
      for (let i = 0; i < legs; i++) {
        const a = (i / legs) * Math.PI * 2 + Math.PI / 4;
        const r0 = t.radius * 2.2, r1 = t.radius * 0.35;
        const curve = new THREE.LineCurve3(
          new THREE.Vector3(Math.cos(a) * r0, 0, Math.sin(a) * r0),
          new THREE.Vector3(Math.cos(a) * r1, h, Math.sin(a) * r1));
        g.add(new THREE.Mesh(
          new THREE.TubeGeometry(curve, 1, Math.max(0.35, t.radius * 0.13), 5, false),
          this.material));
      }
      const rings = Math.max(3, Math.round(h / 22));
      for (let j = 1; j < rings; j++) {
        const y = (j / rings) * h;
        const r = t.radius * (2.2 + (0.35 - 2.2) * (j / rings));
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(r, Math.max(0.22, t.radius * 0.08), 4, legs),
          this.material);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = y;
        g.add(ring);
      }
      // The air terminal itself.
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.4, h * 0.09, 5), this.material);
      rod.position.y = h * 1.04;
      g.add(rod);
    }
    return g;
  }

  update(camera, lights, gain) {
    this.material.uniforms.uCameraPos.value.copy(camera.position);
    applyLights(this.material, lights, gain);
  }

  dispose() { this.material.dispose(); }
}
