import { APERTURES, BODIES, MOUNTS, clamp } from './constants';
import {
  apertureTransmission, cardinalPoints, compose, fitPolynomial, freeSpace, imageDistanceFromRearVertex,
  inverse, multiply, pupilGeometry, refraction, thinLens, traceBack
} from './rayTrace';

export { cardinalPoints, freeSpace, multiply, refraction, thinLens };

const WAVELENGTH = 550e-9;

// Mechanical allowances the model has to assume, because no manufacturer
// publishes element rims: the filter ring wall between the thread and the glass,
// the clearance a rear group leaves around the axial beam, and the gap between
// the mount throat and the last element.
const FRONT_WALL = 5;       // mm
const REAR_MARGIN = 1.35;   // × the exit pupil radius
const REAR_CLEARANCE = 3;   // mm
const FIELD_STEPS = 8;      // illumination samples from the axis to the corner

// Reference planes of the procedural scene, in metres. Every synthetic element
// the renderer draws is anchored to one of these planes so the light path can be
// solved for the real conjugate distance instead of a single global blur.
export const SCENE_DEPTHS = { subject: 4, lights: 26, buildings: 70, sky: Infinity };

export function focalLength(lens, zoom) {
  return lens.min === lens.max ? lens.min : lens.min * Math.pow(lens.max / lens.min, zoom / 100);
}

// ---------------------------------------------------------------------------
// Paraxial ray transfer (ABCD) engine.
// ---------------------------------------------------------------------------
export function imageDistance(focal, objectDistance) {
  return 1 / (1 / focal - 1 / objectDistance);
}

// Height of a marginal ray at a plane `planeDistance` behind the lens. The ray
// leaves an axial object point `objectDistance` in front of the lens at the edge
// of the entrance pupil and is refracted by the thin-lens matrix.
export function traceMarginalRay(focal, objectDistance, pupilRadius, planeDistance) {
  return multiply(freeSpace(planeDistance), multiply(thinLens(focal), freeSpace(objectDistance)))[1] * (pupilRadius / objectDistance);
}

// ---------------------------------------------------------------------------
// Spec-level pupils. `pupilMagnification` is the exit/entrance diameter ratio,
// so the exit pupil is the entrance pupil scaled by it — the relation the depth
// of field formulas are written in.
// ---------------------------------------------------------------------------
export function pupils(lens, focal, apertureIndex) {
  const fNumber = APERTURES[apertureIndex];
  const magnification = lens.pupilMagnification || 1;
  const entrance = focal / fNumber;
  return { fNumber, entrance, exit: entrance * magnification, magnification };
}

// ---------------------------------------------------------------------------
// Prescription.
//
// The published data pins down three numbers the light path has to obey: the
// focal length, the pupil magnification, and the back focus — which the mount
// register holds roughly constant in millimetres even as a zoom changes focal
// length. A two-group model has four parameters (two powers, a separation and a
// stop position) against those three constraints, so the layout is found by
// search instead of by solving, and only buildable candidates are considered:
//
//   u = 1/fF, v = 1/fB, d = the group separation, σ = the stop position in d
//
//     back focus    BFD = f (1 - d·u)                 -> d·u = 1 - BFD/f
//     pupil mag.    P   = |1 - σ d·u| / |1 - (1-σ) d·v|
//     focal length  1/f = u + v - d·u·v               -> d = f (d·u + d·v - d·u·d·v)
//
// The last condition, D = 1 - (1-σ) d·v > 0, is what makes a layout realisable:
// it says the stop sits inside the rear group's focal length, so the exit pupil
// is virtual and the rear group throws no aperture behind the film. Retrofocus
// wide-angles and long telephotos push past what two groups can express, so for
// them the search returns the closest realisable pupil magnification and the
// published one stays on the blur path, where the depth of field formulas want
// it anyway.
// ---------------------------------------------------------------------------
const STOP_POSITIONS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
const BACK_FOCUS_RATIOS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.25, 2.5, 2.75, 3, 3.5];
const REAR_RATIOS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.5, 2, 2.5, 3];

