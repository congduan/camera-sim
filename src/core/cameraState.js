import { reactive } from 'vue';
import { BODIES, LENSES, APERTURES, SHUTTERS, ISOS, SCENE_EV, clamp, widestAperture, narrowestAperture } from './constants';
import { autoExpose } from './exposure';
import { focalLength, normalizeFocus } from './optics';

export function createCameraState() {
  // `sceneEv` is what the meter measured; `afX`/`afY` are the position of the
  // autofocus box as a fraction of the frame, measured from the top left, and
  // `afState` drives its animation: idle, searching, locked or failed.
  // `world` names the scene the rig is pointed at ('street' or 'landscape'); the
  // renderer owns the geometry, the state only records which one is mounted.
  const state = reactive({ world: 'street', mode: 'Av', lens: 0, body: 0, aperture: 5, shutter: 13, iso: 2, zoom: 0, focusDistance: 3, whiteBalance: 5500, exposureComp: 0, lockSubject: true, grid: false, histogram: false, zebra: false, yaw: 0, pitch: 0, sensorNoise: true, cfa: false, peep: false, peepSpan: 64, peepX: 3000, peepY: 2000, sceneEv: SCENE_EV, metering: 'evaluative', afX: 0.5, afY: 0.5, afState: 'idle', viewfinder: false, shots: 0 });
  const reset = () => { state.yaw = 0; state.pitch = 0; state.focusDistance = 3; state.lockSubject = true; state.peepX = 3000; state.peepY = 2000; state.afState = 'idle'; state.afX = 0.5; state.afY = 0.5; };
  const currentLens = () => LENSES[state.lens];
  const focal = () => focalLength(currentLens(), state.zoom);
  const update = () => {
    state.aperture = clamp(state.aperture, widestAperture(currentLens()), narrowestAperture(currentLens()));
    state.shutter = clamp(state.shutter, 0, SHUTTERS.length - 1);
    state.iso = clamp(state.iso, 0, ISOS.length - 1);
    state.focusDistance = normalizeFocus(state.focusDistance, currentLens());
    if (state.lockSubject) state.focusDistance = 3;
    autoExpose(state, currentLens());
  };
  return { state, reset, currentLens, currentBody: () => BODIES[state.body], focal, update };
}
