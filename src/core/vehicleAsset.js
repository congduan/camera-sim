import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ---------------------------------------------------------------------------
// Off-the-shelf vehicle models.
//
// Mirrors `personAsset.js`: a rigged-free GLB is measured, rescaled, sat on the
// ground, turned to face +Z and duplicated. When no file is present the
// procedural box car in `scene3d.js` is used instead.
//
// Two things worth knowing about real car assets:
//
//  * Car paint is a shared material. Recolouring it in place would repaint every
//    vehicle at once, so each instance clones the paint material first.
//  * The heading has to come from the model, not from a constant. Two independent
//    signals are used and compared: the wheel node names normally spell out front
//    and rear, and the head lamps sit opposite the tail lamps.
// ---------------------------------------------------------------------------

// Overall length of the bundled model, a Ferrari 458 Italia.
export const VEHICLE_LENGTH = 4.53;

// Yaw applied to face +Z: 'auto' reads it off the model, or pass radians.
export const VEHICLE_FACING = 'auto';

export const DEFAULT_VEHICLE = 'models/car.glb';

// Paint colours used when an instance is not given one.
export const PAINT_COLOURS = [0x0e0f12, 0xd8dade, 0x6d7278, 0x1d2c4a, 0x7a1620, 0x2a2d31];

// Which materials make up the paintwork. Only these are recoloured per instance:
// tires, glass, chrome and interior have to keep the values the model shipped
// with, or a recoloured car turns into a single-coloured lump.
export const PAINT_MATERIAL = /body|paint/i;

// Vite resolves the deployed base path, so this works from a repository
// subdirectory as well as from a domain root. A leading slash would not.
function baseUrl() {
  return (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
}

export function vehicleUrl(name = DEFAULT_VEHICLE) {
  const base = baseUrl();
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

// The bundled model stores its geometry Draco compressed: 358k triangles in
// 1.7 MB, against roughly 11 MB uncompressed. The decoder is served from
// `public/draco/gltf/` rather than a CDN so the app keeps working offline and on
// networks that block third-party hosts.
export const DECODER_PATH = 'draco/gltf/';

export function decoderUrl(path = DECODER_PATH) {
  const base = baseUrl();
  return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

function collect(root, pattern) {
  const found = [];
  root.traverse((node) => { if (pattern.test(node.name)) found.push(node); });
  return found;
}

function centroid(nodes) {
  const sum = new THREE.Vector3();
  if (nodes.length === 0) return null;
  for (const node of nodes) sum.add(node.getWorldPosition(new THREE.Vector3()));
  return sum.divideScalar(nodes.length);
}

// Quarter turns only: assets are authored axis aligned, so snapping stops a
// slightly asymmetric measurement from leaving the car permanently askew.
function yawFrom(from, to) {
  if (!from || !to) return null;
  const delta = to.clone().sub(from);
  if (Math.hypot(delta.x, delta.z) < 1e-6) return null;
  return Math.round(Math.atan2(-delta.x, delta.z) / (Math.PI / 2)) * (Math.PI / 2);
}

/**
 * Heading of the vehicle as authored, from two independent cues.
 *
 * Wheels first: `wheel_fl`, `wheel_rr` and friends name their own corner, which
 * is the strongest signal available. Lamps second: head lamps sit opposite tail
 * lamps. Interior lamps are excluded, since names like `steering_red_lights`
 * would otherwise drag the tail centroid into the cabin.
 *
 * @param {THREE.Object3D} body - Model root, in its authored pose.
 * @return {{yaw: number, signals: {wheels: ?number, lamps: ?number}}}
 */
export function detectVehicleFacing(body) {
  body.updateMatrixWorld(true);

  const wheels = collect(body, /wheel/i);
  const wheelYaw = yawFrom(
    centroid(wheels.filter((node) => /wheel_?r|rear/i.test(node.name))),
    centroid(wheels.filter((node) => /wheel_?f|front/i.test(node.name)))
  );

  const lamps = collect(body, /light|lamp/i).filter((node) => !/steering|interior|dash|cabin|seat/i.test(node.name));
  const tails = lamps.filter((node) => /red|tail|brake/i.test(node.name));
  // A file may not label the head lamps at all, in which case whatever is left
  // after removing the tails is the other end of the car.
  const heads = lamps.filter((node) => /head|projector/i.test(node.name));
  const rest = lamps.filter((node) => !tails.includes(node) && !heads.includes(node));
  const lampYaw = yawFrom(centroid(tails), centroid(heads.length ? heads : rest));

  return { yaw: wheelYaw ?? lampYaw ?? 0, signals: { wheels: wheelYaw, lamps: lampYaw } };
}

/**
 * Wraps a loaded vehicle so it is `length` long, faces +Z, and has its wheels on
 * the ground with the body centred.
 *
 * @param {THREE.Object3D} body - The glTF scene root.
 * @param {number} length - Target overall length in metres.
 * @param {number|'auto'} [facing] - Yaw to apply, or 'auto' to read it off the model.
 * @return {?object} The measured asset, or null when the model has no size.
 */
export function measureVehicle(body, length = VEHICLE_LENGTH, facing = VEHICLE_FACING) {
  const holder = new THREE.Group();
  holder.add(body);

  holder.updateMatrixWorld(true);
  const detected = facing === 'auto' ? detectVehicleFacing(body) : { yaw: facing, signals: {} };
  holder.rotation.y = detected.yaw;
  holder.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  // The length is the longest horizontal axis once the car has been turned to
  // face +Z, which makes it independent of how the asset was authored.
  const span = Math.max(size.x, size.z);
  if (!(span > 1e-6) || !(size.y > 1e-6)) return null;

  const scale = length / span;
  holder.scale.setScalar(scale);
  holder.position.set(
    -((box.min.x + box.max.x) / 2) * scale,
    -box.min.y * scale,
    -((box.min.z + box.max.z) / 2) * scale
  );

  // The paint material is shared across the whole file, so it is cloned per
  // instance in createVehicleInstance(). Record which materials those are.
  const paintNames = new Set();
  body.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      const name = material?.name ?? '';
      if (PAINT_MATERIAL.test(name) || PAINT_MATERIAL.test(material?.type ?? '')) paintNames.add(name || material.type);
    }
  });

  return {
    holder,
    scale,
    yaw: detected.yaw,
    signals: detected.signals,
    sourceHeight: size.y,
    sourceSpan: size.clone(),
    paintMaterials: paintNames
  };
}

