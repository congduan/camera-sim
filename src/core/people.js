import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Humanoid builder.
//
// Parts are assembled from primitives in the figure's own space — feet on y = 0,
// head towards +y, facing +z — and then merged per material, so a person with a
// sculpted face still costs six draw calls instead of thirty.
//
// Proportions follow a 1.72 m adult. Facial features are seated on the head
// ellipsoid through headSurface() rather than eyeballed, which keeps the nose,
// eyes and brows on the face whenever a proportion is adjusted.
// ---------------------------------------------------------------------------

export const HEAD_CENTRE = [0, 1.596, 0.006];
export const HEAD_RADII = [0.0755, 0.104, 0.084];
export const FIGURE_HEIGHT = 1.710;
export const SHOULDER_WIDTH = 0.430;

// The eye plane, used by the autofocus box to snap onto a face.
export const FACE_POINT = [0, 1.586, 0.062];

/** Depth of the head ellipsoid at (x, y), or null outside the silhouette. */
export function headSurface(x, y) {
  const nx = (x - HEAD_CENTRE[0]) / HEAD_RADII[0];
  const ny = (y - HEAD_CENTRE[1]) / HEAD_RADII[1];
  const rest = 1 - nx * nx - ny * ny;
  return rest <= 0 ? null : HEAD_CENTRE[2] + HEAD_RADII[2] * Math.sqrt(rest);
}

let templates = null;

function createTemplates() {
  return {
    unit: new THREE.SphereGeometry(1, 18, 14),
    unitLow: new THREE.SphereGeometry(1, 12, 9),
    head: new THREE.SphereGeometry(1, 28, 20),
    hairShell: new THREE.SphereGeometry(1, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.62),
    pyramid: new THREE.ConeGeometry(1, 1, 4),
    box: new THREE.BoxGeometry(1, 1, 1),
    neck: new THREE.CylinderGeometry(0.048, 0.058, 0.140, 16),
    chest: new THREE.CylinderGeometry(0.155, 0.132, 0.360, 20),
    pelvis: new THREE.CylinderGeometry(0.130, 0.148, 0.160, 20),
    collar: new THREE.CylinderGeometry(0.066, 0.050, 0.055, 18),
    upperArm: new THREE.CylinderGeometry(0.050, 0.041, 0.290, 14),
    foreArm: new THREE.CylinderGeometry(0.041, 0.034, 0.270, 14),
    thigh: new THREE.CylinderGeometry(0.072, 0.055, 0.420, 16),
    shin: new THREE.CylinderGeometry(0.055, 0.038, 0.400, 16)
  };
}

function getTemplates() {
  if (!templates) templates = createTemplates();
  return templates;
}

/** Releases the shared source geometries. Merged copies are unaffected. */
export function disposePeople() {
  if (!templates) return;
  for (const geometry of Object.values(templates)) geometry.dispose();
  templates = null;
}

function baked(geometry, position, scale, rotation) {
  const clone = geometry.clone();
  clone.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rotation ?? [0, 0, 0]))),
    new THREE.Vector3(...(scale ?? [1, 1, 1]))
  ));
  return clone;
}

// A feature sitting `inset` below the head surface at (x, y).
function seat(x, y, inset) {
  return [x, y, headSurface(x, y) - inset];
}

