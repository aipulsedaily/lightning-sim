/**
 * controls.js — orbit and fly camera, written here rather than imported.
 *
 * three.js ships OrbitControls in examples/jsm, but this project takes
 * nothing but the core library, so the camera is a few dozen lines of
 * spherical arithmetic. It also lets the controls know about the scale
 * of the scene: pan and zoom speeds are proportional to distance, which
 * matters when the subject spans from a 100 m mast to a 13 km cloud top.
 */

import * as THREE from 'three';

const EPS = 1e-5;

export class OrbitCamera {
  constructor(camera, dom, opts = {}) {
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3(0, opts.targetHeight ?? 2200, 0);
    this.minDistance = opts.minDistance ?? 60;
    this.maxDistance = opts.maxDistance ?? 60000;
    this.minPolar = 0.03;
    // Allow the camera below the orbit target. Watching a five-kilometre
    // channel means standing on the ground and looking at a point a mile
    // up, which a conventional half-sphere clamp forbids.
    this.maxPolar = Math.PI * 0.93;
    this.minHeight = opts.minHeight ?? 3;
    this.damping = opts.damping ?? 0.12;
    this.rotateSpeed = opts.rotateSpeed ?? 0.0042;
    this.zoomSpeed = opts.zoomSpeed ?? 0.0012;

    const off = new THREE.Vector3().subVectors(camera.position, this.target);
    this.sph = new THREE.Spherical().setFromVector3(off);
    this.goal = { radius: this.sph.radius, theta: this.sph.theta, phi: this.sph.phi };
    this.goalTarget = this.target.clone();

    this._drag = null;
    this._pointers = new Map();
    this._pinch = 0;
    this.enabled = true;

    /**
     * Orbiting is the wrong verb at a photograph's own viewpoint.
     *
     * The reconstruction is only valid from where the picture was taken,
     * and orbiting a target a kilometre out swings the camera hundreds of
     * metres sideways for a small drag — straight into the stretched
     * geometry behind every foreground object. In look mode the camera
     * stays where the photographer stood and the *view direction* turns,
     * which is what anyone actually wants to do with a photograph, and
     * which keeps the reconstruction honest.
     */
    this.lookMode = false;
    this.anchor = new THREE.Vector3();
    this.minFov = 12;
    this.maxFov = 100;

    this._bind();
  }

  /** Stand at a point and look around from it, rather than orbit. */
  setLookMode(on, anchor) {
    this.lookMode = !!on;
    if (anchor) this.anchor.copy(anchor);
    if (on) {
      // Preserve where we are currently looking.
      const off = new THREE.Vector3().subVectors(this.anchor, this.target);
      if (off.lengthSq() < 1) off.set(0, 0, 1);
      this.sph.setFromVector3(off);
      this.goal.radius = this.sph.radius;
      this.goal.theta = this.sph.theta;
      this.goal.phi = this.sph.phi;
    }
  }

  _bind() {
    const d = this.dom;
    d.style.touchAction = 'none';
    d.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      d.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._drag = { x: e.clientX, y: e.clientY, button: e.button };
    });
    d.addEventListener('pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      const prev = this._pointers.get(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size >= 2) { this._handlePinch(); return; }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      const pan = this._drag && (this._drag.button === 2 || e.shiftKey);
      if (pan) this._pan(dx, dy);
      else {
        this.goal.theta -= dx * this.rotateSpeed;
        this.goal.phi -= dy * this.rotateSpeed;
      }
    });
    const end = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size === 0) this._drag = null;
      this._pinch = 0;
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      if (this.lookMode) {
        // Standing still, the only meaningful zoom is the lens.
        const f = this.camera.fov * Math.exp(e.deltaY * this.zoomSpeed * 0.8);
        this.camera.fov = THREE.MathUtils.clamp(f, this.minFov, this.maxFov);
        this.camera.updateProjectionMatrix();
        return;
      }
      this.goal.radius *= Math.exp(e.deltaY * this.zoomSpeed);
    }, { passive: false });
  }

  _handlePinch() {
    const pts = [...this._pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (this._pinch > 0) this.goal.radius *= this._pinch / Math.max(1, d);
    this._pinch = d;
  }

  _pan(dx, dy) {
    // Screen-space pan scaled so a pixel always moves the same fraction of
    // the visible frame, whatever the distance.
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const h = this.dom.clientHeight || 1;
    const scale = 2 * Math.tan(fov / 2) * this.goal.radius / h;
    const m = this.camera.matrix;
    const right = new THREE.Vector3(m.elements[0], m.elements[1], m.elements[2]);
    const up = new THREE.Vector3(m.elements[4], m.elements[5], m.elements[6]);
    this.goalTarget.addScaledVector(right, -dx * scale);
    this.goalTarget.addScaledVector(up, dy * scale);
  }

  /** Move the camera to frame a point at a given distance, smoothly. */
  frame(target, distance, theta, phi) {
    if (target) this.goalTarget.copy(target);
    if (distance !== undefined) this.goal.radius = distance;
    if (theta !== undefined) this.goal.theta = theta;
    if (phi !== undefined) this.goal.phi = phi;
  }

  update(dt) {
    this.goal.radius = THREE.MathUtils.clamp(this.goal.radius,
      this.minDistance, this.maxDistance);
    this.goal.phi = THREE.MathUtils.clamp(this.goal.phi, this.minPolar, this.maxPolar);

    const k = 1 - Math.pow(1 - this.damping, Math.max(0.1, dt * 60));
    this.sph.radius += (this.goal.radius - this.sph.radius) * k;
    this.sph.theta += (this.goal.theta - this.sph.theta) * k;
    this.sph.phi += (this.goal.phi - this.sph.phi) * k;
    this.target.lerp(this.goalTarget, k);
    this.sph.makeSafe();

    const off = new THREE.Vector3().setFromSpherical(this.sph);
    if (this.lookMode) {
      // The camera is pinned; the target swings around it.
      this.camera.position.copy(this.anchor);
      this.target.copy(this.anchor).sub(off);
      this.goalTarget.copy(this.target);
    } else {
      this.camera.position.copy(this.target).add(off);
      // Never let the observer sink below the surface.
      if (this.camera.position.y < this.minHeight) this.camera.position.y = this.minHeight;
    }
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    if (Math.abs(this.sph.radius) < EPS) this.sph.radius = EPS;
  }
}
