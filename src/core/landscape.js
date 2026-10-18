import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, dot, float, max, mix, normalize, positionLocal, pow, smoothstep, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPerson, disposePeople } from './people';
import { createPersonInstance } from './personAsset';

// ---------------------------------------------------------------------------
// The daytime landscape: a meadow lane above a lake, with a hedge, trees and
// wild flowers in the near field so a wide aperture has real foliage to melt,
// and a layered horizon (beach, tree line, hills, snow peaks) so the telephoto
// compression is visible. It is built like the street — genuine geometry and
// PBR materials under a sun — so depth of field, bokeh and autofocus all solve
// against the same buffers rather than against a painted backdrop.
//
// Colours here are authored in linear light where the sky dome and the fog meet
// (the dome writes raw linear values and `scene.fog` tints in the linear working
// space), and in sRGB hex for material albedos, which three converts for us.
// ---------------------------------------------------------------------------

// Bright-but-not-blown daylight. The meter calibrates its first reading to this
// value, so a sunny landscape reads on the EV scale where a sunny landscape
// belongs instead of inheriting the street's EV 8.
export const DAY_EV = 13;

// Hazy near-horizon against a deeper blue overhead. Both linear.
export const DAY_HORIZON = [0.54, 0.62, 0.74];
export const DAY_ZENITH = [0.07, 0.15, 0.42];
const FOG_COLOUR = [0.56, 0.64, 0.75];

const DOME_RADIUS = 900;
const PATH_HALF = 1.5;
const SHORE_Z = -112;

// Sun about 40 degrees up and a little to the left of the lens, and behind the
// camera: the light lands on the faces the lens sees, which is what a landscape
// shot in the morning actually looks like. A backlit sun would read as a
// silhouette and leave every face in the frame two stops down.
const SUN_DIR = new THREE.Vector3(-0.58, 0.52, 0.62).normalize();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function canvasTexture(size, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  paint(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

// Mottled turf: large tonal patches for the mid distance, single-pixel speckle
// and a scatter of lighter blades for the ground right under the lens.
function grassTexture() {
  const texture = canvasTexture(256, (ctx, size) => {
    ctx.fillStyle = '#6d8a49';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 240; i++) {
      const shade = 0.8 + Math.random() * 0.4;
      ctx.fillStyle = `rgba(${Math.round(96 * shade)},${Math.round(126 * shade)},${Math.round(62 * shade)},0.55)`;
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, 6 + Math.random() * 18, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 4200; i++) {
      const shade = 0.72 + Math.random() * 0.56;
      ctx.fillStyle = `rgba(${Math.round(92 * shade)},${Math.round(124 * shade)},${Math.round(58 * shade)},0.6)`;
      const grain = Math.random() < 0.85 ? 1 : 2;
      ctx.fillRect(Math.random() * size, Math.random() * size, grain, grain);
    }
    for (let i = 0; i < 300; i++) {
      ctx.strokeStyle = `rgba(${140 + Math.random() * 40},${172 + Math.random() * 40},${88 + Math.random() * 30},0.4)`;
      ctx.lineWidth = 1;
      const x = Math.random() * size; const y = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 5, y - 3 - Math.random() * 6);
      ctx.stroke();
    }
  });
  texture.repeat.set(200, 200);
  return texture;
}

// Dry earth, sun-bleached at the edges where the verge meets the lane.
function laneTexture() {
  const texture = canvasTexture(128, (ctx, size) => {
    ctx.fillStyle = '#8d7a55';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {
      const shade = 0.74 + Math.random() * 0.5;
      ctx.fillStyle = `rgba(${Math.round(150 * shade)},${Math.round(130 * shade)},${Math.round(94 * shade)},0.65)`;
      const grain = Math.random() < 0.88 ? 1 : 2;
      ctx.fillRect(Math.random() * size, Math.random() * size, grain, grain);
    }
    // Wheel ruts: two darker tracks, the thing that makes a lane read as driven.
    for (const x of [34, 94]) {
      ctx.fillStyle = 'rgba(96,82,58,0.35)';
      ctx.fillRect(x - 9, 0, 18, size);
    }
    ctx.fillStyle = 'rgba(126,146,84,0.5)';   // turf creeping back down the middle
    ctx.fillRect(58, 0, 12, size);
  });
  texture.repeat.set(1, 26);
  return texture;
}

