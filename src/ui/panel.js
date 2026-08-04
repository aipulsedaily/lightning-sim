/**
 * panel.js — controls and live telemetry.
 *
 * The hard part of this interface is not the physics, it is that most of
 * the physics only takes effect on the *next* flash. Moving a slider that
 * changes how a leader grows does nothing at all to the one already in the
 * sky, and a panel that does not say so reads as broken. So:
 *
 *   - every control is tagged as either live or next-flash, and the
 *     next-flash ones quietly refire once you stop dragging;
 *   - each one leads with what you will see, and keeps the physics for
 *     afterwards;
 *   - the scenarios at the top set several parameters at once and say what
 *     to watch for, so nothing has to be discovered by guessing;
 *   - the readouts carry the measured range they should fall in, because a
 *     number with nothing to compare it against is not information.
 */

const fmt = {
  si(v, unit, digits = 2) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    const a = Math.abs(v);
    const table = [
      [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'],
    ];
    for (const [s, p] of table) {
      if (a >= s || s === 1e-9) return `${(v / s).toFixed(digits)} ${p}${unit}`;
    }
    return `${v} ${unit}`;
  },
  time(v) {
    if (!Number.isFinite(v)) return '-';
    if (v < 1e-3) return `${(v * 1e6).toFixed(1)} us`;
    if (v < 1) return `${(v * 1e3).toFixed(1)} ms`;
    return `${v.toFixed(3)} s`;
  },
};

/** One line of plain English for whatever the flash is doing right now. */
const PHASE_STORY = {
  'idle': 'Waiting.',
  'initiation': 'The ambient field has beaten its local threshold. A leader is about to start.',
  'leader': 'A stepped leader is feeling its way down. Watch the channel potential fall: ' +
    'the end climbing inside the cloud is tapping the negative charge, and that is what ' +
    'lets the downward end move at all.',
  'attachment': 'Something on the ground has answered. An upward leader is climbing to ' +
    'meet the descending one, and where they meet is where the bolt lands.',
  'return-stroke': 'Connected. The channel is shorted to earth and a wave of ' +
    'neutralisation is racing back up it at a third of the speed of light.',
  'interstroke': 'Dark. The channel is cooling but still conducting, and another leader ' +
    'is already on its way down it.',
  'dart-leader': 'A dart leader is retracing the warm channel about a hundred times ' +
    'faster than the first one managed, and without branching.',
  'continuing-current': 'A steady couple of hundred amps is still flowing down the ' +
    'channel. This is the part that sets fires.',
  'done': 'Flash over.',
};

/**
 * Scenarios. Each one sets several parameters at once, refires, and says
 * what to look for — so the panel can be understood by clicking rather
 * than by reading.
 */
const SCENARIOS = [
  {
    name: 'Classic strike',
    watch: 'The standard event. A branched leader gropes down for 40 ms, an upward ' +
      'leader rises off the ground to meet it, and three to five strokes follow down ' +
      'the same channel over the next quarter second.',
    camera: 'ground',
    state: {
      flashType: 'negative-cg', stormIntensity: 1.0, thresholdScale: 1.0,
      eta: 3.0, branchiness: 0.10, stepLength: 26, leaderSpeed: 2.0e5,
      timeScale: 'auto',
    },
  },
  {
    name: 'Too weak to flash',
    watch: 'The charge is turned down until the field never reaches the inception ' +
      'threshold anywhere in the cloud, so nothing happens. This is what a thunderstorm ' +
      'is doing most of the time.',
    camera: 'ground',
    state: { flashType: 'negative-cg', stormIntensity: 0.72, timeScale: 'auto' },
  },
  {
    name: 'Single filament',
    watch: 'A sharp growth rule. The discharge takes only its very best option at every ' +
      'step and collapses to one thread with almost no branches.',
    camera: 'ground',
    state: {
      flashType: 'negative-cg', stormIntensity: 1.0,
      eta: 6.0, branchiness: 0.015, timeScale: 'auto',
    },
  },
  {
    name: 'Root system',
    watch: 'A soft growth rule. Bonds that came close to winning get taken too, and the ' +
      'leader spreads into a thicket on its way down.',
    camera: 'ground',
    state: {
      flashType: 'negative-cg', stormIntensity: 1.0,
      eta: 1.0, branchiness: 0.32, timeScale: 'auto',
    },
  },
  {
    name: 'Anvil positive',
    watch: 'A sheared storm whose anvil has blown downwind. The leader that comes down is ' +
      'positive, so it needs a weaker field, barely branches, and moves several times the ' +
      'charge of a negative flash in a single stroke.',
    camera: 'wide',
    state: {
      flashType: 'positive-cg', stormIntensity: 1.0,
      eta: 3.0, branchiness: 0.10, timeScale: 'auto',
    },
  },
  {
    name: 'Never reaches ground',
    watch: 'An intracloud discharge, spreading through the cloud between the negative and ' +
      'upper positive charge. Three out of four real flashes look like this and light the ' +
      'cloud from inside rather than striking anything.',
    camera: 'wide',
    state: {
      flashType: 'intracloud', stormIntensity: 1.0,
      eta: 3.0, branchiness: 0.12, timeScale: 'auto',
    },
  },
  {
    name: 'Count the seconds',
    watch: 'Backed off to watch from a distance. Turn sound on and count between the flash ' +
      'and the bang: the delay is the real travel time, and the rumble is the length of ' +
      'the channel arriving in the order the geometry dictates.',
    camera: 'wide',
    state: {
      flashType: 'negative-cg', stormIntensity: 1.0, rain: 0.25,
      eta: 3.0, branchiness: 0.10, timeScale: 'auto',
    },
  },
];

