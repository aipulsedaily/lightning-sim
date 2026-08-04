/**
 * post.js — HDR bloom and tone mapping.
 *
 * Lightning is the one subject where bloom is not a stylistic flourish
 * but the physically honest choice. A return-stroke channel is roughly
 * ten orders of magnitude brighter than the cloud around it. No display
 * can show that, and no camera or eye sees it cleanly either: the light
 * scatters inside the lens or the vitreous humour and spreads into a
 * halo. That halo is why lightning looks the way it does in every
 * photograph ever taken of it, and leaving it out makes a physically
 * correct channel look like a thin wire.
 *
 * The blur is a dual-filter (Kawase) pyramid: downsample with a 13-tap
 * kernel, upsample with a 9-tap tent, add at every level. It gives a very
 * wide, very smooth falloff for a handful of small passes, which is what
 * a glare kernel needs. Tone mapping is the ACES filmic approximation,
 * which holds highlight colour instead of clipping everything bright to
 * white.
 */

import * as THREE from 'three';

const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DOWN_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  uniform int uFirst;

  vec3 prefilter(vec3 c) {
    if (uFirst == 0) return c;
    // Soft knee: fade brightness in around the threshold instead of
    // cutting at it, so a channel dimming through the threshold does not
    // pop its halo off.
    float b = max(c.r, max(c.g, c.b));
    float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-5);
    float contrib = max(soft, b - uThreshold) / max(b, 1e-5);
    return c * contrib;
  }

  void main() {
    vec2 t = uTexel;
    vec3 a = texture2D(uTex, vUv + t * vec2(-1.0,  1.0)).rgb;
    vec3 b = texture2D(uTex, vUv + t * vec2( 0.0,  1.0)).rgb;
    vec3 c = texture2D(uTex, vUv + t * vec2( 1.0,  1.0)).rgb;
    vec3 d = texture2D(uTex, vUv + t * vec2(-0.5,  0.5)).rgb;
    vec3 e = texture2D(uTex, vUv + t * vec2( 0.5,  0.5)).rgb;
    vec3 f = texture2D(uTex, vUv + t * vec2(-1.0,  0.0)).rgb;
    vec3 g = texture2D(uTex, vUv).rgb;
    vec3 h = texture2D(uTex, vUv + t * vec2( 1.0,  0.0)).rgb;
    vec3 i = texture2D(uTex, vUv + t * vec2(-0.5, -0.5)).rgb;
    vec3 j = texture2D(uTex, vUv + t * vec2( 0.5, -0.5)).rgb;
    vec3 k = texture2D(uTex, vUv + t * vec2(-1.0, -1.0)).rgb;
    vec3 l = texture2D(uTex, vUv + t * vec2( 0.0, -1.0)).rgb;
    vec3 m = texture2D(uTex, vUv + t * vec2( 1.0, -1.0)).rgb;

    vec3 o = (d + e + i + j) * 0.125;
    o += (a + b + g + f) * 0.03125;
    o += (b + c + h + g) * 0.03125;
    o += (f + g + l + k) * 0.03125;
    o += (g + h + m + l) * 0.03125;
    gl_FragColor = vec4(prefilter(o), 1.0);
  }
