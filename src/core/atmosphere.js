/**
 * atmosphere.js — the medium the discharge has to break.
 *
 * Almost every electrical threshold in a gas discharge is set by the
 * number density of the gas, through Paschen-like similarity: the
 * reduced field E/N is what the electrons actually respond to. So the
 * breakdown, streamer-stability and leader-propagation fields all scale
 * with the relative air density
 *
 *     delta(z) = rho(z) / rho(0)
 *
 * A leader therefore finds it progressively *easier* to propagate the
 * higher it is, which is a large part of why intracloud flashes are so
 * much more common than cloud-to-ground ones, and why a downward leader
 * has to work harder and step more finely as it nears the surface.
 *
 * Uses the ISA / US Standard Atmosphere 1976 troposphere (0-11 km),
 * which covers the entire depth of a thunderstorm.
 */

import { ATMOS, FIELDS, GAMMA_AIR, R_DRY, G0 } from './constants.js';

const TROPOPAUSE = 11000;
/** Exponent in p = p0 (T/T0)^(g/(L R)). */
const BARO_EXP = G0 / (ATMOS.LAPSE * R_DRY); // ~5.2559

/** Temperature in K at geopotential altitude z (m). */
export function temperature(z) {
  if (z <= TROPOPAUSE) return ATMOS.T0 - ATMOS.LAPSE * z;
  return ATMOS.T0 - ATMOS.LAPSE * TROPOPAUSE; // 216.65 K isothermal layer
}

/** Pressure in Pa. */
export function pressure(z) {
  if (z <= TROPOPAUSE) {
    return ATMOS.P0 * Math.pow(temperature(z) / ATMOS.T0, BARO_EXP);
  }
  const pTrop = ATMOS.P0 * Math.pow(temperature(TROPOPAUSE) / ATMOS.T0, BARO_EXP);
  const T = temperature(TROPOPAUSE);
  return pTrop * Math.exp(-G0 * (z - TROPOPAUSE) / (R_DRY * T));
}

/** Density in kg/m^3. */
export function density(z) {
  return pressure(z) / (R_DRY * temperature(z));
}

/**
 * Relative air density, the quantity every discharge threshold scales
 * with. delta(0) = 1, delta(6 km) ~ 0.54, delta(10 km) ~ 0.34.
 */
export function relativeDensity(z) {
  return density(Math.max(0, z)) / ATMOS.RHO0;
}

/** Speed of sound, m/s. Sets the thunder delay and the rumble structure. */
export function soundSpeed(z) {
  return Math.sqrt(GAMMA_AIR * R_DRY * temperature(Math.max(0, z)));
}

/** Altitude of a given isotherm — the -10 C and -25 C levels bracket the
 *  main negative charge region of a thundercloud. */
export function isothermAltitude(celsius) {
  const T = celsius + 273.15;
  return Math.max(0, (ATMOS.T0 - T) / ATMOS.LAPSE);
}

/* ------------------------------------------------------------------ *
 * Density-scaled discharge thresholds
 * ------------------------------------------------------------------ */

/** Conventional breakdown field at altitude z. 3 MV/m at sea level. */
export function breakdownField(z) {
  return FIELDS.E_BREAKDOWN * relativeDensity(z);
}

/** Streamer stability field. Negative streamers need ~2.5x the positive value. */
export function streamerField(z, polarity) {
  const base = polarity < 0 ? FIELDS.E_STREAMER_NEG : FIELDS.E_STREAMER_POS;
  return base * relativeDensity(z);
}

/** Relativistic runaway electron avalanche threshold. */
export function runawayField(z) {
  return FIELDS.E_RUNAWAY * relativeDensity(z);
}

/**
 * Effective leader-propagation threshold at the model's spatial
 * resolution (tens of metres). Negative leaders need a stronger field
 * than positive ones — the reason a positive leader, once started,
 * outruns a negative one and why positive CG strokes are so much less
 * branched.
 */
export function propagationField(z, polarity, scale = 1) {
  const base = polarity < 0 ? FIELDS.E_PROP_NEG : FIELDS.E_PROP_POS;
  return base * relativeDensity(z) * scale;
}

/** Threshold for inception of the initial bidirectional leader. */
export function initiationField(z, scale = 1) {
  return FIELDS.E_INIT * relativeDensity(z) * scale;
}

/**
 * Observed step length grows with altitude roughly as 1/delta: steps are
 * long and coarse in the thin air near the charge region and shorten to
 * a few metres in the dense air near the ground, which is exactly what
 * high-speed video of the final hundred metres shows.
 */
export function stepLengthScale(z) {
  const d = relativeDensity(z);
  return Math.min(4, Math.pow(1 / Math.max(d, 0.15), 0.9));
}

/**
 * Atmospheric absorption of sound. Attenuation grows steeply with
 * frequency (roughly f^1.7 in the classical + molecular relaxation
 * regime), which is why nearby thunder is a sharp crack full of
 * kilohertz content and the same flash heard from 10 km away is a bass
 * rumble: the high frequencies simply do not survive the trip.
 *
 * Returns the amplitude transmission factor over distance d at
 * frequency f.
 */
export function acousticAbsorption(distance, freqHz) {
  const alpha = 5.0e-3 * Math.pow(freqHz / 1000, 1.7); // Np/m
  return Math.exp(-alpha * distance);
}