function layoutFor(stop, ratio, rear) {
  const front = 1 - ratio;                                 // d·u
  const frontScale = 1 - stop * front;                     // A element in front of the stop
  const rearScale = 1 - (1 - stop) * rear;                 // D element behind the stop
  const length = front + rear - front * rear;              // d / f
  if (!(length > 0.2) || !(rearScale > 0.05)) return null;
  return { front, rear, length, backFocus: ratio, stop, pupil: Math.abs(frontScale / rearScale) };
}

export function solveGroups(focal, backFocus, magnification) {
  let best = null;
  for (const stop of STOP_POSITIONS) {
    for (const ratio of BACK_FOCUS_RATIOS) {
      for (const rear of REAR_RATIOS) {
        const candidate = layoutFor(stop, ratio, rear);
        if (!candidate) continue;
        // The back focus is weighted hardest: it is a mechanical fact of the
        // mount, and a model whose image plane sits inside the barrel takes the
        // field angle, and with it the illumination, with it. The pupil
        // magnification is already an estimate, so it only pulls softly.
        const score = 1.5 * Math.abs(Math.log(candidate.backFocus * focal / backFocus))
          + 0.35 * Math.abs(Math.log(candidate.pupil / magnification))
          + 0.25 * Math.abs(stop - 0.5)
          + 0.05 * candidate.length;
        if (!best || score < best.score) best = { ...candidate, score };
      }
    }
  }
  const groups = best || { front: 1, rear: 1, length: 1, backFocus: 1, stop: 0.5, pupil: 1 };
  return {
    front: groups.length * focal / groups.front,
    rear: groups.length * focal / groups.rear,
    separation: groups.length * focal,
    backFocus: groups.backFocus * focal,
    stopPosition: groups.stop,
    pupil: groups.pupil
  };
}

export function buildModel(lens, focal, apertureIndex, focusDistance) {
  const fNumber = APERTURES[apertureIndex];
  const groups = solveGroups(focal, lens.backFocus || focal, lens.pupilMagnification || 1);
  const stopPosition = groups.stopPosition;
  const entrance = focal / fNumber;
  const surfaces = [
    { focal: groups.front, semiDiameter: (lens.filter - FRONT_WALL) / 2, gap: groups.separation * stopPosition },
    { semiDiameter: entrance, gap: groups.separation * (1 - stopPosition) },
    { focal: groups.rear, semiDiameter: Infinity }
  ];
  // Size the stop so the entrance pupil lands on f/N. Pupil sizes do not depend
  // on the stop diameter, so a single correction pass is exact.
  const scale = Math.abs(pupilGeometry(surfaces, 1).entrance.magnification);
  surfaces[1].semiDiameter = scale > 1e-3 ? entrance / 2 / scale : entrance / 2;
  const geometry = pupilGeometry(surfaces, 1);
  const imageDistance = imageDistanceFromRearVertex(surfaces, focusDistance * 1000);
  const exitMagnification = Math.abs(geometry.exit.magnification);
  const exitRadius = surfaces[1].semiDiameter * exitMagnification;
  // The rear rim is a mechanical part, so it does not move when the diaphragm
  // closes: it is sized from the widest beam the lens ever has to pass, which is
  // the tighter of the mount throat and the wide-open exit pupil plus clearance.
  const wideOpenExit = focal / (2 * lens.maxAperture) * (lens.pupilMagnification || 1);
  const throat = MOUNTS[lens.mount] || MOUNTS.EF;
  surfaces[2].semiDiameter = Math.min(throat / 2 - REAR_CLEARANCE, wideOpenExit * REAR_MARGIN);
  return {
    surfaces,
    stopIndex: 1,
    fNumber,
    groups,
    entrance,
    exitRadius,
    imageDistance,
    entranceDistance: -geometry.entrance.at,          // mm in front of the first surface
    exitDistance: imageDistance - geometry.exit.at,   // exit pupil -> image plane
    separation: groups.separation,
    total: groups.separation + imageDistance
  };
}