/**
 * Loads the vehicle model when it is present.
 *
 * @param {object} [options]
 * @param {string} [options.url] - Path relative to the deployment base.
 * @param {number} [options.length] - Target overall length in metres.
 * @param {number} [options.timeout] - Milliseconds before abandoning the fetch.
 * @return {Promise<?object>} The measured asset, or null when unavailable.
 */
export async function loadVehicleAsset({ url = DEFAULT_VEHICLE, length = VEHICLE_LENGTH, timeout = 8000 } = {}) {
  let timer;
  // Draco decoding runs in a worker, which costs more to start than the fetch
  // itself, hence the longer timeout. The worker is released once the model is in.
  const draco = new DRACOLoader();
  draco.setDecoderPath(decoderUrl());
  try {
    const gltf = await Promise.race([
      new GLTFLoader().setDRACOLoader(draco).loadAsync(vehicleUrl(url)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeout); })
    ]);
    const asset = measureVehicle(gltf.scene, length);
    if (!asset) return null;
    asset.source = url;
    return asset;
  } catch {
    return null;   // nothing shipped, decoder missing, or unreachable: the box car stands in
  } finally {
    clearTimeout(timer);
    draco.dispose();
  }
}

/**
 * Builds one vehicle. The caller owns placement and rotation.
 *
 * @param {object} asset - Result of {@link measureVehicle}.
 * @param {object} [options]
 * @param {number} [options.paint] - Paint colour for this instance.
 * @return {THREE.Group}
 */
export function createVehicleInstance(asset, { paint = PAINT_COLOURS[0] } = {}) {
  const group = new THREE.Group();
  group.userData.isVehicle = true;
  group.add(asset.holder.clone(true));

  // The clone shares materials with the source, and with every other instance,
  // so paint is duplicated before it is recoloured. One clone per distinct
  // material per instance keeps the rest of the file untouched.
  const swapped = new Map();
  group.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const repaint = (material) => {
      if (!asset.paintMaterials.has(material.name || material.type)) return material;
      let replacement = swapped.get(material);
      if (!replacement) {
        replacement = material.clone();
        // The file ships its paint as a dull dielectric, which reads as matte
        // plastic at night. Metallic with a tight highlight is what makes it look
        // like paintwork under the street lamps.
        replacement.color = new THREE.Color(paint);
        if ('metalness' in replacement) replacement.metalness = 0.85;
        if ('roughness' in replacement) replacement.roughness = 0.32;
        swapped.set(material, replacement);
      }
      return replacement;
    };
    node.material = Array.isArray(node.material) ? node.material.map(repaint) : repaint(node.material);
  });
  return group;
}
