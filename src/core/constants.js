/**
 * constants.js — measured physical parameters of natural lightning.
 *
 * Every number in this file is a published observation or a standard
 * engineering value, not an artistic choice. Sources are cited inline as
 * [n] and listed in full in README.md. Where the literature reports a
 * distribution rather than a single value, the median and the observed
 * range are both recorded so the simulator can sample from the real
 * distribution instead of a made-up one.
 *
 * Units are strictly SI unless the name says otherwise:
 *   distance m, time s, charge C, current A, field V/m, potential V.
 */

/* ------------------------------------------------------------------ *
 * Universal constants
 * ------------------------------------------------------------------ */

export const EPS0 = 8.8541878128e-12;      // F/m, vacuum permittivity
export const K_E = 1 / (4 * Math.PI * EPS0); // 8.9875e9 N m^2 / C^2
export const C_LIGHT = 2.99792458e8;        // m/s
export const G0 = 9.80665;                  // m/s^2
export const R_DRY = 287.0528;              // J/(kg K), specific gas constant, dry air
export const GAMMA_AIR = 1.4;               // ratio of specific heats

/* ------------------------------------------------------------------ *
 * Reference atmosphere (ISA / US Standard Atmosphere 1976, troposphere)
 * ------------------------------------------------------------------ */

export const ATMOS = {
  T0: 288.15,          // K   sea-level temperature
  P0: 101325,          // Pa  sea-level pressure
  RHO0: 1.225,         // kg/m^3 sea-level density
  LAPSE: 6.5e-3,       // K/m tropospheric lapse rate
  SCALE_HEIGHT: 8400,  // m   exponential fit, used for quick density scaling
  C_SOUND0: 340.29,    // m/s speed of sound at 15 C
};

/* ------------------------------------------------------------------ *
 * Breakdown and propagation fields in air
 *
 * These four thresholds are physically distinct and are constantly
 * confused with one another; the simulator uses each in its own place.
 * All are quoted at sea-level density and scale ~linearly with relative
 * air density delta = rho(z)/rho0.
 * ------------------------------------------------------------------ */

export const FIELDS = {
  /** Conventional breakdown of air, uniform gap, STP. 30 kV/cm. [4] */
  E_BREAKDOWN: 3.0e6,

  /** Positive streamer stability field, sea level. ~5 kV/cm. [5][6] */
  E_STREAMER_POS: 5.0e5,

  /** Negative streamer stability field, sea level. ~12.5 kV/cm. [5][6] */
  E_STREAMER_NEG: 1.25e6,

  /** Runaway (relativistic) breakdown threshold, sea level. 2.84 kV/cm. [7] */
  E_RUNAWAY: 2.84e5,

  /**
   * Effective *grid-scale* thresholds used by 3-D fractal lightning
   * models (Mansell et al. 2002; Riousset et al. 2007). These are far
   * below the microscopic streamer fields because the leader tip itself
   * provides enormous local field enhancement that a ~10-100 m
   * discretisation cannot resolve. [8][9]
   */
  E_INIT: 2.0e5,       // V/m * delta — bidirectional leader inception
  E_PROP_NEG: 2.0e5,   // V/m * delta — negative leader propagation
  E_PROP_POS: 1.25e5,  // V/m * delta — positive leader propagation

  /** Longitudinal field inside a hot, current-carrying leader channel. [10] */
  E_INTERNAL_HOT: 3.0e2,   // V/m, well-developed channel
  E_INTERNAL_COLD: 1.0e3,  // V/m, freshly formed channel

  /** Fair-weather field at the ground, downward-directed. */
  E_FAIR_WEATHER: 120,
};

/* ------------------------------------------------------------------ *
 * Thundercloud charge structure
 *
 * The canonical "tripole": main negative between two positive regions.
 * Altitudes track isotherms, so they are given both in metres and by
 * the temperature of the layer they sit on. [11][12]
 * ------------------------------------------------------------------ */

