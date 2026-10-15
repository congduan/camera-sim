import { SCENE_EV } from './constants';

// Metering patterns. Each one is a weighted average of scene luminance, so the
// only thing that differs between them is how much weight a sample keeps as it
// moves away from the metering centre.
//
// `radius` and `floor` are in units of frame height (the frame is 1.0 tall at
// the centre, 0.5 to a vertical edge). `sharpness` shapes the falloff: 1 is
// linear, higher values crowd the weight towards the centre. `followsFocus`
// marks the narrow patterns, which on a real camera meter around the active
// autofocus point rather than the middle of the frame.
export const METERING_MODES = ['evaluative', 'centre', 'partial', 'spot'];

export const METERING = {
  evaluative: { radius: 1.00, floor: 0.45, sharpness: 1.0, followsFocus: false },
  centre: { radius: 0.52, floor: 0.12, sharpness: 1.8, followsFocus: false },
  partial: { radius: 0.16, floor: 0.00, sharpness: 1.0, followsFocus: true },
  spot: { radius: 0.06, floor: 0.00, sharpness: 0.7, followsFocus: true }
};

export function meteringConfig(mode) {
  return METERING[mode] ?? METERING.evaluative;
}

// Where the pattern is centred: the autofocus point for the narrow patterns, the
// middle of the frame otherwise.
export function meteringCentre(state) {
  return meteringConfig(state.metering).followsFocus
    ? { x: state.afX, y: state.afY }
    : { x: 0.5, y: 0.5 };
}

export const SCENE_EV_RANGE = [1, 18];

// Calibration converts the renderer's relative luminance into a scene exposure
// value. It is captured from the first reading, so the scene as it loads meters
// to its nominal EV and every later framing is measured relative to that.
export function calibrateEv(luminance) {
  return SCENE_EV - Math.log2(Math.max(luminance, 1e-7));
}

export function luminanceToEv(luminance, calibration) {
  const value = Math.log2(Math.max(luminance, 1e-7)) + calibration;
  return Math.min(SCENE_EV_RANGE[1], Math.max(SCENE_EV_RANGE[0], value));
}
