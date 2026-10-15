import { APERTURES, ISOS, SCENE_EV, SHUTTERS, narrowestAperture, widestAperture } from './constants';

const isoStopsOf = iso => Math.log2(iso / 100);

// Exposure value of the aperture and shutter alone: EV = log2(N^2 / t). It says
// how much light the settings admit and is independent of ISO.
export function settingsEv(apertureIndex, shutterIndex) {
  return Math.log2(APERTURES[apertureIndex] ** 2 / SHUTTERS[shutterIndex]);
}

// Scene brightness value the meter is reporting. Until a reading arrives the
// nominal scene brightness stands in, and it remains the fallback if metering is
// unavailable on this backend.
export function sceneEv(state) {
  return state.sceneEv ?? SCENE_EV;
}

// Light landing on the sensor, in stops, relative to what a correct exposure at
// ISO 100 needs. Positive means the photosites collect more charge.
export function lightStops(state) {
  return sceneEv(state) - settingsEv(state.aperture, state.shutter) + state.exposureComp;
}

// Stops of gain the ISO setting applies to the sensor readout. Raising ISO makes
// the meter pick a faster shutter for the same picture, so fewer electrons are
// collected and the frame gets noisier, exactly like a real sensor.
export function gainStops(state) {
  return isoStopsOf(ISOS[state.iso]);
}

// Meter error in stops; positive means the frame comes out darker than correct.
export function exposureDeviation(state) {
  return -(lightStops(state) + gainStops(state));
}

export function autoExpose(state, lens) {
  // The meter references aperture and shutter only, so exposure compensation
  // still shifts the final brightness instead of being cancelled out.
  const target = sceneEv(state) + gainStops(state);
  if (state.mode === 'Av') {
    const n = APERTURES[state.aperture];
    state.shutter = nearest(SHUTTERS, value => Math.abs(Math.log2(n * n / value) - target));
  }
  if (state.mode === 'Tv') {
    const t = SHUTTERS[state.shutter];
    const first = widestAperture(lens); const last = narrowestAperture(lens);
    const allowed = APERTURES.map((_, index) => index).filter(index => index >= first && index <= last);
    state.aperture = allowed[nearest(allowed, i => Math.abs(Math.log2(APERTURES[i] ** 2 / t) - target))];
  }
}

function nearest(values, score) {
  return values.reduce((best, value, index) => score(value) < score(values[best]) ? index : best, 0);
}

export const whiteBalanceGain = kelvin => {
  const t = Math.max(-1, Math.min(1, (kelvin - 5500) / 3000));
  return [1 + Math.max(0, t) * 0.08, 1 - 0.035 * Math.abs(t), 1 + Math.max(0, -t) * 0.12];
};