function mesh(geometry, material, position, rotation) {
  const node = new THREE.Mesh(geometry, material);
  node.position.set(position[0], position[1], position[2]);
  if (rotation) node.rotation.set(rotation[0], rotation[1], rotation[2]);
  node.castShadow = true; node.receiveShadow = true;
  return node;
}

// Clones of an asset share their buffers with it (SkeletonUtils and
// Object3D.clone both do), so a world that comes and goes must not dispose them.
function shareAssetBuffers(root) {
  root.traverse((node) => { if (node.isMesh) node.userData.sharedAsset = true; });
}

// One merged geometry for a whole scatter, so a field of flowers costs a single
// draw call instead of one per bloom.
function scatterGeometry(geometry, placements) {
  const parts = [];
  const quaternion = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  for (const { position, scale } of placements) {
    matrix.compose(position, quaternion, scale);
    const part = geometry.clone();
    part.applyMatrix4(matrix);
    parts.push(part);
  }
  return mergeGeometries(parts, false);
}

/**
 * Builds the daytime landscape world.
 *
 * @param {object} [options]
 * @param {?object} [options.personAsset] - Rigged model from `personAsset.js`.
 *   When omitted, or null, the procedural figure is used.
 * @return {object} The world handle. `ev` is the scene brightness the meter
 *   calibrates itself against, `id` lets the renderer tell the worlds apart.
 */
