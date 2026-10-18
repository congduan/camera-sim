import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, float, mix, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { buildPerson, disposePeople } from './people';
import { createPersonInstance } from './personAsset';
import { PAINT_COLOURS, createVehicleInstance } from './vehicleAsset';
import { SCENE_EV } from './constants';
import { buildLandscapeWorld } from './landscape';

// ---------------------------------------------------------------------------
// The world the lens looks at. Everything is real geometry with PBR materials,
// lit by a moon-style key light plus the street lamps, so the depth of field
// solves on genuine per-pixel depth instead of a procedural backdrop.
// ---------------------------------------------------------------------------

// Linear-light colours so the fog and the sky dome meet seamlessly. The dome
// material writes raw linear values, while `scene.fog` tints its own colour to
// the linear working space, so both must be authored linear.
export const HORIZON = [0.05, 0.07, 0.13];
export const SKY_TOP = [0.012, 0.021, 0.05];
const ROAD_HALF = 7;
const SIDEWALK_OUTER = 11.2;
const CURB_HEIGHT = 0.18;
const DOME_RADIUS = 600;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// A facade is baked per building so the lit windows follow that building's own
// proportions instead of being stretched by a shared tiling texture.
function facadeTexture(rand, cols, rows) {
  const cell = 8;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell; canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0c0f14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const roll = rand();
      if (roll < 0.62) continue;                  // dark apartment
      const warmth = 0.55 + rand() * 0.45;
      const alpha = roll > 0.9 ? 1 : 0.35 + rand() * 0.4;
      ctx.fillStyle = `rgba(${Math.round(255 * warmth)},${Math.round(196 * warmth)},${Math.round(118 * warmth)},${alpha})`;
      ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

function roadTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101319';
  ctx.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 900; i++) {
    const shade = 12 + Math.random() * 16;
    ctx.fillStyle = `rgba(${shade},${shade + 2},${shade + 6},0.5)`;
    ctx.fillRect(Math.random() * 128, Math.random() * 256, 2, 2);
  }
  ctx.fillStyle = 'rgba(214,208,186,0.62)';       // edge lines
  ctx.fillRect(8, 0, 3, 256);
  ctx.fillRect(117, 0, 3, 256);
  ctx.fillStyle = 'rgba(226,220,196,0.78)';       // dashed centre line
  ctx.fillRect(62, 24, 4, 61);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 32);
  texture.anisotropy = 8;
  return texture;
}

function mesh(geometry, material, position, rotation) {
  const node = new THREE.Mesh(geometry, material);
  node.position.set(position[0], position[1], position[2]);
  if (rotation) node.rotation.set(rotation[0], rotation[1], rotation[2]);
  node.castShadow = true; node.receiveShadow = true;
  return node;
}

/**
 * Builds the street.
 *
 * @param {object} [options]
 * @param {?object} [options.personAsset] - Rigged model from `personAsset.js`.
 *   When omitted, or null, procedural figures are used instead.
 * @param {?object} [options.vehicleAsset] - Model from `vehicleAsset.js`. When
 *   omitted, or null, box cars are used instead.
 * @return {object} The world handle, including `personSource` and
 *   `vehicleSource` so the caller can report what actually ended up in the scene.
 */
