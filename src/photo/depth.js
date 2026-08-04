/**
 * depth.js — assigning a distance to every pixel.
 *
 * A photograph has no depth in it. Something has to be assumed, and the
 * assumption that matters here is not "which pixel is nearer" but "how
 * many metres away is it", because the thing being placed in the scene is
 * five kilometres tall. Ordering alone is useless at that scale.
 *
 * Two providers, and they are not alternatives:
 *
 *   GEOMETRIC. Every pixel is a ray. Rays below the horizon meet the
 *   ground plane; rays above it meet the cloud deck. Both intersections
 *   are exact given the camera height and the cloud base, so the result
 *   is in metres by construction. For a photograph of sky and open ground
 *   — which is the kind of photograph anyone wants lightning in — this is
 *   not an approximation of the geometry, it *is* the geometry.
 *
 *   NEURAL. Depth Anything V2 gives far better relief on terrain,
 *   buildings and trees, but like every affine-invariant depth model it
 *   returns disparity with unknown scale and offset. It cannot tell you
 *   metres. So it is fitted *to* the geometric solution: solve for the
 *   two constants that map its disparity onto the ground plane and cloud
 *   deck the geometry already established. This is the standard way to
 *   metrically scale a monocular model, and it is why the geometric stage
 *   stays in the pipeline even when the network is doing the work.
 *
 * The output either way is one number per pixel: metres along the ray.
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const DEPTH_DEFAULTS = {
  cameraHeight: 5,        // m above the ground plane
  cloudBase: 1600,        // m, matches the simulation's storm base
  maxRange: 30000,        // m, where everything at the horizon piles up
  minRange: 6,            // m, nothing is closer than this
  skyRelief: 0.16,        // luminance -> depth, above the horizon
  groundRelief: 0.05,     // luminance -> depth, below it
};

/**
 * Distance along a ray to the two-plane world.
 *
 * The soft clamp is the important detail. A ray a hair above the horizon
 * meets the cloud deck at genuine infinity, and a hard cut-off there
 * leaves a visible crease across the image. Combining the two
 * reciprocally,
 *
 *     1/t = 1/t_plane + 1/maxRange,
 *
 * approaches maxRange smoothly instead, so the far field folds into a
 * curtain at the horizon with no seam — which is also, conveniently,
 * where distant hills and skylines belong.
 */
export function planeDepth(dirY, height, cloudBase, maxRange) {
  let t;
  if (dirY > 1e-6) t = (cloudBase - height) / dirY;         // up to the cloud deck
  else if (dirY < -1e-6) t = height / -dirY;                // down to the ground
  else t = Infinity;                                        // dead level
  if (!(t > 0)) t = Infinity;
  // A ray exactly on the horizon never meets either plane. It belongs at
  // the clamp distance, and the reciprocal blend below would otherwise
  // evaluate infinity over infinity.
  if (!Number.isFinite(t)) return maxRange;
  return (t * maxRange) / (t + maxRange);
}

/**
 * Geometric depth field over the analysis grid.
 *
 * Relief is applied *along the ray*, never across it. Moving a vertex
 * along its own ray cannot change where it lands in the image, so the
 * photograph reprojects exactly from the original viewpoint no matter how
 * much relief is dialled in. Displacing vertically would look similar and
 * would quietly break that.
 */
export function geometricDepth(analysis, camera, opts = {}) {
  const P = { ...DEPTH_DEFAULTS, ...opts };
  const { w, h, luma, sky, meanLuma } = analysis;
  const depth = new Float32Array(w * h);
  const dir = { x: 0, y: 0, z: 0 };

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      camera.ray((x + 0.5) / w, v, dir);
      let t = planeDepth(dir.y, P.cameraHeight, P.cloudBase, P.maxRange);

      // Brighter is nearer: a sunlit cloud tower bulges towards the
      // viewer, a lit slope faces them. It is a weak cue and it is scaled
      // like one, but it is the only relief available without a network.
      const s = sky[i];
      const amp = P.skyRelief * s + P.groundRelief * (1 - s);
      // Clamped so a relief setting turned up hard cannot push a vertex
      // through the camera and out the other side.
      t *= clamp(1 - amp * (luma[i] - meanLuma) * 2, 0.2, 3);

      depth[i] = clamp(t, P.minRange, P.maxRange);
    }
  }
  return depth;
}

/* ================================================================== *
 * Neural depth
 * ================================================================== */

const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';

let _pipelinePromise = null;

/**
 * Load Depth Anything V2 Small, lazily and once.
 *
 * Nothing here is fetched unless the user actually asks for neural depth,
 * so the simulator keeps working with no network at all. The q4f16 build
 * is about 18 MB and the browser caches it after the first use. WebGPU if
 * the browser has it, WASM otherwise — the model is small enough that the
 * fallback is slow rather than useless.
 */
/**
 * What this machine can actually run.
 *
 * The smallest build of the model is 4-bit weights with 16-bit compute,
 * and plenty of real hardware — and every software renderer — has WebGPU
 * without the `shader-f16` feature. Asking for it there does not degrade
 * gracefully; session creation fails outright with a shader compilation
 * error. So capability is probed before anything is downloaded, rather
 * than discovered after 18 MB has already gone over the wire.
 */
