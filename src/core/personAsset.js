import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// ---------------------------------------------------------------------------
// Off-the-shelf character models.
//
// `people.js` builds a procedural figure, which is the fallback. When a rigged
// humanoid GLB is present at `public/models/person.glb` it is used for everyone
// in the world instead: measured, rescaled to the figure height, seated with its
// feet on the ground, and duplicated per person.
//
// Two things about real assets drive this module:
//
//  * Mixamo exports carry a root with scale 0.01 and a 90 degree rotation, so the
//    accessor bounds in the file are meaningless (the bundled model declares
//    184 x 44 x 183 units). Everything is measured from the world bounding box
//    after the transforms are applied.
//  * A skinned mesh must be duplicated with SkeletonUtils.clone(). A plain
//    Object3D.clone() leaves every copy bound to the same skeleton, so all the
//    characters would deform together as one body.
// ---------------------------------------------------------------------------

export const FIGURE_HEIGHT = 1.72;

// Eye line as a fraction of stature, from adult anthropometry. Places the
// autofocus face point on whichever model is loaded.
export const FACE_HEIGHT_FRACTION = 0.922;

// How the figure is turned to face +Z, which is the direction the procedural
// figure faces and the direction the scene places people in.
//
// 'auto' reads it off the skeleton: the toes point the way a character faces, so
// the bind pose foot-to-toe vector gives the heading. Left and right are averaged
// to cancel foot splay and the result is snapped to a quarter turn, so a model
// cannot end up permanently leaning. Pass a number to override.
export const MODEL_FACING = 'auto';

export const DEFAULT_MODEL = 'models/person.glb';

// Vite resolves the deployed base path, so this works from a repository
// subdirectory as well as from a domain root. A leading slash would not.
export function modelUrl(name = DEFAULT_MODEL) {
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

const IDLE_CLIP = /idle|stand|breath|pose|tpose/i;
const WALK_CLIP = /walk|jog|stroll/i;

/**
 * Chooses the clip to play for a given role.
 *
 * @param {THREE.AnimationClip[]} clips - Clips on the asset.
 * @param {'idle'|'walk'|null} kind - Role, or null to stay in the bind pose.
 * @return {?THREE.AnimationClip}
 */
export function pickClip(clips, kind) {
  if (kind === null || !clips || clips.length === 0) return null;
  const pattern = kind === 'walk' ? WALK_CLIP : IDLE_CLIP;
  return clips.find((clip) => pattern.test(clip.name))
    ?? clips.find((clip) => clip.name === '')
    ?? clips[0];
}

function findBone(root, pattern) {
  let hit = null;
  root.traverse((node) => { if (!hit && node.isBone && pattern.test(node.name)) hit = node; });
  return hit;
}

/**
 * Heading of the figure in its bind pose, as a rotation about +Y that would turn
 * it to face +Z.
 *
 * The toes are the signal: a foot bone points forward from the ankle, so the
 * direction from `Foot` to `ToeBase` is the facing direction. Note that glTF
 * node names are sanitised on load, so `mixamorig:LeftFoot` arrives as
 * `mixamorigLeftFoot`; the patterns below do not rely on the separator.
 *
 * @param {THREE.Object3D} body - Model root, already in its bind pose.
 * @return {number} Yaw in radians, a multiple of a quarter turn.
 */
export function detectFacing(body) {
  const total = new THREE.Vector3();
  let found = 0;
  for (const side of ['left', 'right']) {
    const foot = findBone(body, new RegExp(`${side}.*foot`, 'i'));
    const toe = findBone(body, new RegExp(`${side}.*toebase`, 'i')) ?? findBone(body, new RegExp(`${side}.*toe`, 'i'));
    if (!foot || !toe) continue;
    total.add(toe.getWorldPosition(new THREE.Vector3()).sub(foot.getWorldPosition(new THREE.Vector3())));
    found++;
  }
  if (found === 0 || Math.hypot(total.x, total.z) < 1e-6) return 0;
  return Math.round(Math.atan2(-total.x, total.z) / (Math.PI / 2)) * (Math.PI / 2);
}

/**
 * Wraps a loaded figure so it stands `height` tall, faces +Z, and has its feet on
 * the origin with the body centred.
 *
 * The figure keeps its own transform and is moved by a parent holder instead.
 * Offsetting the root directly would need the rotation and scale baked into it
 * undone by hand, since a Mixamo root carries both.
 *
 * @param {THREE.Object3D} body - The glTF scene root.
 * @param {number} height - Target stature in metres.
 * @param {number|'auto'} [facing] - Yaw to apply, or 'auto' to read it off the skeleton.
 * @return {?{holder: THREE.Group, scale: number, yaw: number, sourceHeight: number, clips: Array, facePoint: THREE.Vector3}}
 */
export function measureFigure(body, height = FIGURE_HEIGHT, facing = MODEL_FACING) {
  const holder = new THREE.Group();
  holder.add(body);

  // Facing is resolved before anything is measured, so the offsets below centre
  // the figure as it will actually be oriented rather than as it was authored.
  holder.updateMatrixWorld(true);
  const yaw = facing === 'auto' ? detectFacing(body) : facing;
  holder.rotation.y = yaw;
  holder.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  if (!(size.y > 1e-6)) return null;

  const scale = height / size.y;
  holder.scale.setScalar(scale);
  holder.position.set(
    -((box.min.x + box.max.x) / 2) * scale,
    -box.min.y * scale,
    -((box.min.z + box.max.z) / 2) * scale
  );

  body.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    // A skinned mesh's bounding volume does not follow its animation, so let it
    // skip culling rather than pop out of frame mid stride.
    if (node.isSkinnedMesh) node.frustumCulled = false;
  });

  return {
    holder,
    scale,
    yaw,
    sourceHeight: size.y,
    sourceSpan: size.clone(),
    clips: [],
    facePoint: new THREE.Vector3(0, height * FACE_HEIGHT_FRACTION, height * 0.035)
  };
}