export const CLOUD = {
  /**
   * Upper positive charge (P), near the -50 C level / anvil.
   * Charge densities here are 0.7-1.1 nC/m^3, mid-range for the
   * 0.1-5 nC/m^3 that balloon soundings report.
   */
  UPPER_POS: { z: 9800, radiusH: 2400, radiusV: 1000, charge: +42 },
  /** Main negative charge (N), the -10 C to -25 C layer. Where CG flashes start. */
  MAIN_NEG: { z: 6000, radiusH: 2100, radiusV: 900, charge: -52 },
  /**
   * Lower positive charge region (LPCR), near cloud base.
   * It plays both sides: it sharpens the field just under the main
   * negative charge, which is what lets a flash start there, and it
   * screens the ground, which is why storms with a strong LPCR produce
   * conspicuously few negative cloud-to-ground flashes. Keep it modest.
   */
  LOWER_POS: { z: 2900, radiusH: 2000, radiusV: 700, charge: +6 },

  /** Screening layer at cloud top (ignored by default; toggleable). */
  SCREEN_NEG: { z: 12000, radiusH: 5000, radiusV: 600, charge: -5 },

  /**
   * A sheared, mature storm whose anvil has been carried downwind.
   *
   * This is the configuration that makes positive cloud-to-ground flashes
   * possible. In an upright tripole a positive leader coming down from the
   * upper charge would have to drive straight through the main negative
   * region, and it does not. Displace the upper positive charge several
   * kilometres downshear and there is a clear path from the anvil to the
   * ground that never crosses the negative layer — which is exactly where
   * positive strokes and "bolts from the blue" come from, striking under
   * clear sky well away from the rain shaft.
   */
  ANVIL: {
    UPPER_POS: { x: 6000, z: 9000, radiusH: 3000, radiusV: 1100, charge: +75 },
    MAIN_NEG: { x: 0, z: 6000, radiusH: 2400, radiusV: 1000, charge: -40 },
    LOWER_POS: { x: 500, z: 2900, radiusH: 2200, radiusV: 700, charge: +5 },
  },

  BASE_ALTITUDE: 1800,    // m, typical continental storm cloud base
  TOP_ALTITUDE: 13000,    // m, overshooting top
  /** Ambient field magnitude actually measured between charge centres. [12] */
  AMBIENT_FIELD_TYPICAL: 5.0e4,  // V/m (0.5 kV/cm)
  AMBIENT_FIELD_MAX: 2.0e5,      // V/m, largest balloon-sounding values
};

/* ------------------------------------------------------------------ *
 * Stepped leader (negative, cloud-to-ground)
 * ------------------------------------------------------------------ */

export const STEPPED_LEADER = {
  /** Average downward propagation speed. Range 1-25e5, median ~2e5 m/s. [1][13] */
  SPEED_MEDIAN: 2.0e5,
  SPEED_MIN: 1.0e5,
  SPEED_MAX: 2.5e6,

  /**
   * Step length. Textbook value 50 m aloft; high-speed video near ground
   * gives a geometric mean of 4.4 m over 1.3-8.6 m. Steps get shorter as
   * the leader descends into denser air. [1][14]
   */
  STEP_LENGTH_TYPICAL: 30,
  STEP_LENGTH_MIN: 3,
  STEP_LENGTH_MAX: 200,

  /** Interval between steps: 5-100 us, ~20-50 us typical. [1] */
  STEP_INTERVAL_TYPICAL: 40e-6,
  STEP_INTERVAL_MIN: 5e-6,
  STEP_INTERVAL_MAX: 100e-6,

  /**
   * More than 50% of steps deviate less than 30 deg from the current
   * direction of advance. Used to shape the DBM candidate cone. [14]
   */
  STEP_ANGLE_HALF_WIDTH: Math.PI / 6,

  /** Total charge lowered onto the leader channel before attachment. [1] */
  CHARGE_TOTAL: 5,        // C
  CHARGE_RANGE: [3, 20],  // C

  /** Line charge density on the channel, 1e-4 to 1e-3 C/m. [1][15] */
  LINE_CHARGE_TYPICAL: 4e-4,
  LINE_CHARGE_MAX: 1.5e-3,

  /** Leader tip potential relative to ground. -10 to -100 MV. [1][15] */
  TIP_POTENTIAL_TYPICAL: -50e6,

  /** Radius of the conducting core and of the surrounding corona sheath. [15] */
  CORE_RADIUS: 5e-3,      // m, ~1 cm diameter thermalised core
  CORONA_RADIUS: 5.0,     // m, space-charge sheath; sets the line capacitance

  /** Duration of the whole descent, 5 km at 2e5 m/s. [1] */
  DURATION_TYPICAL: 25e-3,

  /** Observed 2-D fractal dimension of photographed channels: 1.1-1.4. [3][16] */
  FRACTAL_DIM_2D: [1.13, 1.4],
};

/* ------------------------------------------------------------------ *
 * Attachment
 * ------------------------------------------------------------------ */

