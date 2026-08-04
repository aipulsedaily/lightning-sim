/**
 * main.js — wiring the physics to the screen.
 *
 * The simulation runs on its own clock, measured in simulated seconds
 * since initiation. A flash spans six orders of magnitude in time — tens
 * of milliseconds of leader, tens of microseconds of return stroke,
 * hundreds of milliseconds of pause — so a single playback rate can only
 * ever show one of them. The default mode gives each phase its own rate,
 * chosen so each takes a comfortable few seconds of wall clock: you watch
 * the leader grope its way down, the upward leader rise to meet it, and
 * the return stroke climb the channel, all in one continuous take, with
 * the *relative* physics untouched.
 */

import * as THREE from 'three';
import { Flash, FlashType, Phase, makeTarget, defaultRegionsFor } from './core/flash.js';
import { CLOUD, FLASH } from './core/constants.js';
import { BoltRenderer } from './render/bolt.js';
import { SkyRenderer } from './render/sky.js';
import { Ground, Structures } from './render/ground.js';
import { Rain } from './render/rain.js';
import { PostPipeline } from './render/post.js';
import { OrbitCamera } from './render/controls.js';
import { Panel } from './ui/panel.js';
import { Scope } from './ui/scope.js';
import { ThunderAudio } from './audio/thunderAudio.js';

/* ------------------------------------------------------------------ *
 * Shared settings
 * ------------------------------------------------------------------ */

const state = {
  /** master dial, 0-100; drives everything below it */
  intensity: 10,
  flashType: FlashType.NEGATIVE_CG,
  timeScale: 'auto',
  autoLoop: true,
  stormIntensity: 1.0,
  thresholdScale: 1.0,
  eta: 3.0,
  branchiness: 0.10,
  stepLength: 26,
  leaderSpeed: 2.0e5,
  rain: 0.55,
  coverage: 0.56,
  exposure: 1.0,
  bloom: 0.62,
  channelWidth: 1.0,
  channelBrightness: 1.0,
  persistence: 0.11,
  cloudSteps: 34,
  showCharge: false,
  followTip: false,

  /* photograph reconstruction */
  photoDepthSource: 'geometric',
  photoProjection: 'auto',
  photoHorizon: 0.5,
  photoFov: 55,
  photoCameraHeight: 25,
  photoCloudBase: 1600,
  photoMaxRange: 30000,
  photoRelief: 0.16,
  photoTear: 2.2,
  photoRelight: 1.0,
  photoSkyPush: 1,
  photoDebug: 0,
  /** where the storm sits, in simulation coordinates */
  stormCenter: { x: 0, y: 0 },
};

/**
 * How fast each phase should play, in simulated seconds per wall second.
 * Chosen so every phase lasts a few seconds on screen no matter that they
 * differ by a factor of ten thousand in duration.
 */
const PHASE_RATE = {
  [Phase.LEADER]: 14e-3,          // ~50 ms of leader over ~3.5 s
  [Phase.ATTACHMENT]: 1.0e-3,     // the final jump, slowly
  [Phase.RETURN_STROKE]: 0.10e-3, // the front and the peak, very slowly
  [Phase.DART]: 1.2e-3,
  [Phase.INTERSTROKE]: 110e-3,    // skim the dark pause
  [Phase.CONTINUING]: 45e-3,
  [Phase.INITIATION]: 1,
  [Phase.DONE]: 1,
  [Phase.IDLE]: 1,
};

/**
 * The master intensity dial.
 *
 * One number from 0 to 100 that sets everything a storm's severity would
 * actually set. The anchors matter more than the curve: 0 leaves the
 * cloud too weakly charged for the field to reach its inception
 * threshold anywhere, so genuinely nothing happens — not a suppressed
 * flash, an *impossible* one, which is the honest way to render "off".
 * 10 is a quiet storm behaving as the simulation's own defaults do, and
 * 100 is about as violent as the observed distributions go.
 *
 * Everything here is a real parameter of the model. The dial does not add
 * a fudge factor on top; it just moves several knobs together the way a
 * strengthening storm does.
 */