export class Panel {
  /**
   * @param {HTMLElement} root
   * @param {object} state    shared settings object, mutated in place
   * @param {object} hooks    {onRestrike, onAudio, onCamera}
   */
  constructor(root, state, hooks = {}) {
    this.root = root;
    this.state = state;
    this.hooks = hooks;
    this.readouts = {};
    this.controls = [];
    this._refireTimer = null;
    this.build();
  }

  /* ---------------- element helpers ---------------- */

  el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /**
   * A control that changes how the discharge grows cannot affect the flash
   * already in the air. Rather than leaving the user to work that out,
   * refire shortly after they stop moving things.
   */
  scheduleRefire() {
    clearTimeout(this._refireTimer);
    this.root.classList.add('refiring');
    this._refireTimer = setTimeout(() => {
      this.root.classList.remove('refiring');
      this.hooks.onRestrike?.();
    }, 450);
  }

  /** Coalesce a burst of slider moves into one reconstruction. */
  schedulePhotoRebuild() {
    clearTimeout(this._photoTimer);
    this._photoTimer = setTimeout(() => this.hooks.onPhotoRebuild?.(), 160);
  }

  /** Progress and diagnostics for the photo pipeline. */
  setPhotoStatus(text, kind = '') {
    if (!this.photoStatus) return;
    this.photoStatus.textContent = text;
    this.photoStatus.className = `pstatus ${kind}`;
  }

