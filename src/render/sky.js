/**
 * sky.js — the storm, procedurally.
 *
 * Two things matter here and only two. The first is that the sky under a
 * thunderstorm is genuinely dark: the cloud deck is optically thick, and
 * the light reaching the ground has been scattered through kilometres of
 * water. The second is that when the flash happens, the cloud lights up
 * *from inside*. Most of a lightning channel is buried in cloud, and what
 * an observer usually sees is not the channel at all but several cubic
 * kilometres of water droplets briefly acting as a lampshade.
 *
 * So the cloud is raymarched as a real volume with a real density field,
 * and the bolt is fed into it as a set of point emitters. The illumination
 * is a single-scatter approximation with Beer-Lambert extinction along the
 * ray and towards each emitter, which is enough to get the two effects
 * that read as truth: light falls off through the cloud, and the parts of
 * the deck nearest the channel glow brightest.
 *
 * No textures. The density field is hash-based value noise evaluated in
 * the shader, so the storm exists nowhere but on the GPU.
 */

import * as THREE from 'three';

const SKY_FRAG = /* glsl */`
  precision highp float;

  varying vec2 vUv;

  uniform vec3 uCameraPos;
  uniform mat4 uInvProjView;
  uniform float uTime;

  uniform float uCloudBase;
  uniform float uCloudTop;
  uniform float uCoverage;
  uniform float uDensity;
  uniform vec3  uWind;

  uniform vec3 uSunDir;
  uniform vec3 uSkyZenith;
  uniform vec3 uSkyHorizon;
  uniform vec3 uGroundTint;
  uniform float uAmbient;

  uniform int   uLightCount;
  uniform vec3  uLightPos[8];
  uniform vec3  uLightColor[8];
  uniform float uLightPower[8];

  uniform int uSteps;
  uniform float uExposure;

  /* ---------------- hash-based value noise ---------------- */

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float valueNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * valueNoise(p);
      p = p * 2.03 + vec3(11.3, 7.7, 3.1);
      a *= 0.5;
    }
    return v;
  }

  /* ---------------- density field ---------------- */

  // A cumulonimbus is not a slab: it has a flat base where the air first
  // reaches saturation, a deep turbulent body, and a spreading anvil where
  // the updraught hits the tropopause. The vertical profile below encodes
  // that shape; the noise supplies the turbulence.
  float cloudDensity(vec3 p) {
    float h = (p.y - uCloudBase) / max(1.0, uCloudTop - uCloudBase);
    if (h < 0.0 || h > 1.0) return 0.0;

    // Sharp cut at the base, swelling body, anvil flare near the top.
    float profile = smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.72, 1.0, h));
    profile *= 0.55 + 0.75 * exp(-pow((h - 0.42) * 2.4, 2.0));
    float anvil = smoothstep(0.62, 0.80, h) * (1.0 - smoothstep(0.86, 1.0, h));

    vec3 q = (p + uWind * uTime) * 0.00021;
    q.y *= 1.9;
    float n = fbm(q);
    n += 0.35 * fbm(q * 3.7 + vec3(0.0, uTime * 0.004, 0.0));

    // Horizontal extent: dense core over the storm, thinning outwards,
    // with the anvil reaching much further than the body.
    float r = length(p.xz) * 0.0001;
    float core = exp(-r * r * 0.55);
    float spread = mix(core, exp(-r * r * 0.16), anvil);

    float d = (n * (0.55 + 0.85 * spread) - (1.0 - uCoverage) * 0.85) * profile * spread;
    return max(0.0, d) * uDensity;
  }

  /* ---------------- ray/slab ---------------- */

  bool slabHit(vec3 ro, vec3 rd, out float t0, out float t1) {
    if (abs(rd.y) < 1e-5) {
      if (ro.y < uCloudBase || ro.y > uCloudTop) return false;
      t0 = 0.0; t1 = 260000.0; return true;
    }
    float a = (uCloudBase - ro.y) / rd.y;
    float b = (uCloudTop - ro.y) / rd.y;
    t0 = min(a, b); t1 = max(a, b);
    t0 = max(t0, 0.0);
    return t1 > t0;
  }

  /* ---------------- background sky ---------------- */

  vec3 skyColor(vec3 rd) {
    float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 c = mix(uSkyHorizon, uSkyZenith, pow(up, 0.85));
    // Weak forward scattering towards where the sun would be, heavily
    // muted because it is behind a storm.
    float mu = max(0.0, dot(rd, uSunDir));
    c += uSkyHorizon * 0.35 * pow(mu, 8.0);
    c = mix(uGroundTint, c, smoothstep(-0.12, 0.06, rd.y));
    return c;
  }

  /* ---------------- lighting inside the cloud ---------------- */

  vec3 inScatter(vec3 p, float stepLen) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= uLightCount) break;
      vec3 d = uLightPos[i] - p;
      float r2 = dot(d, d);
      float r = sqrt(r2);
      // One shadow tap towards the emitter: enough to keep the far side of
      // a cloud tower darker than the near side without a second march.
      float occ = cloudDensity(p + d * (min(600.0, r * 0.35) / max(r, 1.0)));
      float trans = exp(-occ * 0.9 * min(600.0, r * 0.35));
      sum += uLightColor[i] * uLightPower[i] * trans / (r2 * 1e-6 + 60.0);
    }
    return sum * stepLen * 0.00035;
  }

  void main() {
    // Reconstruct the world-space ray for this pixel.
    vec4 near = uInvProjView * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec4 far  = uInvProjView * vec4(vUv * 2.0 - 1.0,  1.0, 1.0);
    vec3 rd = normalize(far.xyz / far.w - near.xyz / near.w);
    vec3 ro = uCameraPos;

    vec3 col = skyColor(rd);

    float t0, t1;
    if (slabHit(ro, rd, t0, t1)) {
      // Cap the marched distance rather than the step size. A ray near the
      // horizon can stay inside the slab for a hundred kilometres, and
      // dividing that by a fixed step count would give kilometre-long
      // steps that grossly over-integrate the in-scatter. Truncating
      // instead costs nothing: transmittance through that much cloud is
      // zero long before the far end.
      float maxStep = 620.0;
      t1 = min(t1, t0 + float(uSteps) * maxStep);
      float span = t1 - t0;
      if (span > 0.0) {
        float steps = float(uSteps);
        float dt = min(span / steps, maxStep);
        // Dither the start to trade banding for a little noise.
        float jitter = hash(vec3(gl_FragCoord.xy, 1.0));
        float t = t0 + dt * jitter;

        vec3 scattered = vec3(0.0);
        float transmittance = 1.0;
        vec3 ambient = mix(uSkyHorizon, uSkyZenith, 0.5) * uAmbient;

        for (int i = 0; i < 96; i++) {
          if (i >= uSteps || transmittance < 0.01) break;
          vec3 p = ro + rd * t;
          float d = cloudDensity(p);
          if (d > 0.0005) {
            float ext = d * dt;
            float a = 1.0 - exp(-ext);
            // Ambient light falls off with depth into the deck, so the
            // underside of a storm is darker than its flanks.
            float depth = clamp((uCloudTop - p.y) / (uCloudTop - uCloudBase), 0.0, 1.0);
            vec3 amb = ambient * (0.25 + 0.75 * pow(1.0 - depth, 1.5));
            vec3 lit = amb + inScatter(p, dt);
            scattered += transmittance * a * lit;
            transmittance *= 1.0 - a;
          }
          t += dt;
        }
        col = col * transmittance + scattered;
      }
    }

    gl_FragColor = vec4(col * uExposure, 1.0);
  }
`;