function intensityMapping(t) {
  const k = Math.max(0, Math.min(100, t)) / 100;
  const lerp = (a, b, x) => a + (b - a) * x;
  // Charge is anchored at three points so 10 reproduces the defaults
  // exactly and 0 sits well below what can initiate.
  const charge = t <= 10
    ? lerp(0.60, 1.00, t / 10)
    : lerp(1.00, 1.80, (t - 10) / 90);
  return {
    stormIntensity: charge,
    // A more electrified storm also breaks down a little more readily.
    thresholdScale: lerp(1.10, 0.88, k),
    // Violent storms branch harder and flash more often.
    branchiness: lerp(0.05, 0.26, k),
    eta: lerp(3.8, 2.2, k),
    multiplicityScale: lerp(0.7, 2.1, k),
    rain: lerp(0.05, 0.95, k),
    coverage: lerp(0.42, 0.78, k),
    channelBrightness: lerp(0.85, 1.7, k),
    // How far the cell wanders between flashes. A busy storm spreads its
    // strikes over kilometres; without this they all land on one spot.
    stormJitter: lerp(900, 4200, k),
    // Seconds of darkness between flashes when looping.
    restDelay: t <= 0 ? Infinity : lerp(6.5, 0.25, k * k),
  };
}

/** Push the dial's values into the settings and refresh the controls. */
function applyIntensity(refire = true) {
  const m = intensityMapping(state.intensity);
  Object.assign(state, m);
  panel?.syncAll();
  if (refire) newFlash();
}

const TARGETS = [
  { ...makeTarget(240, -160, 118, 2.6, 'lattice mast'), kind: 'mast' },
  { ...makeTarget(-520, 380, 26, 1.4, 'oak'), kind: 'tree' },
  { ...makeTarget(-350, -640, 21, 1.2, 'pine'), kind: 'tree' },
  { ...makeTarget(760, 520, 33, 1.8, 'poplar'), kind: 'tree' },
];

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, powerPreference: 'high-performance',
  alpha: false, stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.autoClear = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 2, 200000);
camera.position.set(2400, 420, 5600);

const controls = new OrbitCamera(camera, canvas, {
  targetHeight: 1900, minDistance: 40, maxDistance: 90000, minHeight: 3,
});

const post = new PostPipeline(renderer, {
  levels: 6, threshold: 0.95, knee: 0.5, strength: state.bloom,
  exposure: state.exposure, vignette: 0.4, grain: 0.007,
});
const sky = new SkyRenderer(renderer, {
  cloudBase: CLOUD.BASE_ALTITUDE, cloudTop: CLOUD.TOP_ALTITUDE,
  coverage: state.coverage, steps: state.cloudSteps, scale: 0.5,
});
scene.add(sky.blit);

const ground = new Ground({ size: 90000, segments: 384, amplitude: 150 });
scene.add(ground.mesh);

const structures = new Structures(TARGETS);
scene.add(structures.group);

const rain = new Rain({ count: 30000 });
scene.add(rain.mesh);

const bolt = new BoltRenderer({ subdivisions: 3, maxSegments: 90000 });
scene.add(bolt.mesh);

/* charge-structure overlay -------------------------------------------- */

const chargeGroup = new THREE.Group();
chargeGroup.visible = false;
scene.add(chargeGroup);

function buildChargeOverlay(regions, initiation) {
  chargeGroup.clear();
  for (const r of regions) {
    const geo = new THREE.SphereGeometry(1, 24, 14);
    const mat = new THREE.MeshBasicMaterial({
      color: r.charge > 0 ? 0xff5a4a : 0x4aa8ff,
      wireframe: true, transparent: true,
      opacity: 0.10 + 0.06 * Math.min(1, Math.abs(r.charge) / 50),
      depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(r.x || 0, r.z, r.y || 0);
    m.scale.set(r.radiusH, r.radiusV, r.radiusH);
    chargeGroup.add(m);
  }
  if (initiation) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(90, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, wireframe: true }));
    m.position.set(initiation.x, initiation.z, initiation.y);
    chargeGroup.add(m);
  }
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Photograph reconstruction
 * ------------------------------------------------------------------ */