  /**
   * Reveal the photo controls. Dropping a file onto the window is the
   * obvious way in, and it would be perverse for the resulting status and
   * calibration to stay folded away where the user cannot see them.
   */
  openPhotoSection() {
    document.body.classList.remove('panel-closed', 'ui-hidden');
    const details = this.photoStatus?.closest('details');
    if (details) {
      details.open = true;
      details.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  section(title, opts = {}) {
    const d = this.el('details', 'sec');
    d.open = opts.open !== false;
    const s = this.el('summary');
    s.appendChild(this.el('span', 'sectitle', title));
    if (opts.applies) {
      s.appendChild(this.el('span', `badge ${opts.applies}`,
        opts.applies === 'live' ? 'live' : 'next flash'));
    }
    d.appendChild(s);
    const body = this.el('div', 'secbody');
    d.appendChild(body);
    if (opts.note) body.appendChild(this.el('p', 'note', opts.note));
    this.root.appendChild(d);
    return body;
  }

  slider(parent, o) {
    const row = this.el('div', 'row');
    const head = this.el('div', 'rowhead');
    const label = this.el('span', 'lbl', o.label);
    const val = this.el('span', 'val');
    head.append(label, val);

    const input = this.el('input');
    input.type = 'range';
    input.min = o.min; input.max = o.max;
    input.step = o.step ?? (o.max - o.min) / 200;

    const sync = () => {
      const v = o.get();
      input.value = v;
      val.textContent = o.format ? o.format(v) : v.toFixed(2);
    };
    input.addEventListener('input', () => {
      o.set(parseFloat(input.value));
      sync();
      if (o.refire) this.scheduleRefire();
      if (o.rebuildPhoto) this.schedulePhotoRebuild();
      o.onChange?.(parseFloat(input.value));
    });
    sync();

    row.append(head, input);
    if (o.what) row.appendChild(this.el('div', 'what', o.what));
    if (o.why) row.appendChild(this.el('div', 'hint', o.why));
    parent.appendChild(row);
    this.controls.push({ sync });
    return { input, sync };
  }

  toggle(parent, o) {
    const row = this.el('div', 'row check');
    const id = 'chk' + Math.random().toString(36).slice(2, 8);
    const input = this.el('input');
    input.type = 'checkbox';
    input.id = id;
    const sync = () => { input.checked = o.get(); };
    sync();
    input.addEventListener('change', () => {
      o.set(input.checked);
      if (o.refire) this.scheduleRefire();
    });
    const label = this.el('label', null, o.label);
    label.htmlFor = id;
    row.append(input, label);
    if (o.what) row.appendChild(this.el('div', 'what', o.what));
    parent.appendChild(row);
    this.controls.push({ sync });
    return input;
  }

  choice(parent, o) {
    const row = this.el('div', 'row');
    row.appendChild(this.el('div', 'lbl', o.label));
    const group = this.el('div', 'chips');
    const buttons = [];
    for (const opt of o.options) {
      const b = this.el('button', 'chip', opt.label);
      b.addEventListener('click', () => {
        o.set(opt.value);
        sync();
        if (o.refire) this.scheduleRefire();
        o.onChange?.(opt.value);
      });
      group.appendChild(b);
      buttons.push({ b, value: opt.value });
    }
    const sync = () => {
      const cur = o.get();
      for (const x of buttons) x.b.classList.toggle('on', x.value === cur);
    };
    sync();
    row.appendChild(group);
    if (o.what) row.appendChild(this.el('div', 'what', o.what));
    if (o.why) row.appendChild(this.el('div', 'hint', o.why));
    parent.appendChild(row);
    this.controls.push({ sync });
    return buttons;
  }

  button(parent, label, fn, cls) {
    const b = this.el('button', `btn ${cls || ''}`, label);
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
  }

  /** A readout row, optionally carrying the range it ought to fall in. */
  readout(parent, key, label, typical) {
    const row = this.el('div', 'ro');
    const left = this.el('div', 'roleft');
    left.appendChild(this.el('span', 'rolbl', label));
    if (typical) left.appendChild(this.el('span', 'roref', typical));
    const v = this.el('span', 'roval', '-');
    row.append(left, v);
    parent.appendChild(row);
    this.readouts[key] = v;
    return v;
  }

  syncAll() { for (const c of this.controls) c.sync(); }

  applyScenario(s) {
    Object.assign(this.state, s.state);
    this.syncAll();
    this.scenarioNote.textContent = s.watch;
    for (const b of this.scenarioButtons) b.classList.toggle('on', b.textContent === s.name);
    this.hooks.onCamera?.(s.camera);
    clearTimeout(this._refireTimer);
    this.root.classList.remove('refiring');
    this.hooks.onRestrike?.();
  }

  /* ---------------- layout ---------------- */

  build() {
    const S = this.state;

    /* -------- what is happening right now --------
     * The narration and the scenarios come first because they are what
     * orient someone who has just opened this. The wall of numbers is
     * more useful, but only once you know what you are looking at. */
    /* -------- the one dial that matters -------- */
    const master = this.el('div', 'master');
    const mhead = this.el('div', 'rowhead');
    mhead.append(this.el('span', 'mlbl', 'Storm intensity'),
      this.el('span', 'mval', String(S.intensity)));
    const mInput = this.el('input');
    mInput.type = 'range';
    mInput.min = 0; mInput.max = 100; mInput.step = 1;
    mInput.value = S.intensity;
    mInput.className = 'master-range';
    const mSync = () => {
      mInput.value = S.intensity;
      mhead.lastChild.textContent = Math.round(S.intensity);
    };
    mInput.addEventListener('input', () => {
      S.intensity = parseFloat(mInput.value);
      mSync();
      this.hooks.onIntensity?.();
    });
    const scale = this.el('div', 'mscale');
    scale.append(this.el('span', null, 'nothing'), this.el('span', null, 'quiet'),
      this.el('span', null, 'violent'));
    master.append(mhead, mInput, scale);
    master.appendChild(this.el('div', 'what',
      'Drives the whole storm at once: how much charge it holds, how readily it ' +
      'breaks down, how much it branches, how many strokes each flash gets and how ' +
      'often they come. At 0 the field never reaches its inception threshold and ' +
      'nothing can happen at all. Everything below is still yours to override.'));
    this.root.appendChild(master);
    this.controls.push({ sync: mSync });

    this.storyEl = this.el('p', 'story', PHASE_STORY.idle);
    this.root.appendChild(this.storyEl);

    const scen = this.section('Try one of these', { applies: 'live' });
    const scenBar = this.el('div', 'bar');
    scen.appendChild(scenBar);
    this.scenarioButtons = [];
    for (const s of SCENARIOS) {
      this.scenarioButtons.push(
        this.button(scenBar, s.name, () => this.applyScenario(s), 'scen'));
    }
    this.scenarioNote = this.el('p', 'watch',
      'Each one sets the storm and the growth rule together, points the camera, ' +
      'and fires. Pick one to see what to look for.');
    scen.appendChild(this.scenarioNote);

    const live = this.section('Readings', { applies: 'live' });
    const grid = this.el('div', 'grid');
    live.appendChild(grid);
    this.readout(grid, 'phase', 'Stage');
    this.readout(grid, 'time', 'Elapsed', 'whole flash 0.2-1 s');
    this.readout(grid, 'altitude', 'Leader tip height');
    this.readout(grid, 'speed', 'Descent speed', 'observed 1-25 x10^5 m/s');
    this.readout(grid, 'potential', 'Channel potential', 'falls as the cloud end feeds it');
    this.readout(grid, 'charge', 'Charge separated', 'leader carries 3-20 C');
    this.readout(grid, 'net', 'Net charge on it',
      'zero while it floats; the stroke breaks that');
    this.readout(grid, 'bond', 'Field vs threshold', 'below it, the leader stalls');
    this.readout(grid, 'groundE', 'Field at the ground', 'fair weather is -0.1 kV/m');
    this.readout(grid, 'strike', 'Striking distance', 'Love: 10 I^0.65 metres');
    this.readout(grid, 'current', 'Current now');
    this.readout(grid, 'peak', 'Peak current', 'median 30 kA first, 12 kA after');
    this.readout(grid, 'temp', 'Peak temperature', 'measured 28-34 kK');
    this.readout(grid, 'transfer', 'Charge moved', '5-25 C per flash');
    this.readout(grid, 'strokes', 'Strokes', 'mean 3-5, up to 26 recorded');
    this.readout(grid, 'geometry', 'Channel drawn');
    this.readout(grid, 'thunder', 'Thunder', '~3 s per kilometre');

    const log = this.el('div', 'log');
    this.logEl = log;
    live.appendChild(log);

    /* -------- trigger -------- */
    const act = this.section('Fire', { applies: 'live' });
    const bar2 = this.el('div', 'bar');
    act.appendChild(bar2);
    this.button(bar2, 'New flash', () => this.hooks.onRestrike?.(), 'primary');
    this.button(bar2, 'Replay this one', () => this.hooks.onRestrike?.(true));
    this.button(bar2, 'Enable sound', async (e) => {
      const ok = await this.hooks.onAudio?.();
      e.target.textContent = ok ? 'Sound on' : 'Sound unavailable';
      e.target.classList.toggle('on', !!ok);
    });

    this.choice(act, {
      label: 'Kind of flash',
      get: () => S.flashType,
      set: (v) => { S.flashType = v; },
      refire: true,
      options: [
        { label: 'To ground', value: 'negative-cg' },
        { label: 'Positive', value: 'positive-cg' },
        { label: 'In cloud', value: 'intracloud' },
      ],
      what: 'To ground is the ordinary bolt. In cloud never touches anything and is ' +
        'three quarters of all real flashes.',
      why: 'This is less a setting than a consequence: each kind uses the charge ' +
        'structure that actually produces it. A positive flash needs a sheared storm ' +
        'whose anvil has been carried downwind, because otherwise the leader would ' +
        'have to cross the main negative charge to reach the ground.',
    });

    this.choice(act, {
      label: 'Playback speed',
      get: () => S.timeScale,
      set: (v) => { S.timeScale = v; },
      options: [
        { label: 'Auto', value: 'auto' },
        { label: 'Real time', value: 1 },
        { label: '1:100', value: 0.01 },
        { label: '1:10k', value: 1e-4 },
        { label: '1:1M', value: 1e-6 },
      ],
      what: 'Auto gives each stage its own rate so all of them are watchable. Real time ' +
        'is over before you see it.',
      why: 'A whole flash lasts a few hundred milliseconds, the leader tens of ' +
        'milliseconds, the return stroke tens of microseconds. Nothing short of a ' +
        'millionth of real time shows the front travelling up the channel.',
    });

    this.toggle(act, {
      label: 'Keep firing automatically',
      get: () => S.autoLoop, set: (v) => { S.autoLoop = v; },
    });

    /* -------- photograph -------- */
    const photo = this.section('Put it in a photo', {
      applies: 'live', open: false,
      note: 'Drop a photograph in and it is unprojected into a 3-D scene the ' +
        'lightning can stand inside: behind the clouds, in front of the headland, ' +
        'lighting the water. A single image has no depth in it, so the horizon is ' +
        'found and the rest is inferred - see the notes on each control for what ' +
        'is being assumed.',
    });

    const dropRow = this.el('div', 'drop');
    dropRow.appendChild(this.el('span', null, 'Drop an image here, or'));
    const fileBtn = this.el('button', 'btn primary', 'Choose a photo');
    const fileInput = this.el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) this.hooks.onPhotoFile?.(fileInput.files[0]);
    });
    fileBtn.addEventListener('click', () => fileInput.click());
    dropRow.append(fileBtn, fileInput);
    photo.appendChild(dropRow);
    this.dropZone = dropRow;

