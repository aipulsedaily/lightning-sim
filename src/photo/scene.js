/**
 * scene.js — the photograph, standing up in the world, lit by the bolt.
 *
 * Once the image is a surface, two things have to happen for lightning to
 * belong in it rather than sit on top of it.
 *
 * OCCLUSION comes free. The reconstruction is real geometry with real
 * depth, and the channel is drawn depth-tested, so a bolt behind a cloud
 * bank is behind it, and one in front of a headland crosses in front.
 * That single fact does most of the work of making a composite believable.
 *
 * RELIGHTING does not come free. The photograph already contains the light
 * that was falling when it was taken, baked into every pixel. The pixels
 * are therefore treated as albedo — what the surface would reflect — and
 * the flash is *added* on top:
 *
 *     out = photo * (1 + response * strength)
 *
 * which returns the photograph untouched between strokes and lifts it as
 * the channel brightens. Sky and ground respond differently, because they
 * are different things: a cloud scatters light almost regardless of which
 * way it faces, while a hillside obeys a cosine law and half of it stays
 * dark. The sky mask from the analysis stage is what blends between them.
 */

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute float aSky;
  attribute float aDepth;
  attribute float aEdge;

  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSky;
  varying float vDepth;
  varying float vEdge;

  void main() {
    vUv = uv;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vSky = aSky;
    vDepth = aDepth;
    vEdge = aEdge;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSky;
  varying float vDepth;
  varying float vEdge;

  uniform sampler2D uPhoto;
  uniform vec3  uCameraPos;

  uniform int   uLightCount;
  uniform vec3  uLightPos[8];
  uniform vec3  uLightColor[8];
  uniform float uLightPower[8];

  uniform float uRelight;      // how hard the flash hits the photograph
  uniform float uAmbient;      // baseline multiplier on the photo itself
  uniform float uExposure;
  uniform float uSkyGlow;      // extra scattering response for cloud
  uniform float uDebug;        // 0 photo, 1 depth, 2 sky mask, 3 normals

  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  void main() {
    vec3 albedo = srgbToLinear(texture2D(uPhoto, vUv).rgb);
    vec3 n = normalize(vNormal);
    vec3 v = normalize(uCameraPos - vWorld);
    // The reconstruction can hand back normals facing away from the
    // camera on near-edge-on geometry; the photograph was taken of the
    // front of these surfaces, so flip rather than let them go black.
    if (dot(n, v) < 0.0) n = -n;

    vec3 response = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= uLightCount) break;
      vec3 d = uLightPos[i] - vWorld;
      float r2 = dot(d, d);
      vec3 l = d * inversesqrt(max(r2, 1.0));
      float lambert = max(dot(n, l), 0.0);
      // Cloud scatters nearly isotropically; solid surfaces do not.
      float cloud = uSkyGlow * (0.55 + 0.45 * lambert);
      float shape = mix(lambert, cloud, vSky);
      response += uLightColor[i] * uLightPower[i] * shape / (r2 + 20000.0);
    }

    // Soft knee on the flash contribution.
    //
    // Illumination falls off as 1/r^2, so a channel a few hundred metres
    // from a cloud face delivers hundreds of times what the same channel
    // delivers a few kilometres away. Applied literally that is a white
    // blob near the strike and nothing elsewhere. Compressing the response
    // lets the flash be genuinely strong across the whole scene while the
    // near field rolls off into saturation instead of exploding through
    // it — which is what a camera does too.
    response *= uRelight;
    response = response / (1.0 + response * 0.30);

    vec3 col = albedo * (uAmbient + response);

    if (uDebug > 0.5) {
      if (uDebug < 1.5) {
        float t = clamp(log2(vDepth / 5.0) / 12.0, 0.0, 1.0);
        col = vec3(t, 1.0 - abs(t - 0.5) * 2.0, 1.0 - t) * 0.6;
      } else if (uDebug < 2.5) {
        col = mix(vec3(0.05, 0.02, 0.0), vec3(0.1, 0.35, 0.8), vSky);
      } else {
        col = n * 0.5 + 0.5;
      }
    }

    // Dissolve the outer border into whatever is behind it, so the
    // reconstruction stops being a hard-edged wedge cut out of the world.
    float alpha = smoothstep(0.0, 1.0, vEdge);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(col * uExposure, alpha);
  }
