/**
 * environment.js — what lies outside the edge of the photograph.
 *
 * A reconstructed photograph is a shell covering only the solid angle the
 * lens saw. Turn the camera past it and there is nothing, which reads as a
 * bug however honestly it represents the missing information. Worse, it
 * makes the scene feel like a picture on a wall rather than a place, and
 * discourages exactly the exploration that shows off the geometry.
 *
 * So the whole sphere gets painted. Every ray is projected *back* through
 * the recovered camera model into image coordinates:
 *
 *   - inside the frame, the photograph itself;
 *   - just outside it, the edge of the photograph carried outwards and
 *     progressively softened;
 *   - far outside, a gradient built from the photograph's own average sky
 *     and ground colours, split at its own horizon.
 *
 * None of that is new information — it cannot be — but it is *consistent*
 * information, derived entirely from the image in hand, so the world stays
 * the same scene in every direction. It also fills the gaps the mesh tears
 * open at silhouettes, since it is drawn behind everything.
 */

import * as THREE from 'three';

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform mat4  uInvProjView;
  uniform vec3  uCameraPos;
  uniform sampler2D uPhoto;

  uniform float uT;            // tan(vfov/2) of the source photograph
  uniform float uAspect;       // photograph aspect
  uniform float uCosP;
  uniform float uSinP;         // its recovered pitch
  uniform float uHSweep;       // cylindrical horizontal sweep, radians
  uniform int   uCylindrical;

  uniform vec3  uSkyColor;
  uniform vec3  uGroundColor;
  uniform vec3  uTopColor;
  uniform vec3  uBottomColor;
  uniform float uHorizonRow;

  uniform float uFeather;      // how far outside the frame the photo carries
  uniform float uExposure;

  uniform int   uLightCount;
  uniform vec3  uLightPos[8];
  uniform vec3  uLightColor[8];
  uniform float uLightPower[8];
  uniform float uRelight;

  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  /* ---- structure for the part of the sphere the lens never saw ---- */

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.07 + vec3(3.1, 7.7, 1.3); a *= 0.5; }
    return v;
  }

  /**
   * Invert the camera model: world direction back to image coordinates.
   * The out parameter reports whether the ray is in front of the camera
   * at all; rays behind it have no image coordinate and must fall through
   * to the palette.
   */
  vec2 toImage(vec3 d, out bool ok) {
    ok = false;
    if (uCylindrical == 1) {
      float hxz = length(d.xz);
      if (hxz < 1e-6) return vec2(0.5);
      // Elevation on the cylinder wall, undoing the pitch.
      float q = d.y / hxz;
      float denom = uCosP + q * uSinP;
      if (abs(denom) < 1e-6) return vec2(0.5);
      float yEl = (q * uCosP - uSinP) / denom;
      float az = atan(d.x, -d.z);
      ok = true;
      return vec2(az / uHSweep + 0.5, 0.5 - yEl / (2.0 * uT));
    }
    // Rectilinear: undo the pitch, then divide through by depth.
    if (abs(d.z) < 1e-6) return vec2(0.5);
    float p = d.y / d.z;
    float den = p * uSinP - uCosP;
    if (abs(den) < 1e-6) return vec2(0.5);
    float y = (uSinP + p * uCosP) / den;
    float rz = y * uSinP - uCosP;
    if (rz > -1e-4) return vec2(0.5);      // behind the camera
    float x = (d.x / d.z) * rz;
    ok = true;
    return vec2(x / (uAspect * uT) * 0.5 + 0.5, (1.0 - y / uT) * 0.5);
  }

  void main() {
    vec4 near = uInvProjView * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec4 far  = uInvProjView * vec4(vUv * 2.0 - 1.0,  1.0, 1.0);
    vec3 rd = normalize(far.xyz / far.w - near.xyz / near.w);

    bool ok;
    vec2 uv = toImage(rd, ok);

    // The palette: the photograph's own sky and ground, split at its own
    // horizon and drifting towards the colours of its top and bottom
    // edges as the ray turns away.
    float elev = rd.y;
    float t = clamp(elev * 0.5 + 0.5, 0.0, 1.0);
    vec3 above = mix(uSkyColor, uTopColor, smoothstep(0.5, 1.0, t));
    vec3 below = mix(uGroundColor, uBottomColor, smoothstep(0.5, 0.0, t));

    // Flat colour is not a place. An average with no structure in it
    // reads as a rendering failure even though it is technically the most
    // honest thing available, so the fill is broken up with cloud-shaped
    // noise above the horizon and coarser texture below. It claims to be
    // nothing but a continuation of the same weather; what it buys is a
    // sphere with an up, a down and somewhere to look.
    vec3 q = rd / max(0.12, abs(rd.y) + 0.35);
    float cloud = fbm(q * 1.7);
    float ground = fbm(rd * 5.0);
    above *= 0.66 + 0.85 * smoothstep(0.25, 0.72, cloud);
    below *= 0.80 + 0.45 * ground;
    // Skies brighten towards the horizon and deepen towards the zenith.
    above *= mix(1.22, 0.72, smoothstep(0.0, 0.85, elev));

    vec3 palette = mix(below, above, smoothstep(-0.02, 0.05, elev));
    // A haze band right at the horizon, which is what makes the direction
    // legible when there is nothing else to go on.
    palette += mix(uSkyColor, uGroundColor, 0.5) * 0.35 *
      exp(-abs(elev) * 26.0);

    vec3 col = palette;
    if (ok) {
      // How far outside the frame is this, in frame widths?
      vec2 outside = max(vec2(0.0) - uv, uv - vec2(1.0));
      float d = max(outside.x, outside.y);
      float blend = 1.0 - smoothstep(0.0, uFeather, d);
      if (blend > 0.001) {
        vec3 photo = srgbToLinear(texture2D(uPhoto, clamp(uv, 0.001, 0.999)).rgb);
        col = mix(palette, photo, blend);
      }
    }

    // The flash lights the surroundings too, or the horizon behind you
    // stays stubbornly dark while everything in front of you blazes.
    vec3 response = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= uLightCount) break;
      vec3 dl = uLightPos[i] - uCameraPos;
      float r2 = dot(dl, dl);
      float facing = 0.45 + 0.55 * max(dot(rd, normalize(dl)), 0.0);
      response += uLightColor[i] * uLightPower[i] * facing / (r2 + 40000.0);
    }
    response *= uRelight;
    response = response / (1.0 + response * 0.30);

    gl_FragColor = vec4(col * (1.0 + response) * uExposure, 1.0);
  }