export const ATTACHMENT = {
  /**
   * Love's striking distance, the classical electrogeometric model:
   *   r_s = A * I^B  metres, with I in kA.
   * Adopted by IEC 62305 as the rolling-sphere radius. [17][18]
   */
  LOVE_A: 10.0,
  LOVE_B: 0.65,
  /** IEEE-1243 variant used for transmission lines. */
  IEEE_A: 10.0,
  IEEE_B: 0.65,

  /** Upward connecting leader speed, ~1e5 - 1e6 m/s. [1] */
  UCL_SPEED: 3.0e5,
  /** Field at a grounded tip needed to launch a stable upward leader. */
  UCL_INCEPTION_FIELD: 3.0e5,   // V/m, Rizk-type criterion, simplified
};

/* ------------------------------------------------------------------ *
 * Return stroke
 * ------------------------------------------------------------------ */

export const RETURN_STROKE = {
  /**
   * Peak current, negative CG. Median 30 kA first stroke, 12 kA
   * subsequent. Log-normal with sigma_ln ~ 0.6 (CIGRE). [1][19]
   */
  PEAK_FIRST_MEDIAN: 30e3,
  PEAK_SUBSEQ_MEDIAN: 12e3,
  PEAK_POSITIVE_MEDIAN: 35e3,
  PEAK_LOGN_SIGMA: 0.55,

  /** Standard current waveshapes: T_front / T_half in microseconds. [19][20] */
  WAVESHAPE_FIRST: { front: 2.4e-6, half: 78e-6 },
  WAVESHAPE_SUBSEQ: { front: 0.25e-6, half: 20e-6 },
  WAVESHAPE_POSITIVE: { front: 22e-6, half: 230e-6 },

  /** Maximum rate of rise, ~100 kA/us for fast subsequent strokes. [19] */
  MAX_DI_DT: 1.0e11,

  /**
   * Return-stroke front speed: 1/3 to 2/3 c near ground, decreasing with
   * height. Modelled as v(z) = v0 * exp(-z / DECAY_HEIGHT). [1][21]
   */
  SPEED_BASE: 1.1e8,
  SPEED_MIN: 2.0e7,
  SPEED_DECAY_HEIGHT: 6000,

  /**
   * MTLE (modified transmission line, exponential) current attenuation
   * height constant. Nucci/Rachidi engineering model. [22]
   */
  MTLE_LAMBDA: 2000,

  /**
   * Fraction of the leader's line charge that is actually neutralised on
   * the microsecond timescale of the current peak.
   *
   * The transmission-line relation I = lambda v is exact for a charge
   * density travelling with the front, but a leader keeps most of its
   * charge in a corona sheath metres in radius. That sheath drains over
   * tens to hundreds of microseconds, contributing to the tail and to the
   * continuing current rather than to the peak. Only the charge close to
   * the channel axis is collected fast enough to show up in the peak,
   * which is why measured peak currents come out around half of what the
   * naive lambda v would predict. [1][21]
   *
   * The literature supports a factor somewhere in 0.5-1.0; the value here
   * is at the low end of that band. It is the least well constrained
   * number in this file, and it scales the peak current linearly.
   */
  CORE_CHARGE_FRACTION: 0.6,

  /** Peak channel temperature, 28000-34000 K within a few microseconds. [2][23] */
  TEMP_PEAK: 30000,
  TEMP_QUIESCENT: 6000,
  /** Radiative/conductive cooling time constant of the luminous channel. [2] */
  TEMP_COOL_TAU: 30e-6,
  /** Optical decay measured at a fixed height, tens of microseconds. [2] */
  LUM_DECAY_TAU: 40e-6,

  /** Thermalised channel core radius just after the stroke. [2][23] */
  CHANNEL_RADIUS: 0.02,   // m
  /** Radius of the shock front once it decays to a sound wave. [24] */
  SHOCK_RELAX_RADIUS: 3.0,
  /** Energy deposited per metre of channel, 1e3 - 1e5 J/m. [24][25] */
  ENERGY_PER_METRE: 2.0e4,
};

/* ------------------------------------------------------------------ *
 * Subsequent strokes and the flash as a whole
 * ------------------------------------------------------------------ */

