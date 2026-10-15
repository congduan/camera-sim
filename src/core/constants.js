export const APERTURES = [1.2, 1.4, 1.6, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
// Index of the widest aperture a lens can actually open to. APERTURES runs from
// the fastest f-number to the slowest, so the apertures a lens may use are this
// index *and everything after it*: a lens whose maximum is f/1.8 can be set to
// f/1.8, f/2 and so on, but never to f/1.2.
export const widestAperture = lens => Math.max(0, APERTURES.findIndex(value => value >= lens.maxAperture));

// The other end of the same range: the last stop a lens's diaphragm reaches.
// A lens that closes to f/16 cannot be set to f/22, and a lens published as
// f/22 stops where the table ends because the table holds no slower stop.
export const narrowestAperture = lens => {
  const index = APERTURES.findLastIndex(value => value <= lens.minAperture);
  return index < 0 ? APERTURES.length - 1 : index;
};
// A contemporary mechanical shutter range, 30s to 1/8000s. The fast end matters
// because ISO raises the exposure value the meter has to reach.
export const SHUTTERS = [30, 15, 8, 4, 2, 1, 0.5, 0.25, 0.125, 1 / 15, 1 / 30, 1 / 60, 1 / 125, 1 / 250, 1 / 500, 1 / 1000, 1 / 2000, 1 / 4000, 1 / 8000];
export const ISOS = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200];
// Scene brightness value at ISO 100. EV 8 matches the lit street the 3D world
// renders, and keeps the whole aperture/shutter/ISO table usable: the default
// f/2.8 ISO 400 state meters to 1/125s.
export const SCENE_EV = 8;

import { MOUNTS as VERIFIED_MOUNTS, VERIFIED_BODIES, VERIFIED_LENSES } from '../data/equipment';
export const LENSES = VERIFIED_LENSES;
export const MOUNTS = VERIFIED_MOUNTS;
export const BODIES = VERIFIED_BODIES.map(({ sensorHeight, ...body }) => ({ ...body, sensorHeight: body.height }));

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const shutterLabel = value => value >= 1 ? `${value}s` : `1/${Math.round(1 / value)}s`;