`;

const GROUND_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const GROUND_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;

  uniform vec3  uGroundColor;
  uniform vec3  uHorizonColor;
  uniform vec3  uCameraPos;
  uniform float uFade;         // distance over which it dissolves to horizon
  uniform float uExposure;

  uniform int   uLightCount;
  uniform vec3  uLightPos[8];
  uniform vec3  uLightColor[8];
  uniform float uLightPower[8];
  uniform float uRelight;

  float hash2(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y * 41.17);
  }
  float vnoise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1,0)), f.x),
               mix(hash2(i + vec2(0,1)), hash2(i + vec2(1,1)), f.x), f.y);
  }

  void main() {
    float d = length(vWorld.xz - uCameraPos.xz);
    float n = vnoise(vWorld.xz * 0.0035) * 0.55 + vnoise(vWorld.xz * 0.02) * 0.45;
    // Ground under a storm is darker than the frame average suggests: the
    // average includes whatever the sun was still reaching. Weighting it
    // down and giving the noise real contrast keeps the floor from
    // reading as a sheet of white card.
    vec3 col = uGroundColor * (0.34 + 0.62 * n);

    vec3 response = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= uLightCount) break;
      vec3 dl = uLightPos[i] - vWorld;
      float r2 = dot(dl, dl);
      response += uLightColor[i] * uLightPower[i] * max(normalize(dl).y, 0.0) / (r2 + 40000.0);
    }
    response *= uRelight;
    response = response / (1.0 + response * 0.30);
    col *= (1.0 + response);

    // Melt into the horizon haze with distance, so the plane has no edge.
    col = mix(col, uHorizonColor * 0.75, smoothstep(uFade * 0.15, uFade, d));
    gl_FragColor = vec4(col * uExposure, 1.0);
  }
`;