`;

const UP_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2 uTexel;
  uniform float uRadius;

  void main() {
    vec2 t = uTexel * uRadius;
    vec3 s = texture2D(uTex, vUv + vec2(-t.x,  t.y)).rgb;
    s += texture2D(uTex, vUv + vec2( 0.0,  t.y)).rgb * 2.0;
    s += texture2D(uTex, vUv + vec2( t.x,  t.y)).rgb;
    s += texture2D(uTex, vUv + vec2(-t.x,  0.0)).rgb * 2.0;
    s += texture2D(uTex, vUv).rgb * 4.0;
    s += texture2D(uTex, vUv + vec2( t.x,  0.0)).rgb * 2.0;
    s += texture2D(uTex, vUv + vec2(-t.x, -t.y)).rgb;
    s += texture2D(uTex, vUv + vec2( 0.0, -t.y)).rgb * 2.0;
    s += texture2D(uTex, vUv + vec2( t.x, -t.y)).rgb;
    gl_FragColor = vec4(s * (1.0 / 16.0), 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uBloomStrength;
  uniform float uExposure;
  uniform float uVignette;
  uniform vec2 uResolution;
  uniform float uGrain;
  uniform float uTime;

  // ACES filmic curve (Narkowicz fit). Keeps highlight hue instead of
  // driving every bright pixel to pure white.
  vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 scene = texture2D(uScene, vUv).rgb;
    vec3 bloom = texture2D(uBloom, vUv).rgb;
    vec3 col = scene + bloom * uBloomStrength;
    col *= uExposure;
    col = aces(col);

    vec2 d = vUv - 0.5;
    col *= 1.0 - uVignette * dot(d, d) * 1.6;

    // A little grain, dithered against banding in the very dark sky.
    float n = hash(vUv * uResolution + uTime) - 0.5;
    col += n * uGrain;

    // Linear -> sRGB
    col = max(col, vec3(0.0));
    col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055,
      step(0.0031308, col));
    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeRT(w, h) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

export class PostPipeline {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.levels = opts.levels ?? 6;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.sceneTarget = null;
    this.chain = [];

    this.downMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: DOWN_FRAG,
      uniforms: {
        uTex: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: opts.threshold ?? 0.75 },
        uKnee: { value: opts.knee ?? 0.5 },
        uFirst: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: UP_FRAG,
      uniforms: {
        uTex: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: opts.radius ?? 1.0 },
      },
      depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        uScene: { value: null },
        uBloom: { value: null },
        uBloomStrength: { value: opts.strength ?? 0.85 },
        uExposure: { value: opts.exposure ?? 1.0 },
        uVignette: { value: opts.vignette ?? 0.35 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uGrain: { value: opts.grain ?? 0.008 },
        uTime: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
  }

  setSize(width, height, pixelRatio = 1) {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    if (this.sceneTarget) this.sceneTarget.dispose();
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    for (const rt of this.chain) rt.dispose();
    this.chain = [];
    let cw = w, chh = h;
    for (let i = 0; i < this.levels; i++) {
      cw = Math.max(1, cw >> 1);
      chh = Math.max(1, chh >> 1);
      this.chain.push(makeRT(cw, chh));
      if (cw <= 2 || chh <= 2) break;
    }
    this.compositeMat.uniforms.uResolution.value.set(w, h);
    this.width = w; this.height = h;
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /** Run the bloom pyramid over sceneTarget and composite to the screen. */
  render(time = 0) {
    const r = this.renderer;
    const autoClear = r.autoClear;
    r.autoClear = true;

    // Downsample, thresholding only on the first hop.
    let src = this.sceneTarget.texture;
    let sw = this.width, sh = this.height;
    for (let i = 0; i < this.chain.length; i++) {
      this.downMat.uniforms.uTex.value = src;
      this.downMat.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      this._blit(this.downMat, this.chain[i]);
      src = this.chain[i].texture;
      sw = this.chain[i].width; sh = this.chain[i].height;
    }

    // Upsample, adding each level into the one above it.
    r.autoClear = false;
    for (let i = this.chain.length - 1; i > 0; i--) {
      const from = this.chain[i], to = this.chain[i - 1];
      this.upMat.uniforms.uTex.value = from.texture;
      this.upMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
      this._blit(this.upMat, to);
    }
    r.autoClear = autoClear;

    this.compositeMat.uniforms.uScene.value = this.sceneTarget.texture;
    this.compositeMat.uniforms.uBloom.value = this.chain[0].texture;
    this.compositeMat.uniforms.uTime.value = time;
    this._blit(this.compositeMat, null);
  }

  set exposure(v) { this.compositeMat.uniforms.uExposure.value = v; }
  get exposure() { return this.compositeMat.uniforms.uExposure.value; }
  set bloomStrength(v) { this.compositeMat.uniforms.uBloomStrength.value = v; }
  get bloomStrength() { return this.compositeMat.uniforms.uBloomStrength.value; }
  set threshold(v) { this.downMat.uniforms.uThreshold.value = v; }
  set radius(v) { this.upMat.uniforms.uRadius.value = v; }

  dispose() {
    this.sceneTarget?.dispose();
    for (const rt of this.chain) rt.dispose();
    this.downMat.dispose(); this.upMat.dispose(); this.compositeMat.dispose();
  }
}
