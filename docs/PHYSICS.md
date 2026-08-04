# The physics

How the simulation works, and where every number in it came from.
The short version is in the [README](../README.md); this is the long one.

1. [Charge structure](#1-charge-structure)
2. [Initiation](#2-initiation)
3. [Growth: the Dielectric Breakdown Model](#3-growth-the-dielectric-breakdown-model)
4. [The channel is a conductor](#4-the-channel-is-a-conductor)
5. [Attachment](#5-attachment)
6. [Return stroke](#6-return-stroke)
7. [Thunder](#7-thunder)
8. [What the observer contributes](#8-what-the-observer-contributes)

- [Layout of the code](#layout) and [performance](#performance)
- [Honest limitations](#honest-limitations)
- [Sources](#sources)

The photograph pipeline has its own document: [PHOTO.md](PHOTO.md).

---

## The model

### 1. Charge structure

Three horizontally extensive charge layers — the canonical tripole — laid
out as hexagonal lattices of **Gaussian** charge blobs rather than point
charges. A Gaussian ball has an exact, everywhere-smooth potential

$$\phi(r) = \frac{k_e q}{r}\,\operatorname{erf}\!\left(\frac{r}{\sqrt{2}\,\sigma}\right)$$

that becomes a point charge beyond about 4σ, so the far field is right by
construction while nothing inside the cloud ever sees the discretisation.
That is not cosmetic: the leader picks its direction from potential
differences of a few percent, so numerical lumps would appear directly as
spurious branches.

The ground is a perfect conductor at *z* = 0, imposed exactly by images.

Charge densities are 0.5–3 nC/m³, inside the 0.1–5 nC/m³ that balloon
soundings report. Peak ambient fields come out at 100–130 kV/m, and the
potential of the main negative region reaches about −200 MV.

**Positive flashes need a different storm.** In an upright tripole a
positive leader descending from the upper charge would have to drive
straight through the main negative region, and it does not. Selecting a
positive flash therefore switches to a sheared configuration with the
anvil charge displaced several kilometres downshear — which is where
positive strokes and "bolts from the blue" actually come from.

### 2. Initiation

The flash begins wherever `|E| / E_init(z)` is largest, not where `|E|` is
largest, because the threshold falls with air density. Every discharge
field in the model scales with relative air density δ(z) = ρ(z)/ρ₀ from
the US Standard Atmosphere, which is why the model prefers to flash high
up — and why three quarters of real flashes never leave the cloud.

Four physically distinct thresholds are used, each in its own place:

| Field | Sea level | Used for |
|---|---|---|
| Conventional breakdown | 3.0 MV/m | reference only |
| Negative streamer stability | 1.25 MV/m | reference only |
| Positive streamer stability | 0.5 MV/m | reference only |
| Relativistic runaway | 0.284 MV/m | reference only |
| Leader inception (grid scale) | 0.20 MV/m | initiation |
| Negative leader propagation | 0.20 MV/m | growth |
| Positive leader propagation | 0.125 MV/m | growth |

The last three are effective thresholds at the model's spatial resolution,
as used by published 3-D fractal lightning models. They are far below the
microscopic streamer fields because the enormous field enhancement at a
leader tip is unresolved at tens of metres.

### 3. Growth: the Dielectric Breakdown Model

Niemeyer, Pietronero and Wiesmann (1984): grow the discharge one bond at a
time with

$$p_i = \frac{(E_i - E_c)^\eta}{\sum_j (E_j - E_c)^\eta}$$

η selects the morphology and with it the fractal dimension: η = 0 gives a
space-filling Eden cluster, η = 1 reproduces diffusion-limited aggregation,
and large η collapses the structure to a single filament. Photographed
lightning channels sit at *D* ≈ 1.1–1.4 in projection. The default is
η = 3.

What η controls directly and measurably here is the *sharpness* of the
selection — the mean field excess of the bond actually taken, relative to
the best available:

```
eta = 0.6  ->  0.715        eta = 3  ->  0.854        eta = 8  ->  0.918
```

Its effect on branch *count* is real but weaker than in a classic lattice
DBM, and largely swamped by the chaotic divergence of two runs that took
different paths. See [Honest limitations](#honest-limitations).

Three deliberate departures from the 1984 lattice formulation, each of
which makes the result more like lightning rather than less:

- **Candidates come from a Fibonacci sphere, not a cubic lattice.** A
  lattice imprints its own axes on the channel; a real leader has no
  preferred direction.
- **Every live tip advances once per round** rather than one bond being
  chosen globally per iteration, because branches grow simultaneously.
  A round is one step and takes `step_length / v_leader` seconds, which
  gives the simulation an honest clock.
- **The bond field is averaged over a streamer zone**, not over one step.
  Right at a leader tip the field is megavolts per metre in *every*
  direction and no threshold would mean anything. What decides whether a
  leader advances is the average field across its corona zone — a couple
  of hundred metres — and that averaging length is exactly what makes the
  quoted effective thresholds meaningful.

Step length is 26 m at sea level, scaled up with altitude by the falling
air density; observed steps run 3–200 m and shorten near the ground.
Turns are bounded at 70°, matching the observation that more than half of
all steps deviate less than 30° from the direction of advance.

### 4. The channel is a conductor

This is where most of the work went, and it is what makes the flash
behave.

**Charge.** Each new segment carries the charge that makes its own
potential close the gap between the channel's potential and whatever the
rest of the world already provides there — one Gauss-Seidel sweep of the
equipotential boundary condition, using the self-potential coefficient of
a charged rod. Charge therefore concentrates at the tip and along outlying
branches and is small deep inside the tree, exactly as electrostatics
demands. It comes out at 1–7 × 10⁻⁴ C/m, against a measured 10⁻⁴–10⁻³ C/m.

**Potential.** Kasemir (1960): a lightning channel in a cloud is attached
to nothing, so it is an isolated conductor carrying zero net charge, and
its potential *floats* to whatever value makes the induced charges cancel.
The simulation enforces Σq = 0 exactly (residual ~10⁻¹³ C), and that single
condition explains the opening act of a negative CG flash:

> The positive end, needing a weaker field, climbs first into the main
> negative charge region. As it does, the average ambient potential over
> the channel plunges, dragging the floating potential down with it. Only
> then does the negative end find itself tens of megavolts below its
> surroundings and start driving for the ground.

Watch the *Channel potential* readout during a flash: it falls to about
−170 MV while the in-cloud leader develops, then climbs back as the
descending leader dumps negative charge downward. The leader waits, then
goes. Nothing scripts that.

**Internal gradient.** The channel loses about 7 kV/m along its length,
and higher-order branches lose more because their current is fed through
more junctions. This starves side branches after a few hundred metres
while the trunk drives all the way to the ground, and it brings the tip
potential to about −50 MV by the time it nears the surface — the measured
value.

### 5. Attachment

The electrogeometric model, the criterion power engineers have used since
the 1970s and the one IEC 62305 turns into the rolling sphere. Within a
striking distance

$$r_s = 10\,I^{0.65}\ \text{metres},\quad I \text{ in kA}$$

grounded objects launch upward connecting leaders, which are grown with
the same DBM machinery but pinned to earth potential instead of floating.
Whichever object gets a leader away first collects the stroke — which is
why a mast protects the field around it and a hill of the same height does
not.

The prospective current is not assumed. It comes from the leader that was
actually grown, through the transmission-line relation *I* = λ*v*.

### 6. Return stroke

The MTLE (modified transmission line, exponential) engineering model: the
base-current waveform, delayed by the front's travel time to each point and
attenuated as exp(−*d*/λ) with λ ≈ 2 km. This is the model that reproduces
measured remote electromagnetic fields, so it also gets the distribution of
*light* along the channel right.

The base current is a Heidler function

$$i(t) = \frac{I_0}{\eta_c}\,
\frac{(t/\tau_1)^n}{1+(t/\tau_1)^n}\,e^{-t/\tau_2}$$

fitted numerically to the standard 2.4/78 μs (first stroke) and
0.25/20 μs (subsequent) waveshapes. Front speed runs from about c/3 at the
base, falling with height.

**Optics.** Ohmic heating fills the channel faster than radiation empties
it:

$$\frac{dW}{dt} = i(t)^2 R' - \frac{W}{\tau_{\text{cool}}}$$

with *R*′ ≈ 1 Ω/m chosen so the deposited energy lands in the measured
10³–10⁵ J/m. Temperature follows from radiative equilibrium (*T* ∝ *W*<sup>1/4</sup>),
so light rises in microseconds and decays over tens — the asymmetric
optical pulse streak cameras record.

Colour is **not** a palette choice. It comes from Planck's law at the
resulting temperature, integrated against analytic fits to the CIE 1931
colour matching functions and converted to linear sRGB. At 30 000 K the
visible band is far out on the Rayleigh-Jeans tail, so the result is a
blue-white that barely changes with further heating — which is why every
lightning photograph is the same colour regardless of stroke strength, and
why the interesting colour shift happens later, during cool-down.

### 7. Thunder

Every metre of channel is its own source. The shock from each expands to a
relaxation radius

$$R_0 = \sqrt{E/(\pi p_0)} \approx 8\ \text{m}$$

and decays into an N-wave a few milliseconds long, which is why the
acoustic spectrum of thunder peaks near 50–100 Hz (28 Hz for intracloud).

So thunder's *shape* is the channel's geometry projected onto the listener
by the speed of sound. The simulation builds a genuine acoustic impulse
response — one delayed, spread, geometrically attenuated N-wave per
segment — and convolves a short source through it with the Web Audio API.
The crack is the near, nearly equidistant part of the channel; the rumble
is everything else, arriving in the order the geometry dictates. High
frequencies are lost with distance, so the same flash is a sharp crack
close up and a bass rumble from ten kilometres away, from the same code.

The delay is not faked. It is the time the simulation says sound takes to
arrive, so counting the seconds after the flash gives the right distance.

### 8. What the observer contributes

Two effects belong to the viewer rather than to the lightning, and both are
modelled explicitly and labelled as such:

- **Glare.** A return stroke is some ten orders of magnitude brighter than
  the cloud behind it. No display shows that, and no eye or lens sees it
  cleanly either — the light scatters and spreads into a halo. That halo
  is why lightning looks the way it does in every photograph ever taken of
  it, and omitting it makes a physically correct channel look like wire.
- **Retinal persistence.** A return stroke is over in 200 μs and a
  multi-stroke flash spends most of its few hundred milliseconds
  completely dark. Nobody has seen that. The eye integrates over roughly a
  tenth of a second. Set *Retinal persistence* to zero to watch what the
  channel is really doing instant by instant.

---


## Layout

```
src/core/      physics — no dependency on the renderer, runs under node
  constants.js     every measured value, cited
  atmosphere.js    US Standard Atmosphere, density-scaled thresholds
  field.js         charge simulation method, images, near/far splitting
  channel.js       the discharge graph
  leader.js        DBM growth, Kasemir floating potential
  current.js       Heidler, MTLE, thermal model, Planck -> sRGB
  returnstroke.js  return stroke, dart leader, continuing current
  flash.js         the sequencer
  thunder.js       acoustic impulse response
  rng.js           seeded, so any flash can be replayed exactly
src/photo/     photograph -> 3-D scene, also renderer-free except scene.js
  analyze.js       horizon by Otsu, sky mask, camera calibration
  depth.js         two-plane geometry, Depth Anything, metric fitting
  reconstruct.js   mesh, tearing, horizon-biased rows
  scene.js         relight material, occlusion, click picking
src/render/    three.js: bolt, volumetric storm, terrain, rain, bloom
src/audio/     Web Audio convolution
src/ui/        panel, telemetry, oscilloscope
tests/         33 physics checks + 21 photo-geometry checks
```

The physics core imports nothing from `render/`, which is why the test
suite can run the whole thing headless under node.

### Performance

Growth costs a Coulomb sum per candidate bond. Two things keep it
interactive: distant channel charges are lumped into a coarse grid and
expanded to first order about each tip, while charges within a few hundred
metres are summed exactly — because it is exactly that near field, the
channel screening itself, that decides which way a branch turns. And the
Heidler waveform is sampled into two lookup tables, because it is
evaluated for every node on every sub-step of the return stroke, millions
of times per flash.

**The frame budget is on wall-clock work, not on simulated time.** This is
the part that matters at fast playback rates. At 1:10 000 a frame is a
fraction of one leader step; asking for real time is asking for sixteen
milliseconds of storm per frame, which on a heavily branched leader is
tens of growth steps and can be a second of computation for a sixtieth of
a second of animation. So a frame may spend six milliseconds advancing the
physics and no more, and the deadline is passed *into* `Flash.update` as
well as checked around it — a single call will otherwise overrun it
several times over on its own. When the ceiling is hit the simulation
falls behind and says so in the corner. Running a 300 ms flash in 500 ms
of real time is imperceptible; dropping a one-second frame is not.

Measured frame times, worst case over ~220 frames, before and after that
change:

```
                          before            after
auto pacing            141 ms            35 ms
real time               46 ms            15 ms
real time, intensity 100  965 ms         27 ms
```

The initiation search is coarse-to-fine for the same reason: a dense sweep
of the search volume is millions of Coulomb terms and dropped a frame
every time a flash was created, which at high flash rates is every second.

Drop *Cloud detail* first if the frame rate suffers; the volumetric
raymarch is the most expensive thing on screen.

---


## Honest limitations

- **Peak current comes out low.** The derived median is about 24 kA
  against an observed 30 kA. It follows from `I = f·λ·v`, and the weak
  link is *f*, the fraction of the leader's charge collected fast enough
  to appear in the peak — the corona sheath drains far too slowly to
  contribute. The literature supports *f* somewhere in 0.5–1.0; 0.6 is
  used here. It is the least well constrained number in the model and it
  scales the peak linearly, so treat the peak as good to a factor of
  roughly 1.5, not better.
- **η's effect on branching is weaker than the DBM literature suggests.**
  The tip's overpotential is large compared with the spread of bond
  fields across candidate directions, so the weights sit closer together
  than they would in a lattice DBM with an O(1) potential range, and the
  branch count is dominated by trajectory chaos. The selection sharpness
  does respond cleanly and monotonically; the morphology follows only
  loosely.
- The equipotential condition on the channel is solved by a single
  Gauss-Seidel sweep per new segment, not a full matrix solve. The charge
  distribution is right in character and magnitude but not exact.
- Simultaneous growth points are capped at 20, and for a heavily branched
  flash that cap binds rather than the field competition. Branch counts
  should be read as "about right", not measured.
- Ambient potential at candidate points is taken to first order about the
  tip. Over a streamer zone that is accurate to a fraction of a percent;
  it would not be over kilometres.
- The channel's path-to-descent ratio runs around 1.5–2.5, on the high
  side of photographed channels. Raising **Direction memory** in the
  source (`leader.js`) straightens it.
- `R'` = 1 Ω/m in the thermal model is an effective value chosen to match
  the measured energy per metre, not a measured resistance.
- Thunder ignores refraction by wind and temperature gradients, which in
  reality bends rays upward and creates the acoustic shadow zone beyond
  about 25 km.
- The upward connecting leader uses the electrogeometric striking distance
  to decide *when* to launch. A fully self-consistent inception criterion
  (Rizk, or Becerra–Cooray) would derive that too.
- Air density scaling of the discharge thresholds is linear in δ. The true
  scaling is closer to δ^0.8–1.0 and depends on humidity.

## Sources

Ranges and constants are drawn from the following. Where the literature
reports a distribution, the simulation samples from it rather than using a
single value.

1. Rakov, V. A. & Uman, M. A., *Lightning: Physics and Effects*,
   Cambridge University Press, 2003 — the standard reference; source of
   most of the parameter distributions used here.
2. Uman, M. A., *The Lightning Discharge*, Academic Press, 1987 —
   channel optics, temperature and luminosity decay.
3. Tsonis, A. A. & Elsner, J. B., "Fractal characterization and simulation
   of lightning", *Beitr. Phys. Atmosph.* 60, 1987.
4. Raizer, Y. P., *Gas Discharge Physics*, Springer, 1991 — breakdown
   fields and their density scaling.
5. Bazelyan, E. M. & Raizer, Y. P., *Spark Discharge*, CRC Press, 1998 —
   streamer stability fields, ~5 kV/cm positive and ~12.5 kV/cm negative
   at sea level.
6. Briels, T. M. P. et al., "Positive and negative streamers in ambient
   air", *J. Phys. D* 41, 2008.
7. Gurevich, A. V. & Zybin, K. P., "Runaway breakdown and electric
   discharges in thunderstorms", *Physics-Uspekhi* 44, 2001 — the
   0.284 MV/m × δ runaway threshold.
8. Mansell, E. R. et al., "Simulated three-dimensional branched lightning
   in a numerical thunderstorm model", *JGR* 107, 2002 — effective
   grid-scale propagation thresholds.
9. Riousset, J. A. et al., "Three-dimensional fractal modeling of
   intracloud lightning discharge in a Utah thunderstorm", *JGR* 112,
   2007 — the charge-simulation approach used here.
10. Gallimberti, I., "The mechanism of the long spark formation",
    *J. Physique Colloques* 40, 1979 — leader channel gradients.
11. Williams, E. R., "The tripole structure of thunderstorms", *JGR* 94,
    1989.
12. Stolzenburg, M., Rust, W. D. & Marshall, T. C., "Electrical structure
    in thunderstorm convective regions", *JGR* 103, 1998 — charge region
    altitudes, magnitudes and measured field profiles.
13. Schonland, B. F. J., "The lightning discharge", *Handbuch der Physik*
    22, 1956 — the original streak-photograph leader speeds.
14. Hill, J. D., Uman, M. A. & Jordan, D. M., "High-speed video
    observations of a lightning stepped leader", *JGR* 116, 2011 —
    step lengths and angular statistics near the ground.
15. Kasemir, H. W., "A contribution to the electrostatic theory of a
    lightning discharge", *JGR* 65, 1960 — the bidirectional,
    charge-neutral, floating leader.
16. Idone, V. P. & Orville, R. E., "Lightning return stroke velocities in
    the Thunderstorm Research International Program", *JGR* 87, 1982.
17. Love, E. R., "Improvements on lightning stroke modeling and
    applications to the design of EHV and UHV transmission lines",
    M.Sc. thesis, University of Colorado, 1973 — *r*ₛ = 10 I<sup>0.65</sup>.
18. IEC 62305-1, *Protection against lightning*, 2010 — the rolling
    sphere method.
19. CIGRE WG 33.01, "Guide to procedures for estimating the lightning
    performance of transmission lines", Technical Brochure 63, 1991 —
    peak current distributions.
20. IEC 62305-1 Annex A / IEEE Std 1243 — standard current waveshapes.
21. Rakov, V. A., "Lightning return stroke speed", *J. Lightning Res.* 1,
    2007.
22. Nucci, C. A. & Rachidi, F., "Experimental validation of a modification
    to the transmission line model for LEMP calculation", 8th EMC
    Symposium, Zurich, 1989 — the MTLE model.
23. Orville, R. E., "A high-speed time-resolved spectroscopic study of the
    lightning return stroke", *J. Atmos. Sci.* 25, 1968 — 30 000 K.
24. Few, A. A., "Thunder", *Scientific American* 233, 1975 — shock
    relaxation radius and the acoustic source model.
25. Depasse, P., "Lightning acoustic signature", *JGR* 99, 1994.
26. Thottappillil, R. et al., "Lightning subsequent-stroke electric field
    peak greater than the first stroke peak and multiple ground
    terminations", *JGR* 97, 1992 — interstroke intervals, dart speeds.
27. Jordan, D. M. et al., "Observed dart leader speed in natural and
    triggered lightning", *JGR* 97, 1992; and Rakov et al. on
    M-components.
28. Christian, H. J. et al., "Global frequency and distribution of
    lightning as observed from space by the Optical Transient Detector",
    *JGR* 108, 2003 — ~44 flashes per second worldwide.
29. Holmes, C. R. et al., "On the power spectrum and mechanism of
    thunder", *JGR* 76, 1971.
30. Lacroix, A. et al., "Acoustical measurement of natural lightning
    flashes", *JGR Atmospheres* 123, 2018 — peals, claps and rumbles.
31. ISO 9613-1, *Attenuation of sound during propagation outdoors*, 1993.
32. Niemeyer, L., Pietronero, L. & Wiesmann, H. J., "Fractal dimension of
    dielectric breakdown", *Phys. Rev. Lett.* 52, 1984 — the DBM itself.

For the photograph pipeline:

33. Yang, L. et al., "Depth Anything V2", NeurIPS 2024 — the depth model,
    used through the `onnx-community/depth-anything-v2-small` export and
    Transformers.js.
34. Ranftl, R. et al., "Towards robust monocular depth estimation"
    (MiDaS), *TPAMI* 44, 2022 — the affine-invariant disparity formulation
    that makes the metric fit necessary.
35. Piccinelli, L. et al., "UniDepth: universal monocular metric depth
    estimation", CVPR 2024, and Hu, M. et al., "Metric3D v2", 2024 —
    models that do predict metric depth directly, and would remove the
    fitting stage if they ever ship a browser runtime.
36. Shih, M.-L. et al., "3D photography using context-aware layered depth
    inpainting", CVPR 2020 — what would properly fix the gaps behind
    foreground objects.
37. Jin, L. et al., "Perspective Fields for single image camera
    calibration", CVPR 2023 — recovers pitch, roll and field of view from
    one image; here those are a heuristic and two sliders instead.
38. Otsu, N., "A threshold selection method from gray-level histograms",
    *IEEE Trans. SMC* 9, 1979 — the horizon split.
39. Paliwal, A. et al., "PanoDreamer: optimization-based single image to
    360 3D scene with diffusion", SIGGRAPH Asia 2025, and Wang, T. et al.,
    "CamFreeDiff: camera-free image to panorama generation", CVPR 2025 —
    what filling in the rest of the sphere looks like when a generative
    model is allowed to do it.

Additional non-primary references consulted while building this: NOAA
JetStream and the NWS lightning-science pages; the University of Arizona
ATMO 589 lecture notes on lightning spectroscopy and thunder; the
University of Florida Lightning Research Group publication archive; and
Wyman, Sloan & Shirley, "Simple analytic approximations to the CIE XYZ
colour matching functions", *JCGT* 2, 2013, for the colour pipeline.

---