function partList(style) {
  const T = getTemplates();
  const parts = [];
  const add = (bucket, geometry, position, scale, rotation) => parts.push([bucket, geometry, position, scale, rotation]);
  const mirror = (bucket, geometry, position, scale, rotation) => {
    add(bucket, geometry, position, scale, rotation);
    add(bucket, geometry, [-position[0], position[1], position[2]], scale, rotation ? [-rotation[0], -rotation[1], -rotation[2]] : null);
  };

  // --- head, the part a portrait actually looks at -------------------------
  add('skin', T.head, HEAD_CENTRE, HEAD_RADII);                                    // cranium and face mass
  add('skin', T.unit, [0, 1.520, 0.030], [0.060, 0.037, 0.048]);                   // jaw and chin
  mirror('skin', T.unitLow, [0.041, 1.545, 0.052], [0.026, 0.020, 0.022]);         // cheekbones
  add('skin', T.pyramid, seat(0, 1.564, 0.006), [0.0135, 0.046, 0.0135], [Math.PI / 2 + 0.32, 0, 0]);  // nose
  add('skin', T.unitLow, seat(0, 1.607, 0.011), [0.046, 0.011, 0.020]);            // brow ridge
  add('skin', T.unitLow, seat(0, 1.527, 0.007), [0.024, 0.009, 0.013]);            // lips
  mirror('skin', T.unitLow, [0.0715, 1.573, -0.004], [0.0078, 0.026, 0.016]);      // ears
  add('skin', T.neck, [0, 1.462, -0.002]);                                         // neck
  add('skin', T.unit, [0, 1.402, -0.014], [0.135, 0.030, 0.070]);                  // trapezius
  mirror('skin', T.unit, [0.190, 0.808, 0.014], [0.021, 0.040, 0.030]);            // hands

  add('eye', T.unit, seat(0.032, 1.586, 0.006), [0.0115, 0.0115, 0.0115]);         // one eye
  mirror('eye', T.unit, seat(0.032, 1.586, 0.006), [0.0115, 0.0115, 0.0115]);

  // --- hair, plus the two dark features that make a face read ---------------
  add('hair', T.hairShell, [0, 1.598, -0.002], [0.082, 0.112, 0.092]);             // crown, hairline at the brow
  add('hair', T.unit, [0, 1.588, -0.036], [0.080, 0.104, 0.078]);                  // mass at the back
  mirror('hair', T.unitLow, seat(0.033, 1.608, 0.005), [0.019, 0.0045, 0.008]);    // brows
  add('hair', T.unitLow, seat(0, 1.521, 0.003), [0.020, 0.0035, 0.006]);           // mouth line
  if (style === 'medium' || style === 'long') {
    mirror('hair', T.unit, [0.073, 1.556, -0.014], [0.016, 0.048, 0.058]);
  }
  if (style === 'long') {
    add('hair', T.unit, [0, 1.480, -0.050], [0.070, 0.092, 0.048]);
  }

  // --- clothing -------------------------------------------------------------
  add('coat', T.chest, [0, 1.260, 0], [1, 1, 0.76]);
  add('coat', T.collar, [0, 1.448, -0.004]);
  mirror('coat', T.unit, [0.145, 1.404, -0.004], [0.070, 0.045, 0.052]);
  mirror('coat', T.upperArm, [0.190, 1.256, 0.004], null, [0, 0, -0.055]);
  mirror('coat', T.foreArm, [0.200, 0.982, 0.008], null, [0, 0, -0.030]);

  // --- lower body ----------------------------------------------------------
  add('lower', T.pelvis, [0, 1.000, 0], [1, 1, 0.80]);
  mirror('lower', T.thigh, [0.086, 0.710, 0], null, [0, 0, -0.012]);
  mirror('lower', T.shin, [0.088, 0.300, 0.004]);
  mirror('shoe', T.box, [0.088, 0.037, 0.036], [0.098, 0.074, 0.248]);

  return parts;
}

// Every part of the figure, with the bucket each one merges into. Exposed so the
// layout can be checked without a GPU.
export function personParts(style = 'short') {
  return partList(style).map(([bucket, , position, scale, rotation]) => ({ bucket, position, scale, rotation }));
}

/**
 * Builds one person as a small group of merged meshes.
 *
 * @param {object} materials - `{ skin, hair, eye, coat, trousers, shoes }`.
 * @param {string} [style] - Hair style: short, medium or long.
 * @return {THREE.Group}
 */
export function buildPerson(materials, style = 'short') {
  const group = new THREE.Group();
  group.userData.isPerson = true;
  group.userData.facePoint = new THREE.Vector3(...FACE_POINT);

  const buckets = { skin: [], hair: [], eye: [], coat: [], lower: [], shoe: [] };
  for (const [bucket, geometry, position, scale, rotation] of partList(style)) {
    buckets[bucket].push(baked(geometry, position, scale, rotation));
  }

  const byBucket = { skin: materials.skin, hair: materials.hair, eye: materials.eye, coat: materials.coat, lower: materials.trousers, shoe: materials.shoes };
  for (const [bucket, list] of Object.entries(buckets)) {
    if (list.length === 0) continue;
    const merged = mergeGeometries(list, false);
    for (const geometry of list) geometry.dispose();
    const mesh = new THREE.Mesh(merged, byBucket[bucket]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
