/**
 * reconstruct.js — turning a depth field into a surface.
 *
 * Every pixel becomes a point in space at its own distance along its own
 * ray, and neighbouring points are stitched into quads. That is the whole
 * idea, and it works perfectly from the viewpoint the photograph was
 * taken from, because a vertex moved along its own ray cannot move in the
 * image.
 *
 * It stops working the moment you step sideways, and the failure is
 * always the same one: a quad spanning a depth discontinuity — the edge
 * of a cliff, the silhouette of a person — stretches into a rubber sheet
 * between the near thing and the far thing. Nothing is behind the near
 * thing to draw, because the camera never saw behind it.
 *
 * The proper fix is to hallucinate what was hidden, which is what layered
 * depth inpainting does and what needs a second network. The cheap fix,
 * used here, is to refuse to draw those quads at all. A torn edge reads as
 * a real silhouette with a gap behind it; a stretched one reads as melted
 * plastic. Tearing is much the better failure.
 */

/**
 * @param {object} o
 *   analysis   from analyze()
 *   camera     from makeCameraModel()
 *   depth      Float32Array over the analysis grid, metres
 *   gridWidth  target mesh resolution across
 *   overscan   {x, y} fraction of the frame to extend past the edges
 *   tearRatio  neighbouring depths further apart than this factor tear
 *   maxRange   depth at which everything is considered "the horizon"
 */
