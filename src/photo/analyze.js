/**
 * analyze.js — reading a photograph well enough to stand it up in 3D.
 *
 * Two things have to come out of the image before any depth can be
 * assigned to it, and neither is in the file:
 *
 *   1. Where the horizon is. Not for cosmetic reasons — the horizon is
 *      the set of rays with zero elevation, so it fixes the camera's
 *      pitch, and without the pitch there is no way to know which
 *      direction any pixel is looking. It is also what makes the
 *      reconstruction *metric*: the literature on scaling monocular
 *      depth is blunt about this, that camera height above the ground
 *      plane is the scale factor, and the horizon is what ties an image
 *      row to that plane.
 *
 *   2. Which pixels are sky. Sky and ground get unprojected onto
 *      different surfaces, and they respond to a lightning flash
 *      completely differently: cloud scatters light almost regardless of
 *      which way it faces, while a hillside obeys a cosine law.
 *
 * Both are found from cheap, explainable image statistics rather than a
 * network, and both report a confidence, because on a photograph with no
 * visible horizon the honest answer is to say so and let the user place
 * it by hand.
 */

/**
 * Decode a File, Blob, URL or existing bitmap into a canvas of a size the
 * GPU will actually accept.
 *
 * Two things bite here and both come from real photographs rather than
 * test images. A modern phone panorama can be 34 megapixels, which
 * `createImageBitmap` will sometimes simply refuse; and its 9280-pixel
 * width is past the maximum texture size on a great many GPUs, so even a
 * successful decode would fail on upload. Decoding through an <img> and
 * drawing into a capped canvas sidesteps both, and costs nothing —
 * nothing here needs more resolution than the screen has.
 *
 * A canvas is returned rather than an ImageBitmap because everything
 * downstream — the analysis sampler, the depth model, the texture — takes
 * one just as happily.
 */