    this.photoStatus = this.el('p', 'pstatus', 'No photo loaded.');
    photo.appendChild(this.photoStatus);

    const pbar = this.el('div', 'bar');
    photo.appendChild(pbar);
    this.button(pbar, 'Back to the photo view', () => this.hooks.onCamera?.('photo'));
    this.button(pbar, 'Remove photo', () => this.hooks.onPhotoClear?.());

    this.choice(photo, {
      label: 'Where depth comes from',
      get: () => S.photoDepthSource,
      set: (v) => { S.photoDepthSource = v; },
      onChange: () => this.hooks.onPhotoRebuild?.(true),
      options: [
        { label: 'Geometric', value: 'geometric' },
        { label: 'AI refine', value: 'neural' },
      ],
      what: 'Geometric is instant and needs nothing downloaded. AI refine fetches a ' +
        '18 MB depth model once, then gives real relief on terrain, buildings and ' +
        'people instead of a flat plane.',
      why: 'The network returns depth without a scale - it can rank pixels but not ' +
        'measure them. The geometric solution stays in either case, because it is ' +
        'what converts that ranking into metres, and a bolt five kilometres tall ' +
        'needs metres.',
    });

    this.choice(photo, {
      label: 'Lens',
      get: () => S.photoProjection,
      set: (v) => { S.photoProjection = v; },
      onChange: () => this.hooks.onPhotoRebuild?.(),
      options: [
        { label: 'Detect', value: 'auto' },
        { label: 'Normal', value: 'rectilinear' },
        { label: 'Panorama', value: 'cylindrical' },
      ],
      what: 'A stitched panorama is wrapped round a cylinder, not flattened onto a ' +
        'plane, so its horizon bows. Unprojecting one as a normal lens bends the ' +
        'world the other way.',
    });