// ---------------------------------------------------------------------------
// Illumination. Two effects, both derived rather than tuned:
//   * the cos⁴ law, from the angle the chief ray subtends at the exit pupil;
//   * mechanical vignetting, from the fraction of the stop that survives every
//     rim for that field height (see `apertureTransmission`).
// The pair is returned as samples for the panel and as two cubic polynomials in
// (h/hcorner)² for the shader, which evaluates them per pixel.
// ---------------------------------------------------------------------------
export function relativeIllumination(model, body) {
  const { surfaces, stopIndex, imageDistance, exitRadius, exitDistance } = model;
  const corner = 0.5 * Math.hypot(body.width, body.height);
  const stopRadius = surfaces[stopIndex].semiDiameter;
  const maps = compose(surfaces).rest.map(matrix => inverse(multiply(freeSpace(imageDistance), matrix)));
  const [stopA, stopB] = maps[stopIndex];
  const samples = [];
  for (let i = 0; i <= FIELD_STEPS; i++) {
    const fraction = i / FIELD_STEPS;
    const height = corner * fraction;
    const chiefSlope = -(stopA * height) / stopB;      // passes through the stop centre
    const unitSlope = (1 - stopA * height) / stopB;    // crosses the stop 1 mm off axis
    const chief = maps.map(([A, B]) => A * height + B * chiefSlope);
    const unit = maps.map(([A, B]) => A * height + B * unitSlope);
    const clips = [];
    for (let s = 0; s < surfaces.length; s++) {
      if (s === stopIndex || !Number.isFinite(surfaces[s].semiDiameter)) continue;
      const scale = unit[s] - chief[s];
      if (Math.abs(scale) < 1e-6) continue;
      clips.push({ scale, shift: chief[s], semiDiameter: surfaces[s].semiDiameter });
    }
    const mechanical = apertureTransmission(stopRadius, clips);
    const natural = (exitDistance / Math.hypot(height, exitDistance)) ** 4;
    samples.push({ fraction, height, natural, mechanical, relative: natural * mechanical });
  }
  // The axial value is the reference by definition: the rim diameters are
  // calibrated estimates, and one that pinches the axial beam would otherwise
  // darken the whole frame instead of the corners.
  const reference = samples[0].mechanical || 1;
  let floor = 1;
  const normalised = samples.map((sample) => {
    // The aperture sampling leaves a per-mille of noise, and a falloff cannot
    // rise with field height, so the curve is clamped monotone before fitting.
    floor = Math.min(floor, Math.min(1, sample.mechanical / reference));
    const mechanical = floor;
    return { ...sample, mechanical, relative: sample.natural * mechanical };
  });
  return {
    samples: normalised,
    illumination: fitPolynomial(normalised.map(sample => [sample.fraction ** 2, sample.relative])),
    transmission: fitPolynomial(normalised.map(sample => [sample.fraction ** 2, sample.mechanical])),
    corner: normalised[normalised.length - 1],
    cornerRadius: corner,
    halfAngle: Math.atan(corner / exitDistance) * 180 / Math.PI
  };
}

// Cross-section of the model for the panel: the rim apertures, the axial
// marginal ray and the chief ray of the corner field, all traced through the
// same surfaces the illumination was solved on.
function buildDiagram(model, corner) {
  const { surfaces, imageDistance, exitRadius, exitDistance } = model;
  const z = [];
  let running = 0;
  for (const surface of surfaces) {
    z.push(running);
    running += surface.gap || 0;
  }
  const image = running + imageDistance;
  const marginal = traceBack(surfaces, imageDistance, [0, -exitRadius / exitDistance]);
  const chief = traceBack(surfaces, imageDistance, [corner, corner / exitDistance]);
  const line = (ray, planeHeight) => [...ray.map((hit, i) => [z[i], hit.y]), [image, planeHeight]];
  const rims = surfaces.map(surface => Number.isFinite(surface.semiDiameter) ? surface.semiDiameter : 0);
  const widest = Math.max(...rims, ...marginal.map(hit => Math.abs(hit.y)), ...chief.map(hit => Math.abs(hit.y)));
  return {
    length: image,
    height: widest * 1.1,
    image,
    surfaces: surfaces.map((surface, i) => ({ z: z[i], semi: Number.isFinite(surface.semiDiameter) ? surface.semiDiameter : widest })),
    marginal: line(marginal, 0),
    chief: line(chief, corner)
  };
}