let photo = null;          // { scene, camera, cache, ... }
let lastPhotoInfo = null;  // exposed on window.lightning for poking at
let photoCredit = null;    // provenance of a bundled preset, if that is what loaded
let photoBusy = false;
let photoPending = null;   // the most recent request, if one arrived mid-build

/** Everything procedural, so it can be stood down when a photo takes over. */
function setProceduralVisible(on) {
  sky.blit.visible = on;
  ground.mesh.visible = on;
  structures.group.visible = on;
  renderer.setClearColor(0x000000, 1);
}

async function loadPhoto(source, { resetCalibration = true } = {}) {
  if (photoBusy) { photoPending = { source, resetCalibration }; return; }
  photoBusy = true;
  if (resetCalibration) panel.openPhotoSection();
  const { buildPhotoScene } = await import('./photo/scene.js');

  try {
    const first = resetCalibration;
    const result = await buildPhotoScene(source, {
      cache: first ? null : photo?.cache,
      projection: state.photoProjection,
      // On the first load, take the detected horizon; afterwards the
      // slider is the authority, because the user has overruled it.
      horizonRow: first ? undefined : state.photoHorizon,
      fovDeg: state.photoFov,
      cameraHeight: state.photoCameraHeight,
      cloudBase: state.photoCloudBase,
      maxRange: state.photoMaxRange,
      skyRelief: state.photoRelief,
      groundRelief: state.photoRelief * 0.3,
      tearRatio: state.photoTear >= 11.9 ? 1e9 : state.photoTear,
      tearMaxDistance: 1500,
      relight: state.photoRelight,
      useNeural: state.photoDepthSource === 'neural',
      anisotropy: renderer.capabilities.getMaxAnisotropy?.() ?? 8,
      // A 34-megapixel panorama is wider than most GPUs will take.
      maxTextureSide: Math.min(4096, renderer.capabilities.maxTextureSize || 4096),
      onProgress: reportPhotoProgress,
    });

    if (photo) {
      scene.remove(photo.scene.object);
      scene.remove(photo.environment.object);
      photo.scene.dispose();
      photo.environment.dispose();
    }
    photo = result;
    scene.add(result.environment.object);
    scene.add(result.scene.object);
    setProceduralVisible(false);

    if (first) {
      state.photoHorizon = result.camera.horizonRow;
      state.photoProjection = state.photoProjection === 'auto'
        ? state.photoProjection : result.scene.info.projection;
      panel.syncAll();
      result.scene.applyHomeView(camera, controls, camera.aspect);
      // Put the storm in front of the camera at a distance where the
      // below-cloud channel actually frames, rather than wherever the last
      // one happened to be.
      state.stormCenter = {
        x: 0,
        y: -Math.max(state.photoCloudBase * 3.5,
          Math.min(9000, state.photoMaxRange * 0.35)),
      };
      newFlash();
    }
    result.scene.debug = state.photoDebug;
    reportPhotoInfo(result.scene.info);
  } catch (e) {
    console.error(e);
    panel.setPhotoStatus(`Could not build a scene from that: ${e.message}`, 'bad');
  } finally {
    photoBusy = false;
    if (photoPending) {
      const p = photoPending; photoPending = null;
      loadPhoto(p.source, { resetCalibration: p.resetCalibration });
    }
  }
}

function rebuildPhoto(force = false) {
  if (!photo) return;
  loadPhoto(photo.cache.bitmap, { resetCalibration: false });
  void force;
}

function clearPhoto() {
  if (!photo) return;
  scene.remove(photo.scene.object);
  scene.remove(photo.environment.object);
  photo.scene.dispose();
  photo.environment.dispose();
  photo = null;
  photoCredit = null;
  controls.setLookMode(false);
  camera.fov = 52; camera.updateProjectionMatrix();
  for (const t of document.querySelectorAll('.preset')) t.classList.remove('on');
  setProceduralVisible(true);
  state.stormCenter = { x: 0, y: 0 };
  panel.setPhotoStatus('No photo loaded.');
  setCameraPreset('ground');
  newFlash();
}