/**
 * Loads the character model when it is present.
 *
 * @param {object} [options]
 * @param {string} [options.url] - Path relative to the deployment base.
 * @param {number} [options.height] - Target stature in metres.
 * @param {number} [options.timeout] - Milliseconds before abandoning the fetch.
 * @return {Promise<?object>} The measured asset, or null when unavailable.
 */
export async function loadPersonAsset({ url = DEFAULT_MODEL, height = FIGURE_HEIGHT, timeout = 5000 } = {}) {
  let timer;
  try {
    const gltf = await Promise.race([
      new GLTFLoader().loadAsync(modelUrl(url)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeout); })
    ]);
    const asset = measureFigure(gltf.scene, height);
    if (!asset) return null;
    asset.clips = gltf.animations ?? [];
    asset.source = url;
    return asset;
  } catch {
    return null;   // nothing shipped, or unreachable: the procedural figure stands in
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds one person from the asset. The caller owns placement and rotation.
 *
 * @param {object} asset - Result of {@link measureFigure}.
 * @param {object} [options]
 * @param {'idle'|'walk'|null} [options.clip] - Clip to play.
 * @param {number} [options.build] - Uniform stature variation around the nominal.
 * @param {number} [options.speed] - Playback rate for the clip.
 * @param {number} [options.phase] - Start offset as a fraction of the clip.
 * @return {{group: THREE.Group, mixer: ?THREE.AnimationMixer, clip: ?THREE.AnimationClip}}
 */
export function createPersonInstance(asset, { clip = 'idle', build = 1, speed = 1, phase = 0 } = {}) {
  const group = new THREE.Group();
  group.userData.isPerson = true;
  group.userData.facePoint = asset.facePoint.clone();
  group.scale.setScalar(build);

  const holder = cloneSkinned(asset.holder);
  group.add(holder);

  const chosen = pickClip(asset.clips, clip);
  let mixer = null;
  if (chosen) {
    // The clip's tracks address bones by name, and the clone preserves names, so
    // the mixer can bind straight to the copy.
    mixer = new THREE.AnimationMixer(holder);
    const action = mixer.clipAction(chosen);
    action.timeScale = speed;
    action.play();
    // Stagger the start so a crowd does not breathe in unison.
    if (phase > 0 && chosen.duration > 0) {
      action.time = (phase % 1) * chosen.duration;
      mixer.update(0);
    }
  }
  return { group, mixer, clip: chosen };
}