export class PhotoEnvironment {
  constructor(texture, camera, analysis, opts = {}) {
    const pal = analysis.palette || {
      sky: [0.2, 0.24, 0.32], ground: [0.1, 0.1, 0.09],
      top: [0.15, 0.2, 0.3], bottom: [0.08, 0.08, 0.07],
    };
    const toLinear = (c) => c.map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const col = (c) => new THREE.Color().fromArray(toLinear(c));

    const pos = [], lcol = [];
    for (let i = 0; i < 8; i++) { pos.push(new THREE.Vector3()); lcol.push(new THREE.Color()); }

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uInvProjView: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uPhoto: { value: texture },
        uT: { value: camera.T },
        uAspect: { value: camera.aspect },
        uCosP: { value: Math.cos(camera.pitch) },
        uSinP: { value: Math.sin(camera.pitch) },
        uHSweep: { value: (camera.hFovDeg * Math.PI) / 180 },
        uCylindrical: { value: camera.projection === 'cylindrical' ? 1 : 0 },
        uSkyColor: { value: col(pal.sky) },
        uGroundColor: { value: col(pal.ground) },
        uTopColor: { value: col(pal.top) },
        uBottomColor: { value: col(pal.bottom) },
        uHorizonRow: { value: camera.horizonRow },
        uFeather: { value: opts.feather ?? 0.22 },
        uExposure: { value: 1 },
        uLightCount: { value: 0 },
        uLightPos: { value: pos },
        uLightColor: { value: lcol },
        uLightPower: { value: new Float32Array(8) },
        uRelight: { value: opts.relight ?? 1 },
      },
    });

    this.object = new THREE.Group();

    const dome = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;          // behind absolutely everything
    this.object.add(dome);

    /**
     * A floor for the rest of the world.
     *
     * The reconstruction is a shell covering only the lens's field of
     * view, so seen from the side it is a wedge hanging in space with the
     * apex at the camera. Laying a real ground plane under everything,
     * painted with the photograph's own ground colour, gives the scene
     * somewhere to stand: the wedge becomes a textured patch of a
     * landscape that continues past it rather than a floating scrap.
     */
    this.groundMaterial = new THREE.ShaderMaterial({
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: {
        uGroundColor: { value: col(pal.ground) },
        uHorizonColor: {
          value: col(pal.ground.map((c, i) => (c + pal.sky[i]) * 0.5)),
        },
        uCameraPos: { value: new THREE.Vector3() },
        uFade: { value: opts.groundFade ?? 26000 },
        uExposure: { value: 1 },
        uLightCount: { value: 0 },
        uLightPos: { value: pos },
        uLightColor: { value: lcol },
        uLightPower: { value: new Float32Array(8) },
        uRelight: { value: opts.relight ?? 1 },
      },
    });
    const disc = new THREE.CircleGeometry(60000, 96);
    disc.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(disc, this.groundMaterial);
    this.ground.frustumCulled = false;
    this.ground.renderOrder = -999;    // above the dome, below everything else
    this.object.add(this.ground);
  }

  update(cam, lights, gain) {
    const u = this.material.uniforms;
    u.uCameraPos.value.copy(cam.position);
    u.uInvProjView.value
      .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      .invert();
    // The floor follows the viewer, so its far edge is never reachable.
    this.ground.position.set(cam.position.x, 0, cam.position.z);
    this.groundMaterial.uniforms.uCameraPos.value.copy(cam.position);

    const n = Math.min(8, lights.length);
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      u.uLightPos.value[i].set(l.x, l.y, l.z);
      u.uLightColor.value[i].setRGB(l.col[0], l.col[1], l.col[2]);
      u.uLightPower.value[i] = l.lum * l.seg * gain;
    }
    u.uLightCount.value = n;
    // The two materials share the light arrays by reference.
    this.groundMaterial.uniforms.uLightCount.value = n;
  }

  set relight(v) {
    this.material.uniforms.uRelight.value = v;
    this.groundMaterial.uniforms.uRelight.value = v;
  }
  set exposure(v) {
    this.material.uniforms.uExposure.value = v;
    this.groundMaterial.uniforms.uExposure.value = v;
  }

  dispose() {
    this.material.dispose();
    this.groundMaterial.dispose();
    this.object.traverse((o) => o.geometry?.dispose?.());
  }
}