function reportPhotoProgress(p) {
  switch (p.phase) {
    case 'decode': panel.setPhotoStatus('Decoding the image...'); break;
    case 'analyze': panel.setPhotoStatus('Looking for the horizon...'); break;
    case 'geometry': panel.setPhotoStatus('Unprojecting onto ground and cloud...'); break;
    case 'mesh': panel.setPhotoStatus('Building the mesh...'); break;
    case 'download':
      panel.setPhotoStatus(
        `Downloading the depth model, ${(p.fraction * 100).toFixed(0)}% ` +
        `(${(p.loaded / 1e6).toFixed(1)} of ${(p.total / 1e6).toFixed(1)} MB) - once only.`);
      break;
    case 'backend':
      panel.setPhotoStatus(
        `Loading the depth model on ${p.device.toUpperCase()} (${p.dtype}, ~${p.size} MB)...`);
      break;
    case 'infer': panel.setPhotoStatus('Running depth estimation...'); break;
    case 'fallback':
      panel.setPhotoStatus(`${p.message} - trying the next backend.`, 'warn');
      break;
    case 'error':
      panel.setPhotoStatus(`Depth model failed, using geometry only: ${p.message}`, 'warn');
      break;
    default: break;
  }
}

function reportPhotoInfo(info) {
  lastPhotoInfo = info;
  const conf = info.horizonConfidence;
  const size = `${info.imageSize[0]}x${info.imageSize[1]}`;
  const bits = [
    `${size}, ${info.projection}`,
    `horizon ${(info.horizonRow * 100).toFixed(0)}% down`,
    `${(info.nearest).toFixed(0)} m to ${(info.farthest / 1000).toFixed(1)} km`,
    `${(info.triangles / 1000).toFixed(0)}k triangles`,
    `${(info.tearFraction * 100).toFixed(1)}% torn`,
    `${(info.skyFraction * 100).toFixed(0)}% sky`,
  ];
  if (info.neural) {
    bits.push(info.neural.ok ? 'AI depth fitted'
      : `AI depth unavailable (${info.neural.error || 'no usable depth returned'}) - ` +
        `using geometry`);
  }

  const summary = bits.join(' | ');
  const prefix = photoCredit ? `${photoCredit}\n` : '';

  if (info.neural && !info.neural.ok) {
    panel.setPhotoStatus(prefix + summary, 'warn');
    return;
  }
  if (conf < 0.35) {
    panel.setPhotoStatus(
      `${prefix}No clear horizon in this image (confidence ${(conf * 100).toFixed(0)}%). ` +
      `Set it by hand with the Horizon slider - everything else depends on it. ` +
      summary, 'warn');
  } else {
    panel.setPhotoStatus(prefix + summary, 'good');
  }
}

const audio = new ThunderAudio({ volume: 0.75 });
let flash = null;
let audioReady = false;
let thunderReport = null;
let thunderFired = false;
let restIdleTime = 0;
let lastSeed = null;
let lastLoggedPhase = null;