const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class SkyRenderer {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.scale = opts.scale ?? 0.5;
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    const lightPos = [];
    const lightCol = [];
    const lightPow = new Float32Array(8);
    for (let i = 0; i < 8; i++) {
      lightPos.push(new THREE.Vector3());
      lightCol.push(new THREE.Color(1, 1, 1));
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uInvProjView: { value: new THREE.Matrix4() },
        uTime: { value: 0 },
        uCloudBase: { value: opts.cloudBase ?? 1600 },
        uCloudTop: { value: opts.cloudTop ?? 13000 },
        uCoverage: { value: opts.coverage ?? 0.56 },
        uDensity: { value: opts.density ?? 0.020 },
        uWind: { value: new THREE.Vector3(-14, 0, 5) },
        uSunDir: { value: new THREE.Vector3(0.4, 0.12, -0.9).normalize() },
        // Late dusk under a storm. These are linear radiances, so they
        // look far darker as numbers than they do on screen: 0.04 linear
        // encodes to about 22% sRGB. Under a mature cumulonimbus the sky
        // really is this close to night.
        uSkyZenith: { value: new THREE.Color(0.012, 0.016, 0.028) },
        uSkyHorizon: { value: new THREE.Color(0.040, 0.040, 0.050) },
        uGroundTint: { value: new THREE.Color(0.007, 0.007, 0.010) },
        uAmbient: { value: 0.55 },
        uLightCount: { value: 0 },
        uLightPos: { value: lightPos },
        uLightColor: { value: lightCol },
        uLightPower: { value: lightPow },
        uSteps: { value: opts.steps ?? 34 },
        uExposure: { value: 1.0 },
      },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // The quad that pastes the result into the main scene.
    this.blitMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTex;
        void main() { gl_FragColor = vec4(texture2D(uTex, vUv).rgb, 1.0); }
      `,
      uniforms: { uTex: { value: this.target.texture } },
      depthTest: false,
      depthWrite: false,
    });
    this.blit = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMaterial);
    this.blit.frustumCulled = false;
    this.blit.renderOrder = -1000;
  }

  setSize(width, height) {
    this.target.setSize(Math.max(2, Math.floor(width * this.scale)),
      Math.max(2, Math.floor(height * this.scale)));
  }

  setQuality(scale, steps) {
    this.scale = scale;
    this.material.uniforms.uSteps.value = steps;
  }

  /** @param {Array} lights  from BoltRenderer.lights (world coordinates) */
  setLights(lights, gain = 1) {
    const u = this.material.uniforms;
    const n = Math.min(8, lights.length);
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      u.uLightPos.value[i].set(l.x, l.y, l.z);
      u.uLightColor.value[i].setRGB(l.col[0], l.col[1], l.col[2]);
      u.uLightPower.value[i] = l.lum * l.seg * gain;
    }
    u.uLightCount.value = n;
  }

  render(camera, time) {
    const u = this.material.uniforms;
    u.uCameraPos.value.copy(camera.position);
    u.uInvProjView.value
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    u.uTime.value = time;

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.blitMaterial.dispose();
  }
}