    // Calibration sliders rebuild the reconstruction, not the flash. The
    // expensive stages are cached, so this is a few milliseconds even
    // when the neural model is in use.
    const pslide = (o) => this.slider(photo, { ...o, rebuildPhoto: true });
    pslide({
      label: 'Horizon', min: 0.02, max: 0.98, step: 0.002,
      get: () => S.photoHorizon, set: (v) => { S.photoHorizon = v; },
      format: (v) => `${(v * 100).toFixed(1)}% down`,
      what: 'The single most important control. It sets which way the camera was ' +
        'pointing, and everything else is measured from it. Nudge it until the ' +
        'water or the ground looks flat rather than tilted.',
    });
    pslide({
      label: 'Field of view', min: 20, max: 110, step: 0.5,
      get: () => S.photoFov, set: (v) => { S.photoFov = v; },
      format: (v) => `${v.toFixed(0)} deg`,
      what: 'Vertical angle the frame covers. Unrecoverable from the pixels, so it ' +
        'is a guess: about 45-60 for a phone, less for a zoom.',
    });
    pslide({
      label: 'Camera height', min: 1, max: 400, step: 1,
      get: () => S.photoCameraHeight, set: (v) => { S.photoCameraHeight = v; },
      format: (v) => `${v.toFixed(0)} m`,
      what: 'How high above the ground the photo was taken. This is the scale of the ' +
        'whole reconstruction: double it and everything below the horizon doubles ' +
        'in distance.',
    });
    pslide({
      label: 'Cloud base', min: 200, max: 6000, step: 50,
      get: () => S.photoCloudBase, set: (v) => { S.photoCloudBase = v; },
      format: (v) => `${(v / 1000).toFixed(2)} km`,
      what: 'Altitude the sky is placed at. Sets how far away the clouds are, and so ' +
        'how big the storm looks against them.',
    });
    pslide({
      label: 'Horizon distance', min: 2000, max: 90000, step: 500,
      get: () => S.photoMaxRange, set: (v) => { S.photoMaxRange = v; },
      format: (v) => `${(v / 1000).toFixed(0)} km`,
      what: 'Where the far distance piles up into a curtain. Distant hills and ' +
        'skylines end up standing on it.',
    });
    pslide({
      label: 'Relief', min: 0, max: 0.6, step: 0.01,
      get: () => S.photoRelief, set: (v) => { S.photoRelief = v; },
      format: (v) => v === 0 ? 'flat' : v.toFixed(2),
      what: 'Bulges brighter parts of the image towards you. A weak cue, and the only ' +
        'one available without the AI model.',
    });
    pslide({
      label: 'Tear at depth jumps', min: 1.2, max: 12, step: 0.1,
      get: () => S.photoTear, set: (v) => { S.photoTear = v; },
      format: (v) => v >= 11.9 ? 'never' : `${v.toFixed(1)}x`,
      what: 'Where a near thing meets a far thing, the mesh either tears or stretches ' +
        'into a rubber sheet. Tearing looks like a real silhouette; stretching looks ' +
        'like melted plastic. Only matters once you move off the photo view.',
    });
    pslide({
      label: 'Flash lights the photo', min: 0, max: 4, step: 0.05,
      get: () => S.photoRelight, set: (v) => { S.photoRelight = v; },
      format: (v) => v === 0 ? 'off' : `x${v.toFixed(2)}`,
      what: 'How hard the bolt lights the scene. The photo is treated as the colour ' +
        'of each surface, and the flash is added on top, so at zero you get the ' +
        'original image back exactly.',
    });
    this.choice(photo, {
      label: 'Lightning against the sky',
      get: () => S.photoSkyPush,
      set: (v) => { S.photoSkyPush = v; },
      options: [
        { label: 'In front', value: 1 },
        { label: 'Behind clouds', value: 0 },
      ],
      what: 'The photo\'s sky sits on one deck a kilometre or two up, which is below ' +
        'most of a storm. In front treats it as a backdrop so the discharge is ' +
        'visible; behind lets the cloud hide it, which is truer but often means ' +
        'seeing nothing but a glow.',
      why: 'Either way the ground, the headland and anything in the foreground keep ' +
        'their real depth and go on occluding the channel properly.',
    });