`;

export class PhotoScene {
  /**
   * @param {object} mesh      output of reconstruct()
   * @param {ImageBitmap} bitmap
   * @param {object} camera    from makeCameraModel()
   */
  constructor(mesh, bitmap, camera, opts = {}) {
    this.camera = camera;
    this.mesh3 = null;
    this.info = opts.info || {};

    // One set of vertices, two index buffers. The attributes are shared,
    // so this costs nothing beyond a second small index array.
    const attrs = {
      position: new THREE.BufferAttribute(mesh.positions, 3),
      normal: new THREE.BufferAttribute(mesh.normals, 3),
      uv: new THREE.BufferAttribute(mesh.uvs, 2),
      aSky: new THREE.BufferAttribute(mesh.sky, 1),
      aDepth: new THREE.BufferAttribute(mesh.depth, 1),
      aEdge: new THREE.BufferAttribute(
        mesh.edge || new Float32Array(mesh.positions.length / 3).fill(1), 1),
    };
    const makeGeometry = (index) => {
      const g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, a);
      g.setIndex(new THREE.BufferAttribute(index, 1));
      g.computeBoundingSphere();
      return g;
    };
    const geo = makeGeometry(mesh.indexGround ?? mesh.index);
    const geoSky = mesh.indexSky && mesh.indexSky.length ? makeGeometry(mesh.indexSky) : null;

    this.texture = new THREE.Texture(bitmap);
    this.texture.needsUpdate = true;
    this.texture.colorSpace = THREE.NoColorSpace;   // converted in the shader
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.anisotropy = opts.anisotropy ?? 8;

    const pos = [], col = [];
    for (let i = 0; i < 8; i++) { pos.push(new THREE.Vector3()); col.push(new THREE.Color()); }

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: {
        uPhoto: { value: this.texture },
        uCameraPos: { value: new THREE.Vector3() },
        uLightCount: { value: 0 },
        uLightPos: { value: pos },
        uLightColor: { value: col },
        uLightPower: { value: new Float32Array(8) },
        uRelight: { value: opts.relight ?? 1.0 },
        uAmbient: { value: opts.ambient ?? 1.0 },
        uExposure: { value: 1.0 },
        uSkyGlow: { value: opts.skyGlow ?? 1.5 },
        uDebug: { value: 0 },
      },
    });

    // The sky draws first and, by default, writes no depth — so it acts
    // as a backdrop the discharge appears in front of. The ground draws
    // after it with depth on, and goes on occluding the channel.
    this.skyMaterial = this.material.clone();
    this.skyMaterial.uniforms = this.material.uniforms;   // share, do not copy
    this.skyMaterial.depthWrite = false;

    this.object = new THREE.Group();
    this.groundMesh = new THREE.Mesh(geo, this.material);
    this.groundMesh.frustumCulled = false;
    this.groundMesh.renderOrder = -5;
    this.object.add(this.groundMesh);

    if (geoSky) {
      this.skyMesh = new THREE.Mesh(geoSky, this.skyMaterial);
      this.skyMesh.frustumCulled = false;
      this.skyMesh.renderOrder = -6;
      this.object.add(this.skyMesh);
    }

    this.geometry = geo;
    this.geometrySky = geoSky;
    this.stats = mesh;
  }

  /**
   * Whether the photograph's sky is allowed to hide the discharge.
   * True is physically honest and usually means seeing only a glow; false
   * treats the sky as the backdrop it visually is.
   */
  set skyOccludes(on) {
    this.skyMaterial.depthWrite = !!on;
  }

  /**
   * Stand exactly where the photograph was taken from.
   *
   * With the recovered pitch and field of view, the reconstruction
   * reprojects onto the original image pixel for pixel — which is the
   * whole point of moving vertices along their own rays. The controls are
   * switched to look mode, because from here turning the head is the
   * sensible gesture and orbiting only walks you into the geometry's
   * blind spots.
   */
  /**
   * Vertical field of view at which the photograph *covers* a viewport of
   * the given aspect.
   *
   * The window is rarely the shape of the picture. When it is wider, a
   * camera set to the photograph's own vertical field of view sees past
   * the left and right edges into the overscan, where there is nothing
   * but the outermost column of pixels smeared outwards — and smeared
   * pixels are exactly what the eye picks out. Narrowing the view until
   * the frame is full of real image crops a little off the top and bottom
   * instead, which nobody notices.
   */
  coverFov(viewportAspect) {
    const vHalf = (this.camera.fovDeg * Math.PI) / 360;
    const t = Math.tan(vHalf);
    const byWidth = Math.atan((t * this.camera.aspect) / Math.max(0.01, viewportAspect));
    return (Math.min(vHalf, byWidth) * 360) / Math.PI;
  }

  applyHomeView(cam, controls, viewportAspect) {
    const c = this.camera;
    cam.fov = viewportAspect ? this.coverFov(viewportAspect) : c.fovDeg;
    cam.updateProjectionMatrix();
    const eye = new THREE.Vector3(0, c.height, 0);
    const dist = 1200;
    const target = new THREE.Vector3(0, c.height + Math.tan(c.pitch) * dist, -dist);

    cam.position.copy(eye);
    cam.lookAt(target);
    cam.updateMatrixWorld();

    if (controls) {
      controls.target.copy(target);
      controls.goalTarget.copy(target);
      controls.anchor.copy(eye);
      controls.setLookMode(true, eye);
      // Zooming out is fine now: past the edge of the photograph there is
      // an environment built from its own colours, not a void.
      controls.maxFov = Math.min(110, cam.fov * 2.4);
      controls.minFov = Math.max(8, cam.fov * 0.25);
    }
  }

  update(cam, lights, gain) {
    const u = this.material.uniforms;
    u.uCameraPos.value.copy(cam.position);
    const n = Math.min(8, lights.length);
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      u.uLightPos.value[i].set(l.x, l.y, l.z);
      u.uLightColor.value[i].setRGB(l.col[0], l.col[1], l.col[2]);
      u.uLightPower.value[i] = l.lum * l.seg * gain;
    }
    u.uLightCount.value = n;
  }

  set relight(v) { this.material.uniforms.uRelight.value = v; }
  set ambient(v) { this.material.uniforms.uAmbient.value = v; }
  set exposure(v) { this.material.uniforms.uExposure.value = v; }
  set skyGlow(v) { this.material.uniforms.uSkyGlow.value = v; }
  set debug(v) { this.material.uniforms.uDebug.value = v; }

  /**
   * Where on the reconstructed ground does a screen click land?
   *
   * Raycasting the mesh gives the actual point the user pointed at,
   * including a cloud; dropping it to y = 0 puts the storm underneath
   * whatever they clicked, which is the useful interpretation.
   */
  pick(ndc, cam, raycaster) {
    raycaster.setFromCamera(ndc, cam);
    const hits = raycaster.intersectObject(this.object, true);
    if (!hits.length) {
      // Missed the geometry: fall back to the mathematical ground plane.
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      if (d.y >= -1e-6) return null;
      const t = -o.y / d.y;
      if (t < 0 || t > 1e6) return null;
      return { x: o.x + d.x * t, y: o.z + d.z * t, distance: t, onGround: true };
    }
    const p = hits[0].point;
    // Simulation coordinates are z-up: world (x, y, z) -> sim (x, z, y).
    return { x: p.x, y: p.z, distance: hits[0].distance, onGround: false, world: p };
  }

  dispose() {
    this.geometry.dispose();
    this.geometrySky?.dispose();
    this.material.dispose();
    this.skyMaterial.dispose();
    this.texture.dispose();
  }
}

/**
 * The whole pipeline, in order, with progress reported so a 20 MB model
 * download does not look like a hang.
 */
export async function buildPhotoScene(source, opts = {}) {
  const { loadImage, sampleImage, analyze, makeCameraModel, guessProjection } =
    await import('./analyze.js');
  const {
    geometricDepth, neuralDisparity, fitDisparityToMetres, blendDepth, DEPTH_DEFAULTS,
  } = await import('./depth.js');
  const { reconstruct, describe } = await import('./reconstruct.js');

  const report = opts.onProgress || (() => { });

  // Decoding, analysis and above all neural inference are expensive and do
  // not depend on the calibration controls. Reusing them means dragging
  // the horizon slider rebuilds the mesh in milliseconds instead of
  // re-running a 20 MB model.
  const cache = opts.cache || {};

  let bitmap = cache.bitmap;
  if (!bitmap) {
    report({ phase: 'decode' });
    bitmap = await loadImage(source, opts.maxTextureSide ?? 4096);
  }

  let analysis = cache.analysis;
  if (!analysis) {
    report({ phase: 'analyze' });
    analysis = analyze(sampleImage(bitmap, opts.analysisWidth ?? 320));
  }

  const projection = opts.projection === 'auto' || !opts.projection
    ? guessProjection(analysis.aspect)
    : opts.projection;

  const camera = makeCameraModel({
    fovDeg: opts.fovDeg ?? 55,
    horizonRow: opts.horizonRow ?? analysis.horizonRow,
    height: opts.cameraHeight ?? DEPTH_DEFAULTS.cameraHeight,
    aspect: analysis.aspect,
    projection,
    hFovDeg: opts.hFovDeg ?? null,
  });

  report({ phase: 'geometry' });
  const geo = geometricDepth(analysis, camera, opts);

  let depth = geo;
  let neural = null;
  let disparity = cache.disparity || null;
  if (opts.useNeural) {
    try {
      if (!disparity) disparity = await neuralDisparity(bitmap, analysis, report);
      // The fit is redone every rebuild, because it is anchored to the
      // geometry and the geometry is what the sliders change.
      const fit = fitDisparityToMetres(disparity, geo, analysis, opts);
      neural = fit;
      depth = fit.ok
        ? blendDepth(fit.depth, geo, analysis,
          opts.neuralStrength ?? 1, opts.neuralSkyBias ?? 0.65,
          opts.neuralNearLimit ?? 600)
        : geo;
    } catch (e) {
      // Falling back to geometry is fine, but doing it quietly is not:
      // the user asked for the model and is owed an explanation.
      const message = String(e?.message || e);
      report({ phase: 'error', message });
      neural = { ok: false, error: message };
      depth = geo;
      disparity = null;
    }
  }

  report({ phase: 'mesh' });
  const mesh = reconstruct({
    analysis, camera, depth,
    gridWidth: opts.gridWidth ?? 340,
    tearRatio: opts.tearRatio ?? 2.2,
    maxRange: opts.maxRange ?? DEPTH_DEFAULTS.maxRange,
    vertexBudget: opts.vertexBudget,
  });

  const { PhotoEnvironment } = await import('./environment.js');
  const scene = new PhotoScene(mesh, bitmap, camera, {
    ...opts,
    info: {
      ...describe(mesh, depth, analysis),
      projection,
      horizonRow: camera.horizonRow,
      horizonConfidence: analysis.horizonConfidence,
      neural: neural
        ? { ok: neural.ok, error: neural.error || neural.reason, diag: neural.diag }
        : null,
      imageSize: [bitmap.sourceWidth ?? bitmap.width, bitmap.sourceHeight ?? bitmap.height],
      textureSize: [bitmap.width, bitmap.height],
    },
  });
  const environment = new PhotoEnvironment(scene.texture, camera, analysis, opts);

  report({ phase: 'done' });
  return {
    scene, environment, analysis, camera, depth, mesh, bitmap,
    // Hand the expensive stages back so the next rebuild can skip them.
    cache: { bitmap, analysis, disparity },
  };
}