// Radius (mm) of the blur disc formed at the sensor by an object sitting on
// `depth` (metres) when focus is set to `focusDistance` (metres). The marginal
// ray of the defocused cone is traced through the exit pupil, so the result is
// the classical circle of confusion rather than a tuned constant.
export function blurRadius(lens, focal, apertureIndex, focusDistance, depth) {
  const { exit } = pupils(lens, focal, apertureIndex);
  const v = imageDistance(focal, focusDistance * 1000);
  const target = Number.isFinite(depth) ? imageDistance(focal, depth * 1000) : focal;
  return Math.abs(exit / 2 * (v - target) / target);
}

// Airy disc radius (mm) at the sensor for the current f-number.
export function diffractionRadius(apertureIndex) {
  return 1.22 * WAVELENGTH * APERTURES[apertureIndex] * 1000;
}

// Full light path for the current lens/body/exposure. Radii are returned both in
// millimetres and normalised to the frame height, which is the unit the renderer
// works in.
export function computeLightPath({ lens, focal, apertureIndex, focusDistance, body }) {
  const stop = pupils(lens, focal, apertureIndex);
  const imageDist = imageDistance(focal, focusDistance * 1000);
  const airy = diffractionRadius(apertureIndex);
  const height = body.sensorHeight;
  const coc = {}; const psf = {}; const layers = {};
  for (const [name, depth] of Object.entries(SCENE_DEPTHS)) {
    const radius = blurRadius(lens, focal, apertureIndex, focusDistance, depth);
    layers[name] = { depth, radius };
    coc[name] = radius / height;
    psf[name] = Math.hypot(radius, airy) / height;
  }
  const model = buildModel(lens, focal, apertureIndex, focusDistance);
  const vignetting = relativeIllumination(model, body);
  const corner = 0.5 * Math.hypot(body.width, body.height);
  return {
    stop: {
      ...stop,
      stopDiameter: model.surfaces[model.stopIndex].semiDiameter * 2,
      entranceDistance: model.entranceDistance,
      exitDistance: model.exitDistance,
      tracedExit: model.exitRadius * 2
    },
    imageDistance: imageDist,
    backFocal: imageDist,
    diffraction: airy,
    coc, psf, layers, sensorHeight: height,
    model,
    vignetting,
    diagram: buildDiagram(model, corner)
  };
}

export function hyperfocal(focal, aperture, body) {
  const coc = body.crop > 1.2 ? 0.019 : 0.03;
  return (focal * focal / (aperture * coc) + focal) / 1000;
}

export function depthOfField({ focal, apertureIndex, focusDistance, bodyIndex }) {
  const body = BODIES[bodyIndex];
  const aperture = APERTURES[apertureIndex];
  const h = hyperfocal(focal, aperture, body);
  const f = focal / 1000;
  const near = focusDistance * (h - f) / (h + focusDistance - 2 * f);
  const far = focusDistance >= h * 0.5 ? Infinity : focusDistance * (h - f) / (h - focusDistance);
  return { near: Math.max(0.01, near), far, hyperfocal: h };
}

export function normalizeFocus(distance, lens) {
  return clamp(distance, lens.mfd, 30);
}

export function airyRadius(focal, aperture) {
  return 1.22 * 550e-9 / (focal / 1000 / (2 * aperture));
}