function newFlash(reuseSeed = false) {
  const seed = reuseSeed && lastSeed !== null
    ? lastSeed
    : (Math.random() * 0x7fffffff) | 0;
  lastSeed = seed;

  // Moving the storm is moving its charge. Everything else — where the
  // leader starts, which way it goes, what it hits — follows from that.
  const regions = defaultRegionsFor(state.flashType).map(r => ({
    ...r,
    charge: r.charge * state.stormIntensity,
    x: (r.x || 0) + state.stormCenter.x,
    y: (r.y || 0) + state.stormCenter.y,
  }));

  flash = new Flash({
    seed,
    type: state.flashType,
    regions,
    targets: TARGETS,
    thresholdScale: state.thresholdScale,
    eta: state.eta,
    branchiness: state.branchiness,
    stepLength: state.stepLength,
    leaderSpeed: state.leaderSpeed,
    multiplicityScale: state.multiplicityScale,
    stormJitter: state.stormJitter,
    maxRoundsPerUpdate: 20,
  });

  thunderFired = false;
  thunderReport = null;
  restIdleTime = 0;
  lastLoggedPhase = null;
  scope.clear();
  bolt.resetPersistence();
  buildChargeOverlay(flash.regions, flash.initiation);
  return flash;
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

const scope = new Scope(document.getElementById('scope'), { window: 0.5 });

const panel = new Panel(document.getElementById('panel'), state, {
  onRestrike: (sameSeed) => newFlash(sameSeed === true),
  onAudio: async () => {
    audioReady = await audio.enable();
    return audioReady;
  },
  onCamera: (which) => setCameraPreset(which),
  onPhotoFile: (file) => loadPhoto(file, { resetCalibration: true }),
  onPhotoRebuild: (force) => rebuildPhoto(force),
  onPhotoClear: () => clearPhoto(),
  onIntensity: () => {
    clearTimeout(intensityTimer);
    Object.assign(state, intensityMapping(state.intensity));
    panel.syncAll();
    // Coalesce a drag into one new flash at the end of it.
    intensityTimer = setTimeout(() => newFlash(), 260);
  },
});
let intensityTimer = null;

/* Drop an image anywhere on the window. */
for (const ev of ['dragenter', 'dragover']) {
  window.addEventListener(ev, (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });
}
for (const ev of ['dragleave', 'dragend']) {
  window.addEventListener(ev, (e) => {
    if (e.relatedTarget) return;
    document.body.classList.remove('dragging');
  });
}
window.addEventListener('drop', (e) => {
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  document.body.classList.remove('dragging');
  photoCredit = null;                     // this one is the user's own
  for (const t of document.querySelectorAll('.preset')) t.classList.remove('on');
  loadPhoto(file, { resetCalibration: true });
});

/**
 * Click in the scene to move the storm.
 *
 * A click that lands on the reconstructed geometry is taken at its word:
 * whatever was pointed at — a cloud, a hillside, the water — the storm is
 * placed underneath it. Dragging still orbits, so the two are told apart
 * by how far the pointer moved.
 */
const raycaster = new THREE.Raycaster();
let pressAt = null;
canvas.addEventListener('pointerdown', (e) => {
  pressAt = { x: e.clientX, y: e.clientY, button: e.button };
});
canvas.addEventListener('pointerup', (e) => {
  if (!pressAt || pressAt.button !== 0) { pressAt = null; return; }
  const moved = Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y);
  pressAt = null;
  if (moved > 5 || !photo) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const hit = photo.scene.pick(ndc, camera, raycaster);
  if (!hit) return;
  // A storm is not a thing you can stand next to.
  //
  // Its charge sits five to ten kilometres up, so placing one a kilometre
  // away puts the whole discharge at seventy degrees elevation — directly
  // overhead, out of frame, and nothing like what anyone means by
  // "strike over there". The floor is therefore set by the geometry
  // rather than picked: far enough that the visible, below-cloud part of
  // the channel sits at a sensible angle above the horizon.
  const cloudBase = state.photoCloudBase || 1600;
  const minDistance = Math.max(4000, cloudBase * 2.6);   // ~21 degrees elevation
  let { x, y } = hit;
  const d = Math.hypot(x, y);
  if (d < minDistance) {
    if (d < 1) { x = 0; y = -minDistance; }
    else { const k = minDistance / d; x *= k; y *= k; }
  }
  state.stormCenter = { x, y };
  panel.setPhotoStatus(
    `Storm moved to ${(Math.hypot(x, y) / 1000).toFixed(2)} km away` +
    `${d < minDistance
      ? ` — pushed out from ${(d / 1000).toFixed(2)} km, which would have put it overhead`
      : ''}` +
    `${hit.onGround ? ', on the ground plane' : ''}. Firing.`, 'good');
  newFlash();
});

/* ------------------------------------------------------------------ *
 * Preset scenes
 * ------------------------------------------------------------------ */

/**
 * A strip of ready-made storm photographs, plus a tile for your own.
 *
 * The list is data, not code: `assets/photos/photos.json` carries the
 * file, the caption and the licence of each one, so scenes can be added
 * or removed without touching anything here. Every bundled image is in
 * the public domain, and its provenance travels with it.
 */