    this.choice(photo, {
      label: 'Show me',
      get: () => S.photoDebug,
      set: (v) => { S.photoDebug = v; },
      options: [
        { label: 'Photo', value: 0 },
        { label: 'Depth', value: 1 },
        { label: 'Sky mask', value: 2 },
        { label: 'Normals', value: 3 },
      ],
      what: 'What the pipeline worked out. Depth and the sky mask are the two things ' +
        'worth checking if a scene looks wrong.',
    });

    /* -------- the storm -------- */
    const storm = this.section('Storm', {
      applies: 'next',
      note: 'The charge in the cloud. Everything else follows from it, so these take ' +
        'effect on the next flash — which fires by itself a moment after you let go.',
    });
    this.slider(storm, {
      label: 'How much charge', min: 0.4, max: 1.8, step: 0.02, refire: true,
      get: () => S.stormIntensity, set: (v) => { S.stormIntensity = v; },
      format: (v) => `x${v.toFixed(2)}`,
      what: 'Turn it down and flashes get rarer, weaker and stay in the cloud. Below ' +
        'about 0.9 the storm cannot flash at all.',
      why: 'Scales all three charge regions together. The ambient field has to beat the ' +
        'inception threshold somewhere or nothing starts — the real reason storms have ' +
        'quiet spells.',
    });
    this.slider(storm, {
      label: 'How hard air is to break', min: 0.6, max: 1.6, step: 0.02, refire: true,
      get: () => S.thresholdScale, set: (v) => { S.thresholdScale = v; },
      format: (v) => `x${v.toFixed(2)}`,
      what: 'Lower it and leaders travel further and branch more freely; raise it and ' +
        'they stall.',
      why: 'Multiplies the density-scaled inception and propagation fields. The published ' +
        'values carry real uncertainty; this is the knob for it.',
    });
    this.slider(storm, {
      label: 'Rain', min: 0, max: 1, step: 0.02,
      get: () => S.rain, set: (v) => { S.rain = v; },
      format: (v) => v === 0 ? 'none' : `${(v * 100) | 0}%`,
      what: 'Visual only. The streaks light up when the flash does.',
    });
    this.slider(storm, {
      label: 'Cloud thickness', min: 0.3, max: 0.85, step: 0.01,
      get: () => S.coverage, set: (v) => { S.coverage = v; },
      format: (v) => v.toFixed(2),
      what: 'How much of the sky the storm deck fills.',
    });