export async function loadImage(source, maxSide = 4096) {
  if (source && source.getContext) return source;          // already a canvas

  const draw = (src, w, h) => {
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    canvas.sourceWidth = w;
    canvas.sourceHeight = h;
    return canvas;
  };

  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return draw(source, source.width, source.height);
  }

  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = 'async';
    if (typeof source === 'string') img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('the browser could not decode that image'));
      img.src = url;
    });
    // decode() resolves once the pixels are really available; some
    // browsers fire load before that for large progressive JPEGs.
    if (img.decode) { try { await img.decode(); } catch { /* onload was enough */ } }
    return draw(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

/** Draw an ImageBitmap into a canvas of at most `maxWidth`, and read it back. */
export function sampleImage(bitmap, maxWidth = 320) {
  const scale = Math.min(1, maxWidth / bitmap.width);
  const w = Math.max(8, Math.round(bitmap.width * scale));
  const h = Math.max(8, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Separable box blur over a scalar field, `radius` pixels, in place-safe. */
function blur(src, w, h, radius) {
  if (radius < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (radius * 2 + 1);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum * norm;
      const add = src[y * w + Math.min(w - 1, x + radius + 1)];
      const sub = src[y * w + Math.max(0, x - radius)];
      sum += add - sub;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      const add = tmp[Math.min(h - 1, y + radius + 1) * w + x];
      const sub = tmp[Math.max(0, y - radius) * w + x];
      sum += add - sub;
    }
  }
  return out;
}

/**
 * Otsu's method on a 1-D signal: the split that maximises the variance
 * *between* the two halves it creates. Parameter-free, which matters
 * because there is no sensible universal threshold for "this row is sky".
 *
 * Returns the split index and a separability score in 0..1 — the fraction
 * of the signal's total variance the split explains. A photo with a clean
 * horizon scores high; a photo of a wall scores near zero, and that is
 * the number worth showing the user.
 */
function otsuSplit(values, lo, hi) {
  let total = 0, totalSq = 0, n = 0;
  for (let i = lo; i < hi; i++) { total += values[i]; totalSq += values[i] * values[i]; n++; }
  if (n < 4) return { index: (lo + hi) >> 1, score: 0 };
  const mean = total / n;
  const variance = totalSq / n - mean * mean;

  let best = -1, bestIdx = (lo + hi) >> 1;
  let sumA = 0, nA = 0;
  for (let i = lo; i < hi - 1; i++) {
    sumA += values[i]; nA++;
    const nB = n - nA;
    if (nA < 2 || nB < 2) continue;
    const mA = sumA / nA, mB = (total - sumA) / nB;
    const between = (nA * nB / (n * n)) * (mA - mB) * (mA - mB);
    if (between > best) { best = between; bestIdx = i; }
  }
  return {
    index: bestIdx,
    score: variance > 1e-9 ? clamp01(best / variance) : 0,
  };
}

/**
 * Analyse an image.
 *
 * @param {ImageData} img  already downsampled
 * @returns {{
 *   w, h, luma, blueness, edge, sky,
 *   horizonRow, horizonConfidence, skyFraction, meanLuma
 * }}
 */
export function analyze(img) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const luma = new Float32Array(n);
  const blueness = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Positive where blue dominates. Works for blue sky; overcast skies
    // score near zero and are caught by the brightness and texture terms.
    const warm = Math.max(r, g);
    blueness[i] = (b - warm) / (b + warm + 1e-4);
  }

  // Local contrast. Sky is smooth; foliage, rock and buildings are not.
  const edge = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = luma[i];
      const dx = Math.abs(luma[y * w + Math.min(w - 1, x + 1)] - l);
      const dy = Math.abs(luma[Math.min(h - 1, y + 1) * w + x] - l);
      edge[i] = dx + dy;
    }
  }
  const edgeSoft = blur(edge, w, h, Math.max(1, Math.round(w / 90)));

  let meanLuma = 0;
  for (let i = 0; i < n; i++) meanLuma += luma[i];
  meanLuma /= n;

  // Per-pixel "this looks like sky". Deliberately not using height in the
  // frame here: that prior would bias the horizon search towards the
  // middle of the image, which is exactly the thing being measured.
  const skyRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const bright = smoothstep(0.22, 0.78, luma[i]);
    const blue = smoothstep(-0.03, 0.20, blueness[i]);
    const smooth = 1 - smoothstep(0.015, 0.13, edgeSoft[i]);
    skyRaw[i] = clamp01(0.42 * bright + 0.28 * blue + 0.30 * smooth);
  }

  // Horizon: the row that best separates sky above from not-sky below.
  const rowScore = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += skyRaw[y * w + x];
    rowScore[y] = s / w;
  }
  const rowSoft = blur(rowScore, 1, h, Math.max(1, Math.round(h / 60)));
  const lo = Math.floor(h * 0.04), hi = Math.ceil(h * 0.96);
  const split = otsuSplit(rowSoft, lo, hi);

  // Sanity: the bright, smooth half has to be the upper one. If it is
  // not, this is not a photograph with a horizon in it.
  let above = 0, below = 0;
  for (let y = lo; y < split.index; y++) above += rowSoft[y];
  for (let y = split.index; y < hi; y++) below += rowSoft[y];
  above /= Math.max(1, split.index - lo);
  below /= Math.max(1, hi - split.index);
  const rightWayUp = above > below;

  const horizonRow = (split.index + 0.5) / h;
  const horizonConfidence = rightWayUp ? split.score : 0;

  // Final sky mask: the raw score, now allowed to use the horizon as a
  // prior, then blurred so the mesh does not get a hard seam through it.
  const sky = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    // Above the horizon is evidence for sky, but weak evidence: a
    // mountain ridge or a tower rises through it and must stay solid.
    const prior = rightWayUp
      ? smoothstep(horizonRow + 0.06, horizonRow - 0.06, (y + 0.5) / h)
      : 0.5;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      sky[i] = clamp01(0.62 * skyRaw[i] + 0.38 * prior * skyRaw[i] + 0.18 * (prior - 0.5));
    }
  }
  const skySoft = blur(sky, w, h, Math.max(1, Math.round(w / 120)));

  let skyFraction = 0;
  for (let i = 0; i < n; i++) skyFraction += skySoft[i] > 0.5 ? 1 : 0;
  skyFraction /= n;

  // Average colour of the sky and of the ground, and of the top and
  // bottom edges specifically. These are what the world outside the
  // photograph gets painted with, so that turning away from the frame
  // shows a plausible continuation of the same scene rather than a void.
  const palette = {
    sky: [0, 0, 0], ground: [0, 0, 0], top: [0, 0, 0], bottom: [0, 0, 0],
  };
  let wSky = 0, wGround = 0, wTop = 0, wBottom = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
      const s = skySoft[i];
      palette.sky[0] += r * s; palette.sky[1] += g * s; palette.sky[2] += b * s;
      wSky += s;
      const gnd = 1 - s;
      palette.ground[0] += r * gnd; palette.ground[1] += g * gnd; palette.ground[2] += b * gnd;
      wGround += gnd;
      if (v < 0.12) { palette.top[0] += r; palette.top[1] += g; palette.top[2] += b; wTop++; }
      if (v > 0.88) {
        palette.bottom[0] += r; palette.bottom[1] += g; palette.bottom[2] += b; wBottom++;
      }
    }
  }
  const norm = (c, wt) => {
    const k = wt > 1e-6 ? 1 / wt : 0;
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  palette.sky = norm(palette.sky, wSky);
  palette.ground = norm(palette.ground, wGround);
  palette.top = norm(palette.top, wTop);
  palette.bottom = norm(palette.bottom, wBottom);

  return {
    w, h,
    luma, blueness, edge: edgeSoft, sky: skySoft,
    horizonRow, horizonConfidence, skyFraction, meanLuma, palette,
    aspect: w / h,
  };
}