async function buildPresets() {
  const row = document.getElementById('presets-row');
  if (!row) return;

  const ownTile = () => {
    const b = document.createElement('button');
    b.className = 'preset own';
    b.title = 'Load one of your own photographs (or just drop it anywhere)';
    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = '+';
    const cap = document.createElement('span');
    cap.textContent = 'your own';
    b.append(plus, cap);
    b.addEventListener('click', () => {
      panel.openPhotoSection();
      document.querySelector('#panel input[type=file]')?.click();
    });
    return b;
  };

  let list = [];
  try {
    const res = await fetch('./assets/photos/photos.json');
    if (res.ok) list = await res.json();
  } catch { /* no presets bundled; the drop tile still works */ }

  const tiles = [];
  for (const p of list) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.style.backgroundImage = `url("./assets/photos/${p.thumb || p.file}")`;
    b.title = `${p.title} — ${p.licence}. Click to load.`;
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = p.label || p.title;
    b.appendChild(cap);
    b.addEventListener('click', async () => {
      for (const t of tiles) t.classList.remove('on');
      b.classList.add('on');
      row.classList.add('loading');
      for (const t of tiles) t.classList.add('busy');
      try {
        // The credit rides along with the reconstruction summary rather
        // than replacing it; both are worth reading.
        photoCredit = `${p.title} — ${p.licence}` +
          `${p.credit ? `, ${p.credit}` : ''}${p.hint ? `. ${p.hint}` : ''}`;
        await loadPhoto(`./assets/photos/${p.file}`, { resetCalibration: true });
      } finally {
        for (const t of tiles) t.classList.remove('busy');
        row.classList.remove('loading');
      }
    });
    tiles.push(b);
    row.appendChild(b);
  }
  row.appendChild(ownTile());
}
buildPresets();

document.getElementById('help-toggle').addEventListener('click', () => {
  document.body.classList.toggle('help-open');
});
document.getElementById('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-closed');
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); newFlash(); }
  if (e.key === 'r') newFlash(true);
  if (e.key === 'h') document.body.classList.toggle('ui-hidden');
  if (e.key === '?') document.body.classList.toggle('help-open');
  if (e.key >= '1' && e.key <= '4') {
    setCameraPreset(['ground', 'wide', 'cloud', 'strike'][+e.key - 1]);
  }
});

/**
 * Camera presets, chosen for the scale of the subject: the channel is
 * five kilometres tall and the cloud deck starts at 1.6 km, so the useful
 * viewpoints are a long way back and close to the ground. Polar angles
 * beyond pi/2 put the observer *below* the point being looked at, which
 * is where you actually stand to watch lightning.
 */
function setCameraPreset(which) {
  const strike = flash?.attachPoint;
  if (which === 'photo') {
    if (photo) photo.scene.applyHomeView(camera, controls, camera.aspect);
    return;
  }
  // Leaving the photograph's viewpoint means orbiting again. Keep the
  // leash short: the reconstruction is a shell around one point, and from
  // far enough away it stops reading as a place at all.
  controls.setLookMode(false);
  if (photo) {
    camera.fov = 52;
    camera.updateProjectionMatrix();
    controls.maxDistance = Math.max(6000, state.photoCloudBase * 5);
    controls.goal.radius = Math.min(controls.goal.radius, controls.maxDistance);
  } else {
    controls.maxDistance = 90000;
  }
  switch (which) {
    case 'wide':
      // Far enough out to see the whole storm, anvil included — but with
      // a photograph loaded, stepping back far enough to see the whole
      // reconstruction means seeing that it is a shell, so stay close.
      if (photo) controls.frame(new THREE.Vector3(0, 1400, -2500), 5200, -0.5, 1.66);
      else controls.frame(new THREE.Vector3(0, 5200, 0), 24000, -0.7, 1.74);
      break;
    case 'cloud':
      // Up among the charge regions, looking at the in-cloud tree.
      controls.frame(new THREE.Vector3(0, 6000, 0), 9500, 0.7, 1.30);
      break;
    case 'strike':
      // Close to the attachment point, looking up the channel.
      controls.frame(
        new THREE.Vector3(strike?.x ?? 240, 320, strike?.y ?? -160),
        900, -1.1, 1.86);
      break;
    default:
      // Standing on the ground about six kilometres off.
      controls.frame(new THREE.Vector3(0, 1900, 0), 6400, 0.55, 1.78);
  }
}
setCameraPreset('ground');