async function probeBackends() {
  const out = [];
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        if (adapter.features?.has?.('shader-f16')) {
          out.push({ device: 'webgpu', dtype: 'q4f16', size: 18 });
        }
        out.push({ device: 'webgpu', dtype: 'q4', size: 27 });
      }
    } catch { /* no adapter; fall through to CPU */ }
  }
  out.push({ device: 'wasm', dtype: 'q4', size: 27 });
  out.push({ device: 'wasm', dtype: 'q8', size: 27 });
  return out;
}

export function loadDepthModel(onProgress) {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    const mod = await import(/* @vite-ignore */ TRANSFORMERS_CDN);
    const { pipeline, env } = mod;
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const progress_callback = (p) => {
      if (!onProgress) return;
      if (p.status === 'progress' && p.total) {
        onProgress({
          phase: 'download',
          file: p.file,
          loaded: p.loaded,
          total: p.total,
          fraction: p.loaded / p.total,
        });
      } else {
        onProgress({ phase: p.status, file: p.file });
      }
    };

    const backends = await probeBackends();
    let lastError = null;
    for (const b of backends) {
      try {
        onProgress?.({ phase: 'backend', device: b.device, dtype: b.dtype, size: b.size });
        return await pipeline('depth-estimation', DEPTH_MODEL, {
          device: b.device, dtype: b.dtype, progress_callback,
        });
      } catch (e) {
        lastError = e;
        onProgress?.({
          phase: 'fallback',
          message: `${b.device}/${b.dtype} refused it (${String(e.message || e).slice(0, 90)})`,
        });
      }
    }
    throw lastError || new Error('no usable backend for the depth model');
  })().catch((e) => { _pipelinePromise = null; throw e; });
  return _pipelinePromise;
}

export function isDepthModelLoaded() {
  return _pipelinePromise !== null;
}

/**
 * Run the model and resample its output onto the analysis grid.
 *
 * Depth Anything emits disparity — large where things are near — so the
 * numbers coming back are the reciprocal-ish of what we want, and are
 * only defined up to an affine transform. Fitting that transform is the
 * next function's job.
 */
export async function neuralDisparity(bitmap, analysis, onProgress) {
  const estimator = await loadDepthModel(onProgress);
  onProgress?.({ phase: 'infer' });

  // transformers.js takes a RawImage, a URL or a canvas-ish source.
  const canvas = document.createElement('canvas');
  const maxSide = 700;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const result = await estimator(canvas.toDataURL('image/png'));
  const raw = result.predicted_depth ?? result.depth;
  const dims = raw.dims ?? [raw.height, raw.width];
  const dh = dims[dims.length - 2], dw = dims[dims.length - 1];
  const src = raw.data;

  // Bilinear resample onto the analysis grid.
  const { w, h } = analysis;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = ((y + 0.5) / h) * dh - 0.5;
    const y0 = Math.max(0, Math.min(dh - 1, Math.floor(sy)));
    const y1 = Math.min(dh - 1, y0 + 1);
    const fy = clamp(sy - y0, 0, 1);
    for (let x = 0; x < w; x++) {
      const sx = ((x + 0.5) / w) * dw - 0.5;
      const x0 = Math.max(0, Math.min(dw - 1, Math.floor(sx)));
      const x1 = Math.min(dw - 1, x0 + 1);
      const fx = clamp(sx - x0, 0, 1);
      const a = src[y0 * dw + x0], b = src[y0 * dw + x1];
      const c = src[y1 * dw + x0], d = src[y1 * dw + x1];
      out[y * w + x] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    }
  }
  return out;
}

/**
 * Put the network's disparity into metres by fitting it to the geometry.
 *
 * The model is affine-invariant in disparity, so there exist constants
 * a and b with
 *
 *     1 / depth_metres  =  a * disparity + b,
 *
 * and both can be recovered by least squares against the geometric
 * solution, whose inverse depth is known exactly. Two rounds of
 * reweighting throw out the pixels where the two disagree wildly — the
 * places the plane model was never going to describe, like a tree in the
 * foreground — so the fit is set by the parts of the image the geometry
 * actually governs.
 *
 * The result keeps the network's relief and the geometry's scale.
 */