/**
 * Which projection the photograph was made with.
 *
 * A normal lens is rectilinear: straight lines stay straight, and the
 * image is a plane cut through the bundle of rays. A stitched panorama is
 * not — it is wrapped onto a cylinder, so horizontal position is
 * proportional to *azimuth* rather than to the tangent of it, and the
 * horizon bows. Unprojecting a panorama with a pinhole model bends the
 * world in the opposite direction and pushes the edges out to absurd
 * distances, so the two need to be told apart.
 *
 * An aspect ratio past about 2.2:1 is a good enough tell: no ordinary
 * lens covers that in one frame.
 */
export function guessProjection(aspect) {
  return aspect >= 2.2 ? 'cylindrical' : 'rectilinear';
}

/**
 * The camera that took the photograph, as far as it can be recovered.
 *
 * Positioned `height` metres above a flat ground plane and pitched so that
 * image row `horizonRow` maps to exactly zero elevation. Field of view is
 * genuinely unrecoverable from a single image without a network or EXIF,
 * so it stays a control: 55 degrees vertical is a fair guess for a
 * hand-held frame, and for a panorama the horizontal sweep is the more
 * natural thing to specify.
 */
export function makeCameraModel({
  fovDeg = 55, horizonRow = 0.5, height = 5, aspect = 1.5,
  projection = 'rectilinear', hFovDeg = null,
}) {
  const T = Math.tan((fovDeg * Math.PI) / 360);
  const yh = 1 - 2 * horizonRow;          // horizon in normalised image coords
  const pitch = -Math.atan(yh * T);       // positive = the camera looks up
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  // For a cylinder, the horizontal sweep is a free parameter; if it is not
  // given, assume the pixels are square on the cylinder's surface, which
  // is what every stitcher does by default.
  const hSweep = ((hFovDeg ?? Math.min(330, (fovDeg * aspect))) * Math.PI) / 180;

  const model = {
    fovDeg, horizonRow, height, aspect, pitch, T, projection,
    hFovDeg: (hSweep * 180) / Math.PI,

    /**
     * World-space direction of the ray through normalised image
     * coordinates (u, v), measured from the top-left. The camera sits at
     * (0, height, 0) looking along -Z with the pitch applied.
     */
    ray(u, v, out = { x: 0, y: 0, z: 0 }) {
      if (projection === 'cylindrical') {
        // Azimuth is linear in u; elevation is still a tangent mapping up
        // the cylinder wall, then the whole thing is pitched.
        const az = (u - 0.5) * hSweep;
        const yEl = (1 - 2 * v) * T;
        // Direction on the cylinder before pitch: forward -Z, right +X.
        const fx = Math.sin(az), fz = -Math.cos(az);
        const ry = yEl * cp + sp;
        const rz = (yEl * sp - cp);
        // Pitch acts in the plane containing the view direction and up.
        const inv = 1 / Math.hypot(fx * -rz, ry, fz * -rz);
        out.x = fx * -rz * inv; out.y = ry * inv; out.z = fz * -rz * inv;
        return out;
      }
      const x = (2 * u - 1) * aspect * T;
      const y = (1 - 2 * v) * T;
      // Rotate the camera-space direction (x, y, -1) about X by the pitch.
      const ry = y * cp + sp;             // y*cos - (-1)*sin
      const rz = y * sp - cp;             // y*sin + (-1)*cos
      const inv = 1 / Math.hypot(x, ry, rz);
      out.x = x * inv; out.y = ry * inv; out.z = rz * inv;
      return out;
    },

    /** Elevation of the ray through image row v, in radians. */
    elevation(v) {
      const y = (1 - 2 * v) * T;
      return Math.atan2(y * cp + sp, -(y * sp - cp));
    },
  };
  return model;
}