/* ------------------------------------------------------------------ *
 * Frame loop
 * ------------------------------------------------------------------ */

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Reframing the window changes how much of the photograph fits, so the
  // cover field of view has to be recomputed or the edges come apart.
  if (photo && controls.lookMode) {
    const cover = photo.scene.coverFov(camera.aspect);
    controls.maxFov = Math.min(110, cover * 2.4);
    controls.minFov = Math.max(8, cover * 0.25);
  }
  post.setSize(w, h, renderer.getPixelRatio());
  sky.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  bolt.setViewport(w * renderer.getPixelRatio(), h * renderer.getPixelRatio(), camera.fov);
  scope.resize();
}
window.addEventListener('resize', resize);

let last = performance.now();
let smoothedFps = 60;
const fpsEl = document.getElementById('fps');

/** Milliseconds a single frame may spend advancing the physics. */
const PHYSICS_MS_PER_FRAME = 6;
/** Simulated seconds the last frame could not get through, if any. */
let behindRealTime = 0;

/**
 * How fast to run the clock right now.
 *
 * Fixed rates are available, but the default adapts inside the return
 * stroke: the interesting 200 microseconds are the front and the peak,
 * and the millisecond of tail after it is nearly dark. Slowing down while
 * the current is high and speeding through the tail spends the viewer's
 * attention where the physics is.
 */