    /* -------- growth rule -------- */
    const disc = this.section('How the channel grows', {
      applies: 'next', open: false,
      note: 'The Dielectric Breakdown Model. At every step the leader looks at the field ' +
        'in each direction it could go and picks one at random, weighted by ' +
        '(E - threshold) raised to the power eta.',
    });
    this.slider(disc, {
      label: 'eta — how fussy each step is', min: 0.5, max: 6, step: 0.05, refire: true,
      get: () => S.eta, set: (v) => { S.eta = v; },
      format: (v) => v.toFixed(2),
      what: 'Low: the leader wanders and spreads into a thicket. High: it takes the single ' +
        'best direction every time and becomes one clean thread.',
      why: 'eta = 1 reproduces diffusion-limited aggregation; large eta collapses the ' +
        'structure to a filament. Photographed channels sit near a fractal dimension ' +
        'of 1.1 to 1.4.',
    });
    this.slider(disc, {
      label: 'How readily it forks', min: 0, max: 0.5, step: 0.005, refire: true,
      get: () => S.branchiness, set: (v) => { S.branchiness = v; },
      format: (v) => v === 0 ? 'never' : v.toFixed(3),
      what: 'Chance that a step also takes its next-best direction and starts a branch.',
      why: 'Negative leaders branch several times more readily than positive ones, and ' +
        'that asymmetry is applied on top of this.',
    });
    this.slider(disc, {
      label: 'Step length', min: 8, max: 60, step: 1, refire: true,
      get: () => S.stepLength, set: (v) => { S.stepLength = v; },
      format: (v) => `${v.toFixed(0)} m`,
      what: 'Coarse steps give a blocky channel; fine steps a wandering one, and cost more.',
      why: 'At sea level, scaled up with altitude by the falling air density. Real steps ' +
        'run 3 to 200 m and shorten near the ground.',
    });
    this.slider(disc, {
      label: 'Leader speed', min: 5e4, max: 1.2e6, step: 1e4, refire: true,
      get: () => S.leaderSpeed, set: (v) => { S.leaderSpeed = v; },
      format: (v) => `${(v / 1e5).toFixed(1)} x10^5 m/s`,
      what: 'Only changes the clock, not the shape: how long the descent takes.',
      why: 'Streak photography gives 1 to 25 x10^5 m/s, median about 2.',
    });

    /* -------- look -------- */
    const view = this.section('Look', { applies: 'live', open: false });
    this.slider(view, {
      label: 'Brightness', min: 0.2, max: 3, step: 0.02,
      get: () => S.exposure, set: (v) => { S.exposure = v; },
      format: (v) => `${v.toFixed(2)}`,
      what: 'Overall exposure, as on a camera.',
    });
    this.slider(view, {
      label: 'Glare', min: 0, max: 2.5, step: 0.02,
      get: () => S.bloom, set: (v) => { S.bloom = v; },
      format: (v) => v.toFixed(2),
      what: 'The halo around the channel.',
      why: 'A return stroke is some ten orders of magnitude brighter than the cloud ' +
        'behind it. Every real lens and every real eye scatters that into a halo, and ' +
        'without it a correct channel looks like wire.',
    });
    this.slider(view, {
      label: 'Channel brightness', min: 0.2, max: 5, step: 0.05,
      get: () => S.channelBrightness, set: (v) => { S.channelBrightness = v; },
      format: (v) => `x${v.toFixed(2)}`,
      what: 'Turn this up if the streak is hard to pick out. It is set much higher ' +
        'automatically over a photograph, because a daylit sky is a far brighter ' +
        'background to beat than a night one.',
    });
    this.slider(view, {
      label: 'Channel thickness', min: 0.3, max: 3, step: 0.05,
      get: () => S.channelWidth, set: (v) => { S.channelWidth = v; },
      format: (v) => `x${v.toFixed(2)}`,
      what: 'The real channel is a couple of centimetres across; it looks metres wide ' +
        'only because it is so overexposed.',
    });
    this.slider(view, {
      label: 'Eye persistence', min: 0, max: 0.5, step: 0.005,
      get: () => S.persistence, set: (v) => { S.persistence = v; },
      format: (v) => v === 0 ? 'off' : `${(v * 1000) | 0} ms`,
      what: 'Turn it off during a stroke to see what the channel is really doing instant ' +
        'by instant. It will flicker and mostly be dark.',
      why: 'The eye integrates over about a tenth of a second, which is the only reason ' +
        'anyone perceives a 200 microsecond return stroke as a bolt at all.',
    });
    this.slider(view, {
      label: 'Cloud detail', min: 12, max: 64, step: 2,
      get: () => S.cloudSteps, set: (v) => { S.cloudSteps = v; },
      format: (v) => `${v} steps`,
      what: 'Lower this first if the frame rate suffers — the cloud is the most ' +
        'expensive thing on screen.',
    });
    this.toggle(view, {
      label: 'Show the charge in the cloud',
      get: () => S.showCharge, set: (v) => { S.showCharge = v; },
      what: 'Draws the three charge regions (red positive, blue negative) and marks ' +
        'where the flash started.',
    });
    this.toggle(view, {
      label: 'Follow the leader tip',
      get: () => S.followTip, set: (v) => { S.followTip = v; },
      what: 'The camera tracks the lowest live tip on its way down.',
    });

