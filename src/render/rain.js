/**
 * rain.js — the precipitation that made the charge in the first place.
 *
 * Not decoration. Thunderstorms electrify by non-inductive charging:
 * graupel colliding with ice crystals in the presence of supercooled
 * water exchanges charge, the sign depending on temperature, and the
 * updraught then separates the light crystals from the heavy graupel.
 * The rain falling out of the cloud base is the visible end of the same
 * process that built the charge regions this simulation starts from.
 *
 * Rendered as instanced streaks that fall, recycle within a moving box
 * around the camera, and are lit by the bolt like everything else.
 * Raindrops are tiny and fast, so what a camera or an eye records is a
 * motion-blurred streak whose length is the fall speed times the
 * integration time — which is why rain in a lightning photograph appears
 * as a field of short bright dashes only while the flash is lit.
 */

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec3 aOffset;
  attribute float aSpeed;
  attribute float aLength;
  attribute float aSeed;

  uniform float uTime;
  uniform vec3 uOrigin;
  uniform vec3 uExtent;
  uniform vec3 uWind;
  uniform float uStreak;

  varying float vAlong;
  varying vec3 vWorld;
  varying float vSeed;

  void main() {
    // Wrap each drop into a box that follows the camera, so a modest
    // number of instances covers any view.
    vec3 p = aOffset;
    p.y -= uTime * aSpeed;
    p += uWind * uTime;
    p = mod(p - uOrigin + uExtent * 0.5, uExtent) + uOrigin - uExtent * 0.5;

    float len = aLength * uStreak;
    // position.y in [0,1] runs along the streak; position.x across it.
    vec3 dir = normalize(vec3(uWind.x * 0.06, -1.0, uWind.z * 0.06));
    vec3 world = p + dir * (position.y * len);

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vec3 axisView = normalize(mat3(modelViewMatrix) * dir);
    vec3 across = normalize(cross(axisView, vec3(0.0, 0.0, 1.0)));
    float width = 0.10 + 0.16 * fract(aSeed * 7.3);
    mv.xyz += across * position.x * width;

    vAlong = position.y;
    vWorld = world;
    vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying float vAlong;
  varying vec3 vWorld;
  varying float vSeed;

  uniform int   uLightCount;
  uniform vec3  uLightPos[8];
  uniform vec3  uLightColor[8];
  uniform float uLightPower[8];
  uniform vec3  uAmbient;
  uniform float uExposure;
  uniform vec3  uCameraPos;
  uniform float uFogDensity;

  void main() {
    // Taper the streak so it does not read as a hard rectangle.
    float a = smoothstep(0.0, 0.18, vAlong) * (1.0 - smoothstep(0.72, 1.0, vAlong));

    vec3 lit = uAmbient;
    for (int i = 0; i < 8; i++) {
      if (i >= uLightCount) break;
      vec3 d = uLightPos[i] - vWorld;
      float r2 = dot(d, d);
      lit += uLightColor[i] * uLightPower[i] / (r2 + 6000.0);
    }
    float dist = length(uCameraPos - vWorld);
    lit *= exp(-dist * uFogDensity);

    gl_FragColor = vec4(lit * a * uExposure, a);
  }
`;

export class Rain {
  constructor(opts = {}) {
    this.count = opts.count ?? 26000;
    this.extent = new THREE.Vector3(
      opts.extentX ?? 1400, opts.extentY ?? 700, opts.extentZ ?? 1400);

    const quad = new Float32Array([
      -1, 0, 1, 0, 1, 1,
      -1, 0, 1, 1, -1, 1,
    ]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(quad, 2));

    const off = new Float32Array(this.count * 3);
    const spd = new Float32Array(this.count);
    const len = new Float32Array(this.count);
    const sed = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      off[i * 3] = (Math.random() - 0.5) * this.extent.x;
      off[i * 3 + 1] = (Math.random() - 0.5) * this.extent.y;
      off[i * 3 + 2] = (Math.random() - 0.5) * this.extent.z;
      // Terminal velocity of a raindrop is 4-9 m/s depending on its size.
      spd[i] = 4.5 + Math.random() * 4.5;
      len[i] = 1.6 + Math.random() * 3.4;
      sed[i] = Math.random();
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(spd, 1));
    geo.setAttribute('aLength', new THREE.InstancedBufferAttribute(len, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sed, 1));
    geo.instanceCount = this.count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const pos = [], col = [];
    for (let i = 0; i < 8; i++) { pos.push(new THREE.Vector3()); col.push(new THREE.Color()); }

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uExtent: { value: this.extent },
        uWind: { value: new THREE.Vector3(-3.5, 0, 1.2) },
        uStreak: { value: opts.streak ?? 1 },
        uAmbient: { value: new THREE.Color(0.010, 0.011, 0.015) },
        uExposure: { value: 1 },
        uCameraPos: { value: new THREE.Vector3() },
        uFogDensity: { value: 7e-5 },
        uLightCount: { value: 0 },
        uLightPos: { value: pos },
        uLightColor: { value: col },
        uLightPower: { value: new Float32Array(8) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  update(camera, time, lights, gain) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uOrigin.value.copy(camera.position);
    u.uOrigin.value.y = Math.max(camera.position.y, this.extent.y * 0.4);
    u.uCameraPos.value.copy(camera.position);
    const n = Math.min(8, lights.length);
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      u.uLightPos.value[i].set(l.x, l.y, l.z);
      u.uLightColor.value[i].setRGB(l.col[0], l.col[1], l.col[2]);
      u.uLightPower.value[i] = l.lum * l.seg * gain;
    }
    u.uLightCount.value = n;
  }

  setIntensity(fraction) {
    this.mesh.geometry.instanceCount = Math.floor(this.count * Math.max(0, Math.min(1, fraction)));
    this.mesh.visible = fraction > 0.001;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