export function buildLandscapeWorld({ personAsset = null } = {}) {
  const rand = mulberry32(20261018);
  const scene = new THREE.Scene();
  const fog = new THREE.Fog(new THREE.Color().setRGB(FOG_COLOUR[0], FOG_COLOUR[1], FOG_COLOUR[2]), 90, 1000);
  scene.fog = fog;
  scene.background = new THREE.Color().setRGB(DAY_ZENITH[0], DAY_ZENITH[1], DAY_ZENITH[2]);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitSphere = new THREE.IcosahedronGeometry(1, 1);
  const unitBoulder = new THREE.IcosahedronGeometry(1, 0);
  const unitTrunk = new THREE.CylinderGeometry(1, 1.25, 1, 9);
  const unitCone = new THREE.ConeGeometry(1, 1, 9);
  const unitMound = new THREE.SphereGeometry(1, 26, 16);

  const grass = new THREE.MeshStandardNodeMaterial({ map: grassTexture(), roughness: 1.0, metalness: 0.0 });
  const lane = new THREE.MeshStandardNodeMaterial({ map: laneTexture(), roughness: 0.94, metalness: 0.0 });
  const sand = new THREE.MeshStandardNodeMaterial({ color: 0xa89a7c, roughness: 0.92, metalness: 0.0 });
  const water = new THREE.MeshStandardNodeMaterial({ color: 0x3a6d8a, roughness: 0.10, metalness: 0.15, emissive: 0x2a5872, emissiveIntensity: 1.15 });
  const bark = new THREE.MeshStandardNodeMaterial({ color: 0x4c3c2a, roughness: 0.9, metalness: 0.0 });
  const leaf = [0x33602c, 0x3f6f31, 0x27491f, 0x4b7a38].map((color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.78, metalness: 0.0 }));
  const conifer = new THREE.MeshStandardNodeMaterial({ color: 0x22452a, roughness: 0.82, metalness: 0.0 });
  const rock = new THREE.MeshStandardNodeMaterial({ color: 0x7f8078, roughness: 0.95, metalness: 0.02 });
  const wood = new THREE.MeshStandardNodeMaterial({ color: 0x6b543a, roughness: 0.88, metalness: 0.0 });
  const petalTone = new THREE.MeshStandardNodeMaterial({ color: 0xe8c85c, roughness: 0.55, metalness: 0.0 });
  const stemTone = new THREE.MeshStandardNodeMaterial({ color: 0x4c6b32, roughness: 0.7, metalness: 0.0 });

  // --- meadow, lane and shore ---------------------------------------------
  const ground = mesh(new THREE.PlaneGeometry(1400, 1400), grass, [0, -0.02, -280], [-Math.PI / 2, 0, 0]);
  ground.castShadow = false;
  scene.add(ground);

  const path = mesh(new THREE.PlaneGeometry(PATH_HALF * 2, 120), lane, [0, 0.008, -55], [-Math.PI / 2, 0, 0]);
  path.castShadow = false;
  scene.add(path);

  const beach = mesh(new THREE.PlaneGeometry(340, 9), sand, [0, 0.004, SHORE_Z - 1], [-Math.PI / 2, 0, 0]);
  beach.castShadow = false;
  scene.add(beach);

  // --- lake ----------------------------------------------------------------
  // One large surface at the end of the lane. Low roughness plus the sun gives a
  // genuine specular streak on the water; the emissive stands in for the sky it
  // would mirror, which is most of what a lake actually looks like.
  const lake = mesh(new THREE.PlaneGeometry(420, 170), water, [0, 0.012, SHORE_Z - 85], [-Math.PI / 2, 0, 0]);
  lake.castShadow = false;
  scene.add(lake);

  // --- hills and mountains -------------------------------------------------
  // Green mounds close the far shore, then faceted rock and snow above them.
  // Fog does the aerial perspective, so the layers read as depth, not as props.
  const hillTones = [0x51703a, 0x466435, 0x5c7b42];
  for (let i = 0; i < 9; i++) {
    const radiusX = 80 + rand() * 40;
    const radiusY = 16 + rand() * 16;
    const hill = mesh(unitMound, new THREE.MeshStandardNodeMaterial({ color: hillTones[i % hillTones.length], roughness: 0.95, metalness: 0.0 }), [(rand() - 0.5) * 620, -radiusY * 0.62, -330 - rand() * 40]);
    hill.scale.set(radiusX, radiusY, radiusX * (0.6 + rand() * 0.5));
    hill.castShadow = false;
    scene.add(hill);
  }

  const rockTone = new THREE.MeshStandardNodeMaterial({ color: 0x6d7c8f, roughness: 0.95, metalness: 0.0, flatShading: true });
  const snowTone = new THREE.MeshStandardNodeMaterial({ color: 0xdde6ef, roughness: 0.8, metalness: 0.0, flatShading: true });
  for (let i = 0; i < 11; i++) {
    // Low and broad rather than tall: at 700 m even a 200 m peak would fill the
    // frame, and what a real range shows above a lake is a long hazy ridge.
    const height = 45 + rand() * 55;
    const radius = 260 + rand() * 200;
    const x = (rand() - 0.5) * 1500;
    const z = -720 - rand() * 90;
    const peak = mesh(unitCone, rockTone, [x, height / 2, z], [0, rand() * Math.PI, 0]);
    peak.scale.set(radius, height, radius * (0.7 + rand() * 0.5));
    peak.castShadow = false;
    const cap = mesh(unitCone, snowTone, [x, height * 0.84, z], [0, rand() * Math.PI, 0]);
    cap.scale.set(radius * 0.33, height * 0.32, radius * 0.33);
    cap.castShadow = false;
    scene.add(peak, cap);
  }

  // --- trees ---------------------------------------------------------------
  // Broadleaf here, conifer there: the two silhouettes are what make a tree line
  // read as a tree line at 60 m. Each tree is a trunk plus three crown blobs off
  // shared unit geometry, so shading and shadows cost almost nothing.
  const buildTree = (height, kind) => {
    const group = new THREE.Group();
    const trunkHeight = height * (kind === 'pine' ? 0.34 : 0.46);
    const trunkRadius = 0.06 + height * 0.022;
    const trunk = mesh(unitTrunk, bark, [0, trunkHeight / 2, 0]);
    trunk.scale.set(trunkRadius, trunkHeight, trunkRadius);
    group.add(trunk);
    const tone = kind === 'pine' ? conifer : leaf[Math.floor(rand() * leaf.length)];
    if (kind === 'pine') {
      for (let tier = 0; tier < 3; tier++) {
        const radius = height * (0.27 - 0.055 * tier);
        const cone = mesh(unitCone, tone, [0, height * (0.36 + 0.19 * tier), 0]);
        cone.scale.set(radius, height * 0.34, radius);
        group.add(cone);
      }
      return group;
    }
    const crownRadius = height * 0.27;
    const crownBase = trunkHeight + crownRadius * 0.55;
    const blobs = [
      [0, 0, 0, 1],
      [crownRadius * 0.62, -crownRadius * 0.22, crownRadius * 0.30, 0.72],
      [-crownRadius * 0.54, -crownRadius * 0.12, -crownRadius * 0.36, 0.68]
    ];
    for (const [x, y, z, scale] of blobs) {
      const blob = mesh(unitSphere, tone, [x, crownBase + y + crownRadius * scale * 0.6, z]);
      blob.scale.set(crownRadius * scale, crownRadius * scale * 0.88, crownRadius * scale);
      group.add(blob);
    }
    return group;
  };

  const plantTree = (x, z, height, kind) => {
    const tree = buildTree(height, kind);
    tree.position.set(x, 0, z);
    tree.rotation.y = rand() * Math.PI * 2;
    scene.add(tree);
  };

  // Near field, hand placed around the lane so the frame always has one trunk
  // for scale and one canopy edge to break up the sky.
  plantTree(7.6, -9.5, 8.6, 'broad');
  plantTree(-6.8, -14.5, 7.4, 'broad');
  plantTree(15.5, -21, 10.2, 'pine');
  plantTree(-13.5, -26, 8.2, 'broad');
  plantTree(24, -34, 11.0, 'pine');
  plantTree(-21, -41, 9.4, 'broad');
  plantTree(9.0, -48, 7.8, 'broad');
  // Middle and far field, scattered off both verges.
  for (let i = 0; i < 26; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const x = side * (5 + rand() * 55);
    const z = -18 - rand() * 88;
    plantTree(x, z, 6 + rand() * 6, rand() < 0.35 ? 'pine' : 'broad');
  }
  // A tree line along the near shore: the scale cue that makes the lake read big.
  for (let i = 0; i < 30; i++) {
    const x = (rand() - 0.5) * 300;
    if (Math.abs(x) < 9) continue;   // keep the lane's vanishing point open
    plantTree(x, SHORE_Z + 6 - rand() * 6, 7 + rand() * 6, 'pine');
  }

  // --- hedge and fence -----------------------------------------------------
  // Post-and-rail on the right verge: the receding rhythm is a depth cue and the
  // near posts double as foreground bokeh at f/1.8.
  const POSTS = 13;
  for (let i = 0; i < POSTS; i++) {
    const post = mesh(unitBox, wood, [PATH_HALF + 0.65, 0.55, -6 - i * 2.9]);
    post.scale.set(0.11, 1.10, 0.11);
    post.rotation.y = (rand() - 0.5) * 0.10;
    scene.add(post);
  }
  for (const height of [0.88, 0.52]) {
    const rail = mesh(unitBox, wood, [PATH_HALF + 0.65, height, -6 - (POSTS - 1) * 1.45]);
    rail.scale.set(0.07, 0.10, (POSTS - 1) * 2.9);
    rail.castShadow = true;
    scene.add(rail);
  }

  // --- boulders and flowers ------------------------------------------------
  const boulders = [
    [3.1, -5.4, 0.9], [-2.9, -8.2, 0.7], [5.4, -13.5, 1.4],
    [-7.2, -20, 1.7], [2.6, -27, 0.8], [-3.4, -35, 1.1]
  ];
  for (const [x, z, size] of boulders) {
    const stone = mesh(unitBoulder, rock, [x, size * 0.36, z]);
    stone.scale.set(size, size * 0.62, size * 0.85);
    stone.rotation.set(rand() * 0.4, rand() * Math.PI, rand() * 0.3);
    scene.add(stone);
  }

  // Wild flowers beside the lane, sized so an f/1.8 frame turns them into bright
  // specular dots rather than into clutter.
  const patches = [
    { x: 1.85, z: -3.6, w: 0.9, d: 2.6 }, { x: -1.95, z: -4.6, w: 0.9, d: 2.4 },
    { x: 2.30, z: -7.4, w: 1.1, d: 2.2 }, { x: -2.35, z: -8.6, w: 1.0, d: 2.0 },
    { x: 1.75, z: -11, w: 0.8, d: 2.4 }
  ];
  const bloom = new THREE.SphereGeometry(0.034, 6, 5);
  const stem = new THREE.CylinderGeometry(0.008, 0.012, 1, 4);
  const flowers = [];
  for (let i = 0; i < 90; i++) {
    const patch = patches[Math.floor(rand() * patches.length)];
    const height = 0.18 + rand() * 0.22;
    flowers.push({
      position: new THREE.Vector3(patch.x + (rand() - 0.5) * patch.w, height, patch.z + (rand() - 0.5) * patch.d),
      scale: new THREE.Vector3(0.7 + rand() * 0.8, 0.7 + rand() * 0.8, 0.7 + rand() * 0.8)
    });
  }
  const blooms = mesh(scatterGeometry(bloom, flowers), petalTone, [0, 0, 0]);
  blooms.castShadow = false;
  const stems = mesh(scatterGeometry(stem, flowers.map(({ position }) => ({
    position: new THREE.Vector3(position.x, position.y / 2, position.z),
    scale: new THREE.Vector3(1, position.y, 1)
  }))), stemTone, [0, 0, 0]);
  stems.castShadow = false;
  scene.add(blooms, stems);

  // --- clouds --------------------------------------------------------------
  // Flattened ellipsoids well above the ridge line. They drift, they are not
  // fogged (haze sits below them), and the pick ray ignores them so a tap on
  // the sky cannot rack the lens to half a kilometre.
  const cloudTone = new THREE.MeshStandardNodeMaterial({ color: 0xf4f8ff, roughness: 1.0, metalness: 0.0, emissive: 0xdfe9f5, emissiveIntensity: 0.3, fog: false });
  const clouds = [];
  for (let i = 0; i < 6; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(rand() * 3);
    for (let puff = 0; puff < puffs; puff++) {
      const radius = 16 + rand() * 18;
      const node = mesh(unitSphere, cloudTone, [(rand() - 0.5) * 44, (rand() - 0.5) * 8, (rand() - 0.5) * 26]);
      node.scale.set(radius, radius * 0.38, radius * 0.7);
      node.castShadow = false; node.receiveShadow = false;
      node.userData.ignorePick = true;
      cloud.add(node);
    }
    cloud.position.set((rand() - 0.5) * 900, 230 + rand() * 90, -520 - rand() * 240);
    cloud.userData.drift = 1.4 + rand() * 1.8;
    scene.add(cloud);
    clouds.push(cloud);
  }

  // --- people --------------------------------------------------------------
  // The same rig (and the same fallbacks) as the street, so the autofocus box
  // still finds a face to snap onto in this world.
  const surface = (color, roughness, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
  const skinTones = [0xd7ad87, 0xc1956a, 0xa47a50, 0x855d40].map((c) => surface(c, 0.6));
  const hairTones = [0x181310, 0x2c1e14, 0x4c3a27, 0x0f0e0d].map((c) => surface(c, 0.62));
  const coatTones = [0x33404f, 0x5a4232, 0x3f5140, 0x6c5c48, 0x2f3a44, 0x7a4a3a].map((c) => surface(c, 0.78));
  const trouserTones = [0x2c3038, 0x22262c, 0x3a3630].map((c) => surface(c, 0.9));
  const shoeTone = surface(0x1a1a1c, 0.45, 0.15);
  const eyeTone = surface(0x241f1c, 0.14, 0.0);

  const WALK_REFERENCE = 1.25;
  const mixers = [];
  const spawn = (role, { build = 1, speed = 1, style = 'short' }) => {
    if (personAsset) {
      const instance = createPersonInstance(personAsset, { clip: role, build, speed, phase: rand() });
      shareAssetBuffers(instance.group);
      if (instance.mixer) mixers.push(instance.mixer);
      return instance.group;
    }
    const person = buildPerson({
      skin: pick(skinTones), hair: pick(hairTones), eye: eyeTone,
      coat: pick(coatTones), trousers: pick(trouserTones), shoes: shoeTone
    }, style);
    person.scale.setScalar(build);
    return person;
  };

  // Two standing subjects on the lane: a full body at 50 mm and head and
  // shoulders at 85 mm, so the portrait workflow works without moving the rig.
  const sitters = [
    { x: 0.56, z: -3.9, turn: 0.22, build: 1.0, style: 'long' },
    { x: -0.72, z: -8.6, turn: -0.16, build: 1.03, style: 'short' }
  ];
  for (const sitter of sitters) {
    const person = spawn('idle', { build: sitter.build, style: sitter.style });
    person.position.set(sitter.x, 0, sitter.z);
    person.rotation.y = sitter.turn;
    scene.add(person);
  }

  const walkers = [];
  for (let i = 0; i < 2; i++) {
    const speed = 0.6 + rand() * 0.4;
    const away = i === 0;
    const person = spawn('walk', { build: 0.96 + rand() * 0.1, speed: speed / WALK_REFERENCE, style: i ? 'medium' : 'short' });
    person.position.set(away ? 1.0 : -1.05, 0, away ? -14 : -34);
    person.rotation.y = away ? Math.PI : 0;
    scene.add(person);
    walkers.push({ group: person, speed, min: SHORE_Z + 4, max: -2, dir: away ? -1 : 1 });
  }

  // --- sky dome ------------------------------------------------------------
  const domeMaterial = new MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
  domeMaterial.colorNode = Fn(() => {
    const direction = normalize(positionLocal);
    // The gradient is steep on purpose: a normal lens only sees the first dozen
    // degrees above the ridge line, so that thin band has to carry the blue.
    const height = smoothstep(float(-0.03), float(0.20), direction.y);
    const sky = mix(
      vec3(DAY_HORIZON[0], DAY_HORIZON[1], DAY_HORIZON[2]),
      vec3(DAY_ZENITH[0], DAY_ZENITH[1], DAY_ZENITH[2]),
      height
    );
    // The sun itself plus the forward scatter around it. Two lobes: a tight disc
    // and a broad haze, which is what keeps the sky from ending at a hard edge.
    const facing = max(dot(direction, vec3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z)), float(0));
    const disc = smoothstep(float(0.99955), float(0.99985), facing);
    const glow = pow(facing, float(26)).mul(0.34).add(pow(facing, float(5)).mul(0.10));
    const sun = vec3(1.0, 0.94, 0.82).mul(glow).add(vec3(1.0, 0.97, 0.90).mul(disc.mul(3.4)));
    return sky.add(sun);
  })();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 28), domeMaterial);
  dome.userData.ignorePick = true;
  scene.add(dome);

  // --- lighting ------------------------------------------------------------
  // A hard sun with a warm cast, plus a strong hemisphere fill: outdoors the sky
  // is an enormous softbox, and without it every shadow would read as night.
  const sun = new THREE.DirectionalLight(0xfff3de, 2.8);
  sun.position.copy(SUN_DIR).multiplyScalar(280);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 620;
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  const sky = new THREE.HemisphereLight(0x9dc4ee, 0x4b6136, 1.0);
  scene.add(sky);

  let previous = 0;
  const update = (elapsed) => {
    const delta = previous === 0 ? 0 : Math.min(0.1, Math.max(0, elapsed - previous));
    previous = elapsed;

    for (const mixer of mixers) mixer.update(delta);

    // A slow sparkle on the water: one emissive value, animated, is enough to
    // read as a sunlit lake when the whole surface is a couple of hundred
    // metres away.
    water.emissiveIntensity = 1.15 + Math.sin(elapsed * 0.55) * 0.12;

    for (const cloud of clouds) {
      cloud.position.x += cloud.userData.drift * delta;
      if (cloud.position.x > 480) cloud.position.x = -480;
    }

    for (const walker of walkers) {
      walker.group.position.z += walker.dir * walker.speed * delta;
      if (walker.dir < 0 && walker.group.position.z < walker.min) walker.group.position.z = walker.max;
      if (walker.dir > 0 && walker.group.position.z > walker.max) walker.group.position.z = walker.min;
    }
  };

  const dispose = () => {
    scene.traverse((node) => {
      if (node.userData.sharedAsset) return;
      if (node.geometry) node.geometry.dispose();
      const material = node.material;
      if (Array.isArray(material)) material.forEach(disposeMaterial);
      else if (material) disposeMaterial(material);
    });
    // Shared template buffers are rebuilt lazily if another world needs them.
    disposePeople();
  };

  return {
    id: 'landscape',
    ev: DAY_EV,
    scene, fog, sun, sky, update, dispose,
    personSource: personAsset ? personAsset.source : null,
    vehicleSource: null
  };
}

function disposeMaterial(material) {
  for (const key of ['map', 'emissiveMap', 'roughnessMap', 'normalMap']) {
    if (material[key]) material[key].dispose();
  }
  material.dispose();
}