    const cam = this.el('div', 'bar');
    view.appendChild(cam);
    for (const [label, key] of [
      ['On the ground', 'ground'], ['Far off', 'wide'],
      ['Up in the cloud', 'cloud'], ['At the strike', 'strike'],
    ]) {
      this.button(cam, label, () => this.hooks.onCamera?.(key));
    }
  }

  /* ---------------- per-frame refresh ---------------- */

  update(T, extra = {}) {
    const R = this.readouts;
    const set = (k, v) => { if (R[k]) R[k].textContent = v; };

    if (this._lastPhase !== T.phase) {
      this._lastPhase = T.phase;
      this.storyEl.textContent = PHASE_STORY[T.phase] || '';
    }

    set('phase', T.phase);
    set('time', fmt.time(T.time));
    set('altitude', T.leaderAltitude === null ? 'attached'
      : `${(T.leaderAltitude / 1000).toFixed(2)} km`);
    set('speed', T.leaderSpeed ? `${(T.leaderSpeed / 1e5).toFixed(2)} x10^5 m/s` : '-');
    set('potential', `${(T.floatingPotential / 1e6).toFixed(1)} MV`);
    set('charge', `${T.channelCharge.toFixed(2)} C`);
    set('net', Math.abs(T.netCharge) < 1e-3
      ? `${T.netCharge.toExponential(1)} C`
      : `${T.netCharge.toFixed(2)} C`);
    set('bond', `${(T.bondField / 1e3).toFixed(0)} / ${(T.threshold / 1e3).toFixed(0)} kV/m`);
    set('groundE', `${(T.groundField / 1e3).toFixed(2)} kV/m`);
    set('strike', T.strikingDistance ? `${T.strikingDistance.toFixed(0)} m` : '-');
    set('current', T.current > 1 ? fmt.si(T.current, 'A', 1) : '-');
    set('peak', T.peakCurrent > 0 ? `${(T.peakCurrent / 1e3).toFixed(1)} kA` : '-');
    set('temp', T.peakTemp > 0 ? `${(T.peakTemp / 1000).toFixed(1)} kK` : '-');
    set('transfer', `${T.chargeTransferred.toFixed(2)} C`);
    set('strokes', `${T.strokeIndex} of ${T.plannedStrokes}`);
    set('geometry', `${T.nodes} nodes, ${(T.channelLength / 1000).toFixed(1)} km`);
    set('thunder', extra.thunder
      ? `${extra.thunder.delay.toFixed(1)} s away, ` +
        `${extra.thunder.duration.toFixed(1)} s of rumble`
      : (extra.audioReady ? 'listening' : 'sound off'));

    if (T.events && T.events.length !== this._lastLogLen) {
      this._lastLogLen = T.events.length;
      const lines = T.events.slice(-9).map((e) => {
        const line = this.el('div', 'logline');
        line.appendChild(this.el('span', 'logt', `${(e.t * 1e3).toFixed(1)} ms`));
        line.appendChild(this.el('span', null, e.msg));
        return line;
      });
      this.logEl.replaceChildren(...lines);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }
}
