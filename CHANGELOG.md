# Changelog

Notable changes, newest first.

This project is finished and unmaintained, so 1.0.0 is likely to be the
only entry. It is kept for anyone forking it, to make clear what the
release contained.

## 1.0.0

First public release.

### Physics

- Dielectric Breakdown Model channel growth over a charge-simulation-method
  electrostatic field, with a tripole storm, perfect-conductor ground by
  images, and the growing channel as its own charges.
- Kasemir's floating bidirectional leader: the channel is an isolated
  conductor held at zero net charge, which is what makes a negative
  cloud-to-ground flash develop in the right order.
- Attachment by the electrogeometric model, with upward connecting leaders
  grown by the same machinery but clamped to earth potential.
- MTLE return stroke driven by a Heidler waveform fitted to the standard
  2.4/78 µs and 0.25/20 µs waveshapes, with an ohmic-heating thermal model
  and blackbody colour computed through the CIE 1931 observer.
- Dart leaders, multi-stroke flashes, continuing current with
  M-components.
- Thunder built as a genuine acoustic impulse response from the channel's
  own geometry, convolved through the Web Audio API.
- 33 checks against published measurements.

### Photographs

- Any image unprojected into a 3-D scene: horizon detection by Otsu's
  method, two-plane inverse projection for metric depth, mesh tearing at
  silhouettes, and relighting that treats the photograph as albedo.
- Optional Depth Anything V2 refinement, fitted to the geometry for scale
  and confined to the near field where the model has resolution.
- Cylindrical projection support for stitched panoramas.
- A photo-derived environment sphere and ground plane, so no viewing angle
  shows a void.
- Five bundled public-domain storm photographs.
- 21 checks on the reconstruction geometry.

### Interface

- A single storm-intensity dial from 0 to 100 driving charge, breakdown
  threshold, branching, multiplicity, flash rate and cell drift together.
- Phase-aware playback so each stage of a flash is watchable despite
  spanning six orders of magnitude in time.
- Live telemetry with the measured range beside each reading, a
  current/field oscilloscope, and scenario presets.