export function reconstruct(o) {
  const { analysis, camera, depth } = o;
  const tearRatio = o.tearRatio ?? 2.2;
  const maxRange = o.maxRange ?? 30000;
  /** Beyond this, parallax can never reveal a stretched quad, so none tear. */
  const tearMaxDistance = o.tearMaxDistance ?? 1500;

  // Overscan gives the camera somewhere to look when it turns slightly off
  // the photograph's own axis. The edge pixels simply extend outwards. A
  // cylindrical panorama already covers most of the horizon, so it needs
  // far less — and pushing azimuth past the ends would wrap the world.
  const cylindrical = camera.projection === 'cylindrical';
  // Barely any, now that a full environment surrounds the reconstruction.
  // Overscanned geometry is stretched copies of the outermost pixel
  // column, and the environment's feathered extension of the same pixels
  // looks better than that; all this needs to do is stop a hairline gap
  // opening exactly at the frame edge.
  const ox = o.overscan?.x ?? 0.03;
  const oy = o.overscan?.y ?? 0.03;

  const aspect = analysis.aspect;
  const budget = o.vertexBudget ?? 90000;
  let gw = o.gridWidth ?? 340;
  let gh = Math.max(8, Math.round(gw / aspect));
  if (gw * gh > budget) {
    const k = Math.sqrt(budget / (gw * gh));
    gw = Math.max(16, Math.round(gw * k));
    gh = Math.max(8, Math.round(gh * k));
  }

  const nv = (gw + 1) * (gh + 1);
  const positions = new Float32Array(nv * 3);
  const uvs = new Float32Array(nv * 2);
  const normals = new Float32Array(nv * 3);
  const skyAttr = new Float32Array(nv);
  const depthAttr = new Float32Array(nv);
  /** +1 for rays above the horizontal, -1 below. */
  const side = new Int8Array(nv);
  /** 1 well inside the frame, falling to 0 at its outer border. */
  const edgeAttr = new Float32Array(nv);

  const { w: aw, h: ah, sky } = analysis;
  const dir = { x: 0, y: 0, z: 0 };
  const camY = camera.height;

  /** Bilinear sample of a scalar field over the analysis grid. */
  const sample = (field, u, v) => {
    const x = Math.min(aw - 1, Math.max(0, u * aw - 0.5));
    const y = Math.min(ah - 1, Math.max(0, v * ah - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(aw - 1, x0 + 1), y1 = Math.min(ah - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = field[y0 * aw + x0], b = field[y0 * aw + x1];
    const c = field[y1 * aw + x0], d = field[y1 * aw + x1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };

  // Rows are bunched towards the horizon.
  //
  // Distance to a ground plane goes as 1/sin(depression), so almost the
  // entire depth range of the scene is squeezed into the last degree or
  // two before the horizon — and that is precisely where a uniform grid
  // has its coarsest sampling in depth. Warping the row positions towards
  // the horizon spends vertices where the geometry is actually changing,
  // and costs nothing: it is the same mesh, distributed better.
  const hr = camera.horizonRow;
  const vLo = -oy, vHi = 1 + oy;
  const p = o.horizonBias ?? 1.7;
  const warpV = (v) => {
    if (v <= hr) {
      const span = hr - vLo;
      return span > 1e-6 ? hr - Math.pow((hr - v) / span, p) * span : v;
    }
    const span = vHi - hr;
    return span > 1e-6 ? hr + Math.pow((v - hr) / span, p) * span : v;
  };

  const rowV = new Float32Array(gh + 1);
  const colU = new Float32Array(gw + 1);
  for (let i = 0; i <= gw; i++) colU[i] = (i / gw) * (1 + 2 * ox) - ox;
  for (let j = 0; j <= gh; j++) rowV[j] = warpV((j / gh) * (1 + 2 * oy) - oy);

  for (let j = 0; j <= gh; j++) {
    // Image coordinates, extended past the frame by the overscan.
    const vRaw = rowV[j];
    const vClamped = Math.min(1, Math.max(0, vRaw));
    for (let i = 0; i <= gw; i++) {
      const uRaw = colU[i];
      const uClamped = Math.min(1, Math.max(0, uRaw));
      const k = j * (gw + 1) + i;

      camera.ray(uRaw, vRaw, dir);
      // Outside the frame there is no image data, so the depth of the
      // nearest real pixel is carried outwards.
      const t = sample(depth, uClamped, vClamped);
      side[k] = dir.y >= 0 ? 1 : -1;

      positions[k * 3] = dir.x * t;
      positions[k * 3 + 1] = camY + dir.y * t;
      positions[k * 3 + 2] = dir.z * t;
      // UVs clamp, so overscanned geometry wears the edge pixels.
      uvs[k * 2] = uClamped;
      uvs[k * 2 + 1] = 1 - vClamped;
      skyAttr[k] = sample(sky, uClamped, vClamped);
      depthAttr[k] = t;
      // How far inside the frame this vertex is, used to dissolve the
      // outer border into the surrounding environment. Without it the
      // reconstruction ends in a hard-edged wedge — the silhouette of the
      // lens's own field of view — which is unmistakably an artefact the
      // moment you look at it from the side.
      const inset = Math.min(
        uRaw - (-ox), (1 + ox) - uRaw,
        vRaw - (-oy), (1 + oy) - vRaw,
      );
      edgeAttr[k] = Math.max(0, Math.min(1, inset / 0.10));
    }
  }

  // Quads, sorted into sky and ground, skipping any that straddle a
  // genuine depth discontinuity.
  //
  // Sky and ground are kept apart because they have to be *drawn*
  // differently: the photograph's sky is a backdrop a kilometre or two
  // out, well below most of a thunderstorm, and if it writes depth it
  // hides the discharge it is supposed to contain. The ground, the
  // headland and everything in the foreground must keep writing depth,
  // because occluding the channel properly is most of what sells the
  // composite.
  const skyIdx = [];
  const groundIdx = [];
  let torn = 0;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const a = j * (gw + 1) + i;
      const b = a + 1;
      const c = a + (gw + 1);
      const d = c + 1;
      const da = depthAttr[a], db = depthAttr[b], dc = depthAttr[c], dd = depthAttr[d];
      const lo = Math.min(da, db, dc, dd);
      const hi = Math.max(da, db, dc, dd);

      // Tearing applies only to the foreground, and only away from the
      // horizon.
      //
      // A depth ratio is a poor silhouette detector on its own, because a
      // flat plane seen almost edge-on produces enormous ratios between
      // neighbouring rows without any discontinuity at all: distance to
      // the ground goes as 1/sin(depression), so the last degree before
      // the horizon covers more range than the whole rest of the image.
      // Reading that as an edge tears a black band clean across the frame.
      //
      // What tearing is actually for is parallax: the artefact only shows
      // when the viewer moves far enough to see round a near object. Past
      // a kilometre or so they never can, so the test is confined to
      // things close enough to matter, and quads spanning the horizon —
      // where the two surfaces meet at infinity — are exempt outright.
      const straddlesHorizon = !(side[a] === side[b] && side[b] === side[c] && side[c] === side[d]);
      const farField = lo > tearMaxDistance;
      if (!straddlesHorizon && !farField && hi > lo * tearRatio) { torn++; continue; }

      const skyish = (skyAttr[a] + skyAttr[b] + skyAttr[c] + skyAttr[d]) * 0.25;
      const target = skyish > 0.5 && !straddlesHorizon ? skyIdx : groundIdx;
      target.push(a, c, b, b, c, d);
    }
  }
  const indices = groundIdx.concat(skyIdx);

  // Normals from the faces that survived.
  for (let f = 0; f < indices.length; f += 3) {
    const i0 = indices[f] * 3, i1 = indices[f + 1] * 3, i2 = indices[f + 2] * 3;
    const ax = positions[i1] - positions[i0];
    const ay = positions[i1 + 1] - positions[i0 + 1];
    const az = positions[i1 + 2] - positions[i0 + 2];
    const bx = positions[i2] - positions[i0];
    const by = positions[i2 + 1] - positions[i0 + 1];
    const bz = positions[i2 + 2] - positions[i0 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    for (const idx of [i0, i1, i2]) {
      normals[idx] += nx; normals[idx + 1] += ny; normals[idx + 2] += nz;
    }
  }
  for (let k = 0; k < nv; k++) {
    const x = normals[k * 3], y = normals[k * 3 + 1], z = normals[k * 3 + 2];
    const len = Math.hypot(x, y, z);
    if (len > 1e-9) {
      normals[k * 3] = x / len; normals[k * 3 + 1] = y / len; normals[k * 3 + 2] = z / len;
    } else {
      // An isolated vertex: face the camera, so it is at least lit.
      normals[k * 3] = 0; normals[k * 3 + 1] = 0; normals[k * 3 + 2] = 1;
    }
  }

  const Idx = nv > 65535 ? Uint32Array : Uint16Array;
  return {
    positions, normals, uvs,
    index: new Idx(indices),
    indexGround: new Idx(groundIdx),
    indexSky: new Idx(skyIdx),
    sky: skyAttr, depth: depthAttr, side, edge: edgeAttr,
    // The image coordinates each row and column actually landed on, so
    // the mapping stays inspectable after the horizon warp.
    rowV, colU,
    gridWidth: gw, gridHeight: gh,
    quadsTorn: torn,
    quadsTotal: gw * gh,
    tearFraction: torn / (gw * gh),
    skyQuadFraction: skyIdx.length / Math.max(1, indices.length),
    overscan: { x: ox, y: oy },
  };
}

/**
 * Statistics worth showing the user, mostly so an implausible
 * reconstruction is obvious rather than merely odd-looking.
 */
export function describe(mesh, depth, analysis) {
  let near = Infinity, far = 0, sum = 0;
  for (let i = 0; i < depth.length; i++) {
    const t = depth[i];
    if (t < near) near = t;
    if (t > far) far = t;
    sum += t;
  }
  return {
    nearest: near,
    farthest: far,
    mean: sum / depth.length,
    vertices: mesh.positions.length / 3,
    triangles: mesh.index.length / 3,
    tearFraction: mesh.tearFraction,
    skyFraction: analysis.skyFraction,
  };
}