function rateFor(f) {
  if (state.timeScale !== 'auto') return state.timeScale;
  const base = PHASE_RATE[f.phase] ?? 1e-2;
  if (f.phase === Phase.RETURN_STROKE && f.rs) {
    const rs = f.rs;
    // Run at full slow motion for as long as the front is still climbing
    // the channel, then follow the waveform's own envelope down. Using the
    // waveform rather than the measured base current matters: the current
    // is momentarily near zero at t = 0, and reacting to that would sprint
    // straight past the front the viewer came to see.
    const env = rs.t < rs.maxArrival
      ? 1
      : Math.min(1, rs.wave.current(rs.t) / Math.max(1, rs.peak));
    return base * (1 + 30 * Math.pow(1 - env, 2.5));
  }
  return base;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtWall = Math.min(0.05, (now - last) / 1000);
  last = now;
  smoothedFps += (1 / Math.max(1e-3, dtWall) - smoothedFps) * 0.06;

  /* ---- physics ---- */
  if (flash) {
    const rate = rateFor(flash);
    // Cap the simulated step so a slow frame cannot stride over the
    // microsecond front of a return stroke.
    const maxStep = flash.phase === Phase.RETURN_STROKE ? 40e-6 : 4e-3;
    let budget = dtWall * rate;
    let guard = 0;

    // Bound the physics by wall-clock work, not only by simulated time.
    //
    // At the slow playback rates one frame is a fraction of a leader step
    // and the loop below runs once. Asking for real time is asking for
    // sixteen milliseconds of storm per frame, which can be a hundred
    // growth steps or four hundred return-stroke integrations — a second
    // of computation for a sixtieth of a second of animation. Left
    // unbounded that is not slow motion, it is a freeze.
    //
    // So there is a ceiling on how long a frame may spend, and when it is
    // hit the simulation simply falls behind. Running a 300 ms flash in
    // 500 ms of real time is imperceptible; dropping a one-second frame
    // is not.
    const deadline = performance.now() + PHYSICS_MS_PER_FRAME;
    while (budget > 0 && guard++ < 512) {
      const step = Math.min(budget, maxStep);
      // The deadline goes in as well as being checked out here: a single
      // call can otherwise overrun it several times over on its own.
      budget -= flash.update(step, deadline) || step;
      if (flash.done) break;
      if (performance.now() > deadline) { behindRealTime = budget; break; }
    }
    if (budget <= 0) behindRealTime = 0;

    const T = flash.telemetry();
    scope.push(flash.time, T.current, T.groundField);
    if (flash.phase !== lastLoggedPhase) {
      if (lastLoggedPhase !== null) scope.mark(flash.time, flash.phase);
      lastLoggedPhase = flash.phase;
    }

    // Thunder is scheduled the moment the first stroke fires; the delay
    // built into the impulse response does the rest.
    if (!thunderFired && flash.strokeIndex >= 1 && audioReady) {
      thunderFired = true;
      const listener = {
        x: camera.position.x, y: camera.position.z, z: Math.max(2, camera.position.y),
      };
      thunderReport = audio.play(flash.channel, listener, { gain: 1 });
    }

    if (flash.done) {
      restIdleTime += dtWall;
      const rest = state.restDelay ?? 2.6;
      if (state.autoLoop && Number.isFinite(rest) && restIdleTime > rest) newFlash();
    }

    if (state.followTip && T.leaderAltitude !== null) {
      const ch = flash.channel;
      let lo = -1, lz = Infinity;
      for (const t of flash.leader.tips) {
        if (t.alive && ch.z[t.node] < lz) { lz = ch.z[t.node]; lo = t.node; }
      }
      if (lo >= 0) {
        controls.goalTarget.lerp(
          new THREE.Vector3(ch.x[lo], ch.z[lo], ch.y[lo]), 0.06);
      }
    }

    panel.update(T, { thunder: thunderReport, audioReady });
  }

  /* ---- settings that apply live ---- */
  post.exposure = state.exposure;
  post.bloomStrength = state.bloom;
  bolt.setWidthScale(state.channelWidth);
  bolt.persistenceTau = state.persistence;
  // A photograph's sky sits around half of full scale in linear light,
  // where the procedural night sky sits near a fiftieth. The channel has
  // to be driven far harder to read against the former, so the base level
  // follows the scene rather than making the user discover it.
  bolt.setExposure((photo ? 3.4 : 0.55) * state.channelBrightness);
  sky.material.uniforms.uCoverage.value = state.coverage;
  sky.material.uniforms.uSteps.value = state.cloudSteps;
  rain.setIntensity(state.rain);
  chargeGroup.visible = state.showCharge;

  /* ---- update the drawable channel ---- */
  if (flash) {
    bolt.update(flash.channel, {
      minLum: 0.004,
      maxLights: 8,
      radiusScale: 1,
      dtWall,
    });
  }

  // Each consumer of the bolt's light integrates it differently — the
  // cloud accumulates in-scatter along a ray, the ground takes a single
  // N.L term, the rain is metres away rather than kilometres — so each
  // needs its own gain to land in the same exposure. Calibrated so a
  // median stroke lights the cloud deck to just below clipping and the
  // landscape to about half that, with only the channel itself allowed to
  // blow out.
  if (photo) {
    // Higher than it looks: the soft knee in the photo shader compresses
    // it, so this sets how far out the flash is *felt* rather than how
    // bright it gets at the strike.
    photo.scene.update(camera, bolt.lights, 9.0e4);
    photo.scene.relight = state.photoRelight;
    photo.scene.exposure = 1;
    photo.scene.skyOccludes = state.photoSkyPush === 0;
    photo.scene.debug = state.photoDebug;
    photo.environment.update(camera, bolt.lights, 9.0e4);
    photo.environment.relight = state.photoRelight;
  } else {
    sky.setLights(bolt.lights, 0.55);
    ground.update(camera, bolt.lights, 1.2e4);
    structures.update(camera, bolt.lights, 1.2e4);
  }
  rain.update(camera, now / 1000, bolt.lights, 55);

  controls.update(dtWall);
  bolt.setViewport(renderer.domElement.width, renderer.domElement.height, camera.fov);

  /* ---- draw ---- */
  if (!photo) sky.render(camera, now / 1000);
  renderer.setRenderTarget(post.sceneTarget);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  post.render(now / 1000);

  scope.draw(flash ? flash.time : 0);
  fpsEl.textContent = `${smoothedFps.toFixed(0)} fps  ${bolt.segmentCount || 0} seg` +
    (behindRealTime > 0 ? '  · slower than requested' : '');
}

resize();
// Start from the dial rather than from the literals above, so the two can
// never disagree about what "intensity 10" means.
applyIntensity(false);
newFlash();
requestAnimationFrame(frame);

/* Expose a little for console poking; this is a physics toy, after all. */
window.lightning = {
  state, newFlash, camera, controls,
  get flash() { return flash; },
  get photo() { return photo; },
  get photoInfo() { return lastPhotoInfo; },
  loadPhoto, clearPhoto,
  constants: { CLOUD, FLASH },
};