export function fitDisparityToMetres(disparity, geometric, analysis, opts = {}) {
  const P = { ...DEPTH_DEFAULTS, ...opts };
  const n = disparity.length;
  const invGeo = new Float32Array(n);
  const weight = new Float32Array(n);

  // Fit only where the network has something to say.
  //
  // An affine-invariant depth model has no resolution past a hundred
  // metres or so: everything further simply saturates at zero disparity.
  // On a photograph of a bay, that is the sea, the far shore, the
  // mountain and the whole sky — the great majority of the frame. Fitting
  // across all of it forces the curve through a huge cloud of points that
  // all claim "infinity", which pins the offset and collapses the entire
  // scene into a few hundred metres.
  //
  // So the fit is anchored on the near field, where the model is
  // informative and the plane geometry is also reliable, and the far
  // field is left to the geometry that can actually measure it.
  const { h, w, sky } = analysis;
  let dMax = 0;
  for (let i = 0; i < disparity.length; i++) if (disparity[i] > dMax) dMax = disparity[i];
  const dFloor = dMax * (P.neuralDisparityFloor ?? 0.06);
  const nearLimit = P.neuralNearLimit ?? 600;

  let usable = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      invGeo[i] = 1 / Math.max(P.minRange, geometric[i]);
      const t = geometric[i];
      const informative = disparity[i] > dFloor ? 1 : 0;
      const near = t < nearLimit ? 1 : (t < nearLimit * 3 ? 0.25 : 0);
      // Sky and ground are both usable; mixed pixels less so.
      const decisive = Math.abs(sky[i] - 0.5) * 2;
      weight[i] = informative * near * (0.35 + 0.65 * decisive);
      if (weight[i] > 0) usable++;
    }
  }

  // Too little near-field to anchor anything: say so rather than invent a scale.
  if (usable < 0.01 * disparity.length) {
    return {
      depth: geometric.slice(), a: 0, b: 0, ok: false,
      reason: 'nothing close enough in the frame for the model to calibrate against',
    };
  }

  let a = 0, b = 0, solved = false;
  for (let pass = 0; pass < 3; pass++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const wt = weight[i];
      if (wt <= 0) continue;
      const d = disparity[i], g = invGeo[i];
      sw += wt; sx += wt * d; sy += wt * g;
      sxx += wt * d * d; sxy += wt * d * g;
    }
    // The normal equations are only conditioned if the disparity map
    // actually varies. A flat one - a model that failed, or an image it
    // had nothing to say about - leaves the scale unidentifiable, and
    // guessing is worse than declining.
    const det = sw * sxx - sx * sx;
    const spread = sxx / Math.max(sw, 1e-30) - (sx / Math.max(sw, 1e-30)) ** 2;
    if (!(det > 1e-20) || !(spread > 1e-12)) break;
    a = (sw * sxy - sx * sy) / det;
    b = (sxx * sy - sx * sxy) / det;
    solved = true;

    // Reweight against the residual, so a handful of wild pixels cannot
    // drag the scale of the whole scene.
    let mad = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (weight[i] <= 0) continue;
      mad += Math.abs(a * disparity[i] + b - invGeo[i]); cnt++;
    }
    mad = mad / Math.max(1, cnt) + 1e-9;
    for (let i = 0; i < n; i++) {
      const r = Math.abs(a * disparity[i] + b - invGeo[i]) / (2.5 * mad);
      weight[i] *= 1 / (1 + r * r);
    }
  }

  // If the fit came out degenerate (a flat or inverted disparity map),
  // there is nothing to gain from it — hand back the geometry unchanged
  // rather than a scene turned inside out.
  // Diagnostics, because "the model did not help" and "the model never ran"
  // look identical from the outside and need different fixes.
  let dLo = Infinity, dHi = -Infinity, dMean = 0;
  for (let i = 0; i < n; i++) {
    const d = disparity[i];
    if (d < dLo) dLo = d;
    if (d > dHi) dHi = d;
    dMean += d;
  }
  dMean /= n;
  const diag = {
    disparity: { lo: dLo, hi: dHi, mean: dMean },
    a, b, solved,
  };

  if (!solved || !Number.isFinite(a) || !Number.isFinite(b) || a <= 0) {
    return {
      depth: geometric.slice(), a: 0, b: 0, ok: false, diag,
      reason: !solved ? 'the disparity map carried no usable variation'
        : a <= 0 ? 'the model disagreed with the geometry about which way is far'
          : 'the fit did not converge',
    };
  }

  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inv = a * disparity[i] + b;
    depth[i] = inv > 1 / P.maxRange
      ? clamp(1 / inv, P.minRange, P.maxRange)
      : P.maxRange;
  }
  return { depth, a, b, ok: true, diag };
}

/**
 * Blend the neural relief back towards the geometric solution.
 *
 * At 1 the network wins everywhere. Below that the plane model reasserts
 * itself, which is usually what you want for the sky: Depth Anything was
 * trained on scenes with things in them and has little to say about a
 * cloud deck, whereas the geometry is exact there.
 */
export function blendDepth(neural, geometric, analysis, strength, skyBias = 0.65,
  nearLimit = 600) {
  const n = neural.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // The network owns the near field, the geometry owns the distance,
    // and the handover is smooth. Beyond a few hundred metres the model
    // is saturated and contributes nothing but noise, so it is faded out
    // by the geometric distance rather than by its own estimate — which
    // is the whole point, since its estimate is the thing in doubt.
    const t = geometric[i];
    const nearness = t <= nearLimit ? 1
      : t >= nearLimit * 4 ? 0
        : 1 - (t - nearLimit) / (nearLimit * 3);
    const k = clamp(strength * nearness * (1 - skyBias * analysis.sky[i]), 0, 1);
    // Blend in inverse depth: mixing metres directly would let a single
    // far pixel dominate a near one.
    const inv = (1 - k) / geometric[i] + k / neural[i];
    out[i] = 1 / Math.max(inv, 1e-9);
  }
  return out;
}