export const FLASH = {
  /** Strokes per flash: mean 3-5, up to 26 recorded. [1] */
  MULTIPLICITY_MEAN: 3.4,
  MULTIPLICITY_MAX: 14,

  /** Interstroke interval, median ~60 ms, log-normal. [1][26] */
  INTERSTROKE_MEDIAN: 60e-3,
  INTERSTROKE_SIGMA: 0.6,
  INTERSTROKE_MIN: 3e-3,

  /** Dart leader speed, 1-2e7 m/s. [1][26] */
  DART_SPEED: 1.5e7,
  DART_SPEED_RANGE: [1.0e6, 2.3e7],

  /** Continuing current occurs in 30-50% of negative flashes. [1] */
  CONTINUING_PROBABILITY: 0.4,
  CONTINUING_CURRENT: 150,        // A, 100-200 A typical
  CONTINUING_DURATION: 150e-3,    // s, 40-500 ms ("long" CC is > 40 ms)
  /** M-components: re-brightenings riding on the continuing current. [27] */
  M_COMPONENT_INTERVAL: 4e-3,
  M_COMPONENT_CURRENT: 200,       // A above the CC level
  M_COMPONENT_RISE: 400e-6,

  /** Total flash duration ~0.2-1 s; charge transfer 5-25 C. [1] */
  DURATION_TYPICAL: 0.5,
  CHARGE_TRANSFER: 20,

  /** Energy: ~1-10 GJ total, peak electrical power ~1e12 W. [1] */
  ENERGY_TYPICAL: 3e9,

  /** Global rates, for the info panel. [28] */
  GLOBAL_FLASH_RATE: 44,          // flashes per second worldwide
  FRACTION_INTRACLOUD: 0.75,
  FRACTION_POSITIVE_CG: 0.10,
};

/* ------------------------------------------------------------------ *
 * Thunder
 * ------------------------------------------------------------------ */

export const THUNDER = {
  /** Peak of the acoustic energy spectrum. CG ~50 Hz, IC ~28 Hz. [29][30] */
  PEAK_FREQ_CG: 55,
  PEAK_FREQ_IC: 28,
  /** "Peals" 40-100 Hz, "claps" 40-160 Hz, "rumbles" 25-80 Hz. [30] */
  BAND_LOW: 15,
  BAND_HIGH: 400,
  /** Practical audible range of thunder. [1] */
  MAX_AUDIBLE_RANGE: 25000,   // m
  /** Atmospheric absorption coefficient at 1 kHz, 20 C, 70% RH. [31] */
  ABSORPTION_1KHZ: 5.0e-3,    // Np/m (scales roughly as f^1.7)
  /** Rule of thumb: 3 s per km, 5 s per mile. */
  DELAY_PER_KM: 2.92,
};

/* ------------------------------------------------------------------ *
 * Dielectric Breakdown Model (Niemeyer-Pietronero-Wiesmann 1984)
 *
 * Growth probability of a bond i:
 *     p_i  =  (E_i - E_c)^eta  /  sum_j (E_j - E_c)^eta
 *
 * eta controls the morphology and hence the fractal dimension:
 *     eta = 0  -> Eden cluster,      D = d (space filling)
 *     eta = 1  -> DLA,               D ~ 1.7 (2-D) / 2.5 (3-D)
 *     eta > 2  -> sparse, filamentary, D -> 1
 * Natural lightning is matched by eta ~ 1-3. [3][8][9][32]
 * ------------------------------------------------------------------ */

export const DBM = {
  ETA_DEFAULT: 3.0,
  ETA_RANGE: [0.5, 6.0],
  /** Candidate directions sampled per tip per growth round. */
  CANDIDATES_PER_TIP: 26,
  /**
   * Widest turn a single step may take, as a cosine. High-speed video of
   * stepped leaders puts more than half of all steps within 30 deg of the
   * direction of advance, and the tail of that distribution runs out
   * around 70 deg, which is what this bound encodes. It is also what
   * keeps the channel's tortuosity near the measured 1.1-1.3 metres of
   * path per metre of descent instead of the ~2 an unconstrained walk
   * would produce.
   */
  MAX_TURN_COS: 0.30,
  /** Space-charge shielding: no new segment within this many step lengths. */
  SELF_AVOID_FACTOR: 0.85,
};

/* ------------------------------------------------------------------ *
 * Optics
 * ------------------------------------------------------------------ */

export const OPTICS = {
  /**
   * Lightning's continuum comes from a ~30 000 K plasma, so the visible
   * band is far out on the Rayleigh-Jeans tail: the perceived colour is
   * blue-white and saturates above ~15 000 K. Strong NII, OI, HI lines
   * ride on top. [2][23]
   */
  CORE_TEMP: 30000,
  /** Rayleigh optical depth per metre at 550 nm, sea level. Reddens distant flashes. */
  RAYLEIGH_BETA: [5.8e-6, 13.5e-6, 33.1e-6],  // R, G, B  (1/m)
  /** Luminous efficiency of the return stroke: ~0.4% of input power. [2] */
  LUMINOUS_EFFICIENCY: 0.004,
};