export function buildStreetWorld({ personAsset = null, vehicleAsset = null } = {}) {
  const rand = mulberry32(20261015);
  const scene = new THREE.Scene();
  const fog = new THREE.Fog(new THREE.Color().setRGB(HORIZON[0], HORIZON[1], HORIZON[2]), 10, 250);
  scene.fog = fog;
  scene.background = new THREE.Color().setRGB(SKY_TOP[0], SKY_TOP[1], SKY_TOP[2]);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const asphalt = new THREE.MeshStandardNodeMaterial({ color: 0x14171d, roughness: 0.86, metalness: 0.05 });
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0x2b2f36, roughness: 0.95, metalness: 0.0 });
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x232830, roughness: 0.42, metalness: 0.9 });
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x0b1016, roughness: 0.15, metalness: 0.55 });

  // --- ground, road, sidewalks -------------------------------------------
  const ground = mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardNodeMaterial({ color: 0x0b0e12, roughness: 1.0, metalness: 0.0 }), [0, -0.02, -200], [-Math.PI / 2, 0, 0]);
  ground.castShadow = false;
  scene.add(ground);

  const road = mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 420), new THREE.MeshStandardNodeMaterial({ map: roadTexture(), roughness: 0.62, metalness: 0.16 }), [0, 0.012, -190], [-Math.PI / 2, 0, 0]);
  road.castShadow = false;
  scene.add(road);

  const walkWidth = SIDEWALK_OUTER - ROAD_HALF;
  for (const side of [-1, 1]) {
    const walk = mesh(unitBox, concrete, [side * (ROAD_HALF + walkWidth / 2), CURB_HEIGHT / 2, -190]);
    walk.scale.set(walkWidth, CURB_HEIGHT, 420);
    walk.castShadow = false;
    scene.add(walk);
  }

  // --- buildings -----------------------------------------------------------
  const buildings = [];
  for (let i = 0; i < 30; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const z = -8 - Math.floor(i / 2) * 13 - rand() * 4;
    const width = 8 + rand() * 10;
    const depth = 9 + rand() * 12;
    const height = 10 + rand() * 34;
    const facade = facadeTexture(rand, Math.max(3, Math.round(width / 1.5)), Math.max(4, Math.round(height / 1.5)));
    const material = new THREE.MeshStandardNodeMaterial({
      map: facade, emissiveMap: facade, emissive: 0xffb168, emissiveIntensity: 1.15,
      color: 0xffffff, roughness: 0.93, metalness: 0.0
    });
    const building = mesh(unitBox, material, [side * (SIDEWALK_OUTER + width / 2 + 3 + rand() * 4), height / 2, z]);
    building.scale.set(width, height, depth);
    scene.add(building);
    buildings.push(building);
  }

  // --- distant skyline -----------------------------------------------------
  const skylineFacade = facadeTexture(rand, 10, 30);
  const skylineMat = new THREE.MeshStandardNodeMaterial({
    map: skylineFacade, emissiveMap: skylineFacade, emissive: 0x86a6ff,
    emissiveIntensity: 0.6, color: 0xffffff, roughness: 1.0, metalness: 0.0
  });
  for (let i = 0; i < 26; i++) {
    const width = 9 + rand() * 16;
    const height = 14 + rand() * 46;
    const tower = mesh(unitBox, skylineMat, [(rand() - 0.5) * 190, height / 2, -150 - rand() * 70]);
    tower.scale.set(width, height, width * 0.8);
    tower.castShadow = false;
    scene.add(tower);
  }

  // --- street lamps --------------------------------------------------------
  const lampGlow = new THREE.MeshStandardNodeMaterial({ color: 0x1a1409, emissive: 0xffb264, emissiveIntensity: 2.6, roughness: 0.35, metalness: 0.2 });
  const lamps = [];
  for (let i = 0; i < 9; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const z = -6 - i * 16;
    const x = side * (ROAD_HALF + 1.35);
    const group = new THREE.Group();
    group.position.set(x, CURB_HEIGHT, z);
    const pole = mesh(new THREE.CylinderGeometry(0.085, 0.13, 8.2, 10), metal, [0, 4.1, 0]);
    const arm = mesh(unitBox, metal, [-side * 0.95, 8.05, 0]);
    arm.scale.set(1.9, 0.11, 0.11);
    const head = mesh(unitBox, lampGlow.clone(), [-side * 1.85, 7.94, 0]);   // per lamp so it can flicker alone
    head.scale.set(0.78, 0.16, 0.34);
    const light = new THREE.PointLight(0xffb266, 130, 46, 2);
    light.position.set(-side * 1.85, 7.7, 0);
    group.add(pole, arm, head, light);
    scene.add(group);
    lamps.push({ light, head, base: 130 });
  }

  // --- parked cars ---------------------------------------------------------
  // Real car geometry when a model is present, otherwise a box car of the same
  // footprint. Cars park on the right of their direction of travel, so the two
  // sides of the street face opposite ways. The model is heavy — a quarter of a
  // million triangles each, of which only the ones inside the view and the
  // shadow frustum are drawn — so the count is deliberately small.
  const CAR_COUNT = 4;
  const spawnCar = (side, z, paint) => {
    const x = side * (ROAD_HALF - 1.45);
    if (vehicleAsset) {
      const car = createVehicleInstance(vehicleAsset, { paint });
      // Clones share the asset's buffers, so disposing this world must leave
      // them alone: the same model is used again if the world is rebuilt.
      car.traverse((node) => { if (node.isMesh) node.userData.sharedAsset = true; });
      car.position.set(x, 0.012, z);
      car.rotation.y = side < 0 ? Math.PI : 0;   // side < 0 travels away from us
      scene.add(car);
      return;
    }
    const body = mesh(unitBox, new THREE.MeshStandardNodeMaterial({ color: paint, roughness: 0.32, metalness: 0.8 }), [x, 0.62, z]);
    body.scale.set(1.9, 0.62, 4.4);
    const cabin = mesh(unitBox, glass, [x, 1.16, z - 0.2]);
    cabin.scale.set(1.7, 0.5, 2.2);
    scene.add(body, cabin);
  };
  for (let i = 0; i < CAR_COUNT; i++) {
    spawnCar(i % 2 === 0 ? -1 : 1, -14 - i * 23, PAINT_COLOURS[i % PAINT_COLOURS.length]);
  }

  // --- people --------------------------------------------------------------
  // A ready-made rigged model is used whenever one is present. Otherwise figures
  // are built by `people.js` at 1.72 m proportions and merged per material, so
  // even the fallback costs six draw calls per person. Skin there is deliberately
  // light: at night the lamps are the only key light, and a dark albedo would
  // leave faces unreadable.
  const surface = (color, roughness, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  const pick = list => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
  const skinTones = [0xd0a884, 0xb98a63, 0x9a7050, 0x7d5943].map(c => surface(c, 0.58));
  const hairTones = [0x14110f, 0x2a1c12, 0x4a3826, 0x0d0c0c].map(c => surface(c, 0.62));
  const coatTones = [0x2a2f3a, 0x3a2a2a, 0x24302b, 0x33323c, 0x1f242c, 0x4a3d2e, 0x5a2b2b, 0x2c3a4a].map(c => surface(c, 0.78));
  const trouserTones = [0x22252c, 0x1b1e24, 0x2d2a26].map(c => surface(c, 0.9));
  const shoeTone = surface(0x141416, 0.45, 0.18);
  // Dark and glossy, so the eyes pick up a specular glint from the street lamps
  // instead of reading as two holes.
  const eyeTone = surface(0x241f1c, 0.14, 0.0);

  // Reference ground speed the walk clip was authored at. Stride length is baked
  // into the animation, so the playback rate is scaled by the walking speed to
  // keep the feet from sliding.
  const WALK_REFERENCE = 1.25;
  const mixers = [];

  const spawn = (role, { build = 1, speed = 1, style = 'short' }) => {
    if (personAsset) {
      const instance = createPersonInstance(personAsset, { clip: role, build, speed, phase: rand() });
      instance.group.traverse((node) => { if (node.isMesh) node.userData.sharedAsset = true; });
      if (instance.mixer) mixers.push(instance.mixer);
      return instance.group;
    }
    const person = buildPerson({
      skin: pick(skinTones), hair: pick(hairTones), eye: eyeTone,
      coat: pick(coatTones), trousers: pick(trouserTones), shoes: shoeTone
    }, style);
    person.scale.setScalar(build);   // uniform, so the anatomy stays correct
    return person;
  };

  // Standing subjects for portraiture. The distances are chosen so that every
  // focal length has a subject framed usefully without panning: three metres is
  // a full body at 50mm and head and shoulders at 85mm, six metres carries 135mm
  // and nine metres carries 200mm. Offsets stay small enough to remain inside the
  // horizontal field of view of the lens each one is meant for. They turn a few
  // degrees so the street lamp acts as a key light across the face.
  const sitters = [
    { x: -0.42, z: -3.4, turn: -0.30, build: 1.00, style: 'long' },
    { x: 0.52, z: -6.2, turn: 0.26, build: 1.04, style: 'short' },
    { x: -0.58, z: -9.2, turn: -0.12, build: 0.97, style: 'medium' }
  ];
  for (const sitter of sitters) {
    const person = spawn('idle', { build: sitter.build, style: sitter.style });
    person.position.set(sitter.x, 0.012, sitter.z);
    person.rotation.y = sitter.turn;
    scene.add(person);
  }

  // Background pedestrians, so a shallow depth of field has something to melt.
  const styles = ['short', 'medium', 'long', 'short', 'medium'];
  const walkers = [];
  for (let i = 0; i < 5; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const speed = 0.55 + rand() * 0.5;
    const person = spawn('walk', { build: 0.95 + rand() * 0.1, speed: speed / WALK_REFERENCE, style: styles[i] });
    person.position.set(side * (ROAD_HALF + 1.6 + rand() * 1.6), CURB_HEIGHT, -9 - i * 11 - rand() * 5);
    person.rotation.y = side > 0 ? Math.PI : 0;
    scene.add(person);
    walkers.push({ group: person, speed, min: -110, max: -1.5, dir: side > 0 ? -1 : 1 });
  }

  // --- sky dome ------------------------------------------------------------
  const domeMaterial = new MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
  domeMaterial.colorNode = Fn(() => {
    const t = smoothstep(float(-0.08), float(0.7), positionLocal.y.div(DOME_RADIUS));
    return mix(vec3(HORIZON[0], HORIZON[1], HORIZON[2]), vec3(SKY_TOP[0], SKY_TOP[1], SKY_TOP[2]), t);
  })();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 20), domeMaterial);
  dome.userData.ignorePick = true;
  scene.add(dome);

  // --- lighting ------------------------------------------------------------
  const moon = new THREE.DirectionalLight(0x9dc0ff, 0.5);
  moon.position.set(38, 46, -18);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.near = 1;
  moon.shadow.camera.far = 260;
  moon.shadow.camera.left = -70; moon.shadow.camera.right = 70;
  moon.shadow.camera.top = 70; moon.shadow.camera.bottom = -70;
  moon.shadow.bias = -0.0009;
  moon.shadow.normalBias = 0.04;
  scene.add(moon);
  const sky = new THREE.HemisphereLight(0x2b3a5c, 0x080a0e, 0.75);
  scene.add(sky);

  let previous = 0;
  const update = (elapsed) => {
    // A real delta, so animation and the walk cycle run at the same rate on any
    // refresh rate. The first call has no previous time to subtract, and a tab
    // that was backgrounded can hand over an enormous gap.
    const delta = previous === 0 ? 0 : Math.min(0.1, Math.max(0, elapsed - previous));
    previous = elapsed;

    for (const mixer of mixers) mixer.update(delta);
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i];
      const flicker = 1 + Math.sin(elapsed * (11 + i) + i * 2.1) * 0.012 + Math.sin(elapsed * 2.3 + i) * 0.02;
      lamp.light.intensity = lamp.base * flicker;
      lamp.head.material.emissiveIntensity = 2.6 * flicker;
    }
    for (const walker of walkers) {
      walker.group.position.z += walker.dir * walker.speed * delta;
      if (walker.group.position.z < walker.min) { walker.group.position.z = walker.max; }
    }
  };

  const dispose = () => {
    scene.traverse((node) => {
      if (node.userData.sharedAsset) return;   // cloned from a loaded asset
      if (node.geometry) node.geometry.dispose();
      const material = node.material;
      if (Array.isArray(material)) material.forEach(disposeMaterial);
      else if (material) disposeMaterial(material);
    });
    disposePeople();   // the shared source geometries are not part of the scene
  };

  return {
    id: 'street',
    ev: SCENE_EV,
    scene, fog, moon, sky, update, dispose,
    personSource: personAsset ? personAsset.source : null,
    vehicleSource: vehicleAsset ? vehicleAsset.source : null
  };
}

/**
 * Builds whichever world the viewfinder is pointed at.
 *
 * @param {object} [options]
 * @param {'street'|'landscape'} [options.world] - Which scene to build.
 * @param {?object} [options.personAsset] - Rigged character model, if loaded.
 * @param {?object} [options.vehicleAsset] - Vehicle model, if loaded.
 * @return {object} The world handle: `id`, `ev`, `scene`, `fog`, the animation
 *   `update`, `dispose`, and the asset sources actually used.
 */
export function buildWorld({ world = 'street', ...assets } = {}) {
  return world === 'landscape' ? buildLandscapeWorld(assets) : buildStreetWorld(assets);
}

function disposeMaterial(material) {
  for (const key of ['map', 'emissiveMap', 'roughnessMap', 'normalMap']) {
    if (material[key]) material[key].dispose();
  }
  material.dispose();
}
