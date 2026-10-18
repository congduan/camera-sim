import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, If, abs, clamp, cos, float, floor, fract, length, max, min, mix, positionView, pow, screenUV, sin, smoothstep, sqrt, step, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { APERTURES } from './constants';
import { gainStops, lightStops, whiteBalanceGain } from './exposure';
import { METERING } from './metering';
import { buildWorld } from './scene3d';
import { loadPersonAsset } from './personAsset';
import { loadVehicleAsset } from './vehicleAsset';

// Three.js WebGPURenderer selects WebGPU when available and falls back to WebGL2.
// The shader is expressed in TSL so the same material can be translated to WGSL
// or GLSL by the renderer backend.
//
// Every frame runs three passes:
//   1. a linear view-distance prepass (scene.overrideMaterial) into a half float
//      target, which is what the depth of field solves against;
//   2. the real 3D world through a perspective camera whose FOV is derived from
//      the focal length and the sensor size;
//   3. a full screen develop pass that turns the distance buffer into a physical
//      circle of confusion, gathers a real bokeh, then runs the CMOS photon
//      transfer chain (shot + read noise, full well, ADC, Bayer CFA).
//
// The optics enter this pass the way a real lens would leave them: the bokeh is
// gathered through the aperture polygon the diaphragm actually has (round wide
// open, faceted once stopped down), the off-axis cones are trimmed by the
// measured transmission of the rims, and the frame is shaded by the illumination
// curve the light path solved rather than by a fixed falloff.
const SAMPLES = 18;
const GOLDEN_ANGLE = 2.399963229728653;
const METER_SIZE = 64;   // luminance map the metering pass is reduced to

export async function createRenderer(canvas, { world: startWorld = 'street' } = {}) {
  // Both downloads start before the renderer does anything else. They used to be
  // sequential and to wait for the GPU handshake first, which put 3.7 MB of glTF
  // behind the device initialisation and the character behind the car.
  const downloads = Promise.allSettled([
    loadPersonAsset({ timeout: 15000 }),
    loadVehicleAsset({ timeout: 15000 })
  ]);

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, outputBufferType: THREE.HalfFloatType });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the develop pass encodes sRGB itself
  await renderer.init();
  const isWebGPU = !!renderer.backend?.isWebGPUBackend;

  // The world is built before the models arrive. Waiting for the files used to
  // hold the first frame hostage, so the procedural figures and box cars stand in
  // for the first second and the scene is rebuilt in place once they land. The
  // timeout is generous because a late arrival is now useful rather than a black
  // frame.
  let personAsset = null;
  let vehicleAsset = null;
  let ready = false;     // set once the passes exist, so late assets can be swapped in
  let disposed = false;
  let world = buildWorld({ world: startWorld, personAsset, vehicleAsset });
  const assetsReady = downloads.then(([person, vehicle]) => {
    personAsset = person.status === 'fulfilled' ? person.value : null;
    vehicleAsset = vehicle.status === 'fulfilled' ? vehicle.value : null;
    logAssets(personAsset, vehicleAsset);
    if (!ready || disposed) return false;   // picked up by the next world build
    rebuildWorld();
    return true;
  }).catch((err) => {
    console.warn('[lens-sim] models unavailable, keeping the procedural stand-ins', err);
    return false;
  });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.3, 1000);
  camera.position.set(0, 1.62, 0);

  const drawSize = new THREE.Vector2();
  const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const width = Math.max(1, Math.floor(bufferSize.x)); const height = Math.max(1, Math.floor(bufferSize.y));
  const sceneTarget = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
  const depthTarget = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
  const colorMap = sceneTarget.texture;
  const depthMap = depthTarget.texture;

  // Pass 1 material: metres in front of the camera, nothing else.
  const depthMaterial = new MeshBasicNodeMaterial();
  depthMaterial.colorNode = vec3(positionView.z.mul(-1));
  depthMaterial.fog = false;
  depthMaterial.side = THREE.DoubleSide;   // the sky dome is only visible from inside

  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  postScene.add(quad);

  // --- metering pass --------------------------------------------------------
  // The frame is reduced to a 64x64 weighted luminance map which is read back to
  // the CPU a few times a second. It samples the scene target rather than the
  // developed frame, so the reading is independent of the current exposure and
  // the meter cannot chase its own tail. The scene target is addressed with a
  // top-left origin uv, hence the flipped quad uv.
  const meterTarget = new THREE.RenderTarget(METER_SIZE, METER_SIZE, { type: THREE.FloatType, depthBuffer: true, stencilBuffer: false });
  const meterScene = new THREE.Scene();
  const meterCentre = uniform(new THREE.Vector2(0.5, 0.5));
  const meterRadius = uniform(METERING.evaluative.radius);
  const meterFloor = uniform(METERING.evaluative.floor);
  const meterSharpness = uniform(METERING.evaluative.sharpness);
  const meterAspect = uniform(1.5);
  const lumaWeights = uniform(new THREE.Vector3(0.2126, 0.7152, 0.0722));
  const meterMaterial = new MeshBasicNodeMaterial();
  meterMaterial.fog = false;
  meterMaterial.colorNode = Fn(() => {
    const point = vec2(uv().x, float(1).sub(uv().y));
    const luma = texture(colorMap, point).rgb.dot(lumaWeights);
    const offset = point.sub(meterCentre).mul(vec2(meterAspect, 1));
    const falloff = max(float(0), float(1).sub(length(offset).div(meterRadius)));
    const weight = meterFloor.add(float(1).sub(meterFloor).mul(pow(falloff, meterSharpness)));
    return vec4(luma.mul(weight), weight, float(0), float(1));
  })();
  const meterQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), meterMaterial);
  meterScene.add(meterQuad);

  let meterRunning = false;
  const sampleMeter = async (mode, centreX, centreY) => {
    if (meterRunning) return null;
    meterRunning = true;
    try {
      const config = METERING[mode] ?? METERING.evaluative;
      meterCentre.value.set(centreX, centreY);
      meterRadius.value = config.radius;
      meterFloor.value = config.floor;
      meterSharpness.value = config.sharpness;
      meterAspect.value = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      renderer.setRenderTarget(meterTarget);
      renderer.render(meterScene, postCamera);
      renderer.setRenderTarget(null);
      const data = await renderer.readRenderTargetPixelsAsync(meterTarget, 0, 0, METER_SIZE, METER_SIZE);
      // A readback pads every row to a 256 byte boundary, so walk it with an
      // explicit stride rather than assuming the rows are packed.
      const rowStride = Math.ceil(METER_SIZE * 16 / 256) * 256 / 4;
      let weighted = 0; let total = 0;
      for (let y = 0; y < METER_SIZE; y++) {
        for (let x = 0; x < METER_SIZE; x++) {
          const index = y * rowStride + x * 4;
          weighted += data[index];
          total += data[index + 1];
        }
      }
      return total > 0 ? weighted / total : null;
    } catch {
      return null;   // metering is an enhancement; the fixed scene EV still works
    } finally {
      meterRunning = false;
    }
  };

  // --- develop / sensor uniforms -------------------------------------------
  const aspectU = uniform(1);
  const cropOrigin = uniform(new THREE.Vector2(0, 0));     // frame uv of the crop corner
  const cropSize = uniform(new THREE.Vector2(1, 1));       // frame uv size of the crop
  const gridSize = uniform(new THREE.Vector2(6000, 4000)); // photosites across the canvas
  const gridOrigin = uniform(new THREE.Vector2(0, 0));     // photosite at that corner
  const canvasRes = uniform(new THREE.Vector2(900, 600));
  const invFocus = uniform(1 / 3);      // 1 / metres
  const cocCouple = uniform(0.028);     // metres
  const maxCoc = uniform(0.08);
  const distortion = uniform(0); const exposure = uniform(1); const grid = uniform(0);
  const wb = uniform(new THREE.Vector3(1, 1, 1)); const time = uniform(0);
  const photonScale = uniform(36000); const readNoise = uniform(3); const adcMax = uniform(16383);
  // Charge that saturates the ADC at the current ISO. It shrinks as ISO rises,
  // so the same electrons are stretched over the full scale: fewer electrons are
  // collected for an identically bright frame, which is what makes ISO noisier.
  const adcFullScale = uniform(36000);
  const noiseMix = uniform(1); const peepMix = uniform(0); const cfaMix = uniform(0);

  // --- optics, as the light path solved them ---------------------------------
  const frameScale = uniform(24);     // height of the visible frame, mm
  const diagonal = uniform(21.63);    // half diagonal of that same frame, mm
  // Falloff and mechanical transmission are quartic fits in (h / corner)², so
  // each arrives as a vector of four coefficients plus the fifth.
  const illumination = uniform(new THREE.Vector4(1, 0, 0, 0)); const illuminationTail = uniform(0);
  const transmission = uniform(new THREE.Vector4(1, 0, 0, 0)); const transmissionTail = uniform(0);
  const blades = uniform(7); const bladeMix = uniform(0);
  // The Airy disc a stopped-down aperture diffracts an axial beam into, and the
  // lateral colour the glass spreads the image by, both as radii in frame
  // heights - the unit the circle of confusion is already solved in.
  const airy = uniform(0); const chroma = uniform(0);
  // Device pixels the visible frame is tall. Anything the optics blur by less
  // than this is below what the screen can show.
  const framePixels = uniform(900);

  const rand = Fn(([seed]) => fract(sin(seed.mul(12.9898).add(78.233)).mul(43758.5453123)));
  const gaussian = Fn(([seed]) => sqrt(max(rand(seed), float(1e-5)).log().mul(-2)).mul(cos(rand(seed.add(19.19)).mul(6.283185))));

  const sampleDepth = Fn(([coord]) => max(texture(depthMap, coord).x, float(0.05)));
  const cocAt = Fn(([coord]) => cocCouple.mul(abs(invFocus.sub(float(1).div(sampleDepth(coord))))));

  // Quartic in (h / hcorner)², by Horner's rule. Both curves the light path fits
  // are of that form, and both are 1 on the axis.
  const curve = (head, tail, x) => head.x.add(x.mul(head.y.add(x.mul(head.z.add(x.mul(head.w.add(x.mul(tail))))))));
  // Frame-space radius of a render target coordinate, in frame heights, squared
  // and normalised so the corner of the frame lands on 1 - the abscissa the
  // illumination was sampled on. `centred` below is the same quantity at the
  // pixel being developed.
  const fieldSquared = (r) => {
    const h = min(r.mul(frameScale).div(diagonal), float(1));
    return h.mul(h);
  };
  const fieldRadius = (coord) => length(coord.sub(vec2(0.5)).mul(vec2(aspectU, float(1))));
  const illuminationAt = (r) => curve(illumination, illuminationTail, fieldSquared(r));
  const transmissionAt = (r) => curve(transmission, transmissionTail, fieldSquared(r));

  // The point spread function is the exit pupil's geometric cone convolved with
  // the aperture's diffraction disc. Two discs of radius a and b convolve to one
  // of radius sqrt(a² + b²), which is the combination the light path already
  // reports per depth layer, so diffraction enters the frame the same way.
  const psfAt = (coord) => sqrt(cocAt(coord).mul(cocAt(coord)).add(airy.mul(airy)));
  // Lateral colour: the glass images red and blue at a slightly different radial
  // magnification than green, so each channel reads the scene at its own scale
  // about the frame centre. Scaling frame uv is scaling the radius in
  // millimetres, since uv and the sensor are only a common scale apart.
  const redScale = float(1).add(chroma.mul(.5)); const blueScale = float(1).sub(chroma.mul(.5));
  const channelUv = (coord, scale) => {
    const uv = cropOrigin.add(coord.mul(cropSize));
    return vec2(0.5).add(uv.sub(vec2(0.5)).mul(scale)).sub(cropOrigin).div(cropSize);
  };
  // One scene sample, colour-fringed: green rides the ray the geometry solved,
  // red and blue have drifted a little further out and a little further in.
  const sampleScene = (coord) => vec3(
    texture(colorMap, channelUv(coord, redScale)).r,
    texture(colorMap, coord).g,
    texture(colorMap, channelUv(coord, blueScale)).b
  );

  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    // Render targets are addressed with a top-left origin uv. `uv()` of the full
    // screen quad is bottom-left, which would sample the frame upside down, so
    // the develop pass works in screen space throughout.
    const screen = screenUV;
    const cell = floor(screen.mul(gridSize));
    const snapped = cell.add(float(0.5)).div(gridSize);
    // Pixel peeping samples the centre of a photosite so the frame reads as one
    // block per pixel, with constant noise and CFA inside each block.
    const uvView = mix(screen, snapped, peepMix);

    // Frame space plus the lens distortion, then back into render target uv.
    const frame = cropOrigin.add(uvView.mul(cropSize));
    const centred = frame.sub(vec2(0.5)).mul(vec2(aspectU, 1));
    const radius = length(centred);
    const warped = vec2(0.5).add(centred.mul(float(1).add(distortion.mul(radius.mul(radius)))).div(vec2(aspectU, 1)));
    const centre = clamp(warped.sub(cropOrigin).div(cropSize), vec2(0), vec2(1));

    // Depth of field: gather the cone of rays the exit pupil projects onto this
    // pixel, rejecting samples whose own blur disc cannot reach back to us.
    const jitter = rand(cell.dot(vec2(1, 1)).add(gridOrigin.dot(vec2(4096, 1))));
    // The diaphragm's blades bound the exit pupil the moment they travel in
    // from the bore the lens shows wide open, so the sampling patch is not a
    // disc: it is the blade polygon, and `bladeMix` is how far the blades have
    // come in. Scaling the golden angle disc by the polygon radius in each
    // direction maps it onto the polygon, so the samples keep equal area.
    const bladeCount = max(blades, float(3));
    const bladeStep = float(6.283185).div(bladeCount);      // one edge normal apart
    const apothem = cos(bladeStep.mul(.5));                 // cos(π/N), the inscribed radius
    // Off-axis beams lose their rim rays: the same defocus therefore focuses
    // tighter in the corners, by exactly the transmission the trace measured.
    const trim = transmissionAt(radius);
    const centreCoc = min(psfAt(centre), maxCoc).mul(trim);
    // These two have to be shader variables rather than expressions built up in
    // JS, because the gather below sits behind a branch.
    const sum = vec3(0).toVar(); const total = float(0).toVar();
    sum.assign(sampleScene(centre)); total.assign(float(1));
    // A patch narrower than one pixel has nothing to average: every tap lands in
    // the same texel, so the loop is skipped rather than reading one value
    // eighteen times per channel. The test is in device pixels of the frame as
    // it is shown right now, so it can only ever drop blur the screen cannot
    // resolve - peeping magnifies the frame and never takes this branch.
    If(centreCoc.mul(framePixels).greaterThan(1), () => {
      const inverseAspect = float(1).div(aspectU);
      for (let i = 0; i < SAMPLES; i++) {
        // Every operand of a TSL operator must itself be a node: mixing a plain
        // JS number into an infix expression coerces the node to a string and the
        // shader build later fails on getNodeType.
        const angle = jitter.mul(6.283185).add(i * GOLDEN_ANGLE);
        const fold = fract(angle.div(bladeStep).add(float(.5))).sub(float(.5)).mul(bladeStep);
        const boundary = mix(float(1), apothem.div(cos(fold)), bladeMix);
        const reach = float(Math.sqrt((i + 0.5) / SAMPLES));
        const offset = vec2(cos(angle), sin(angle)).mul(reach).mul(boundary).mul(centreCoc).mul(vec2(inverseAspect, float(1)));
        const tap = clamp(centre.add(offset.div(cropSize)), vec2(0), vec2(1));
        const limit = psfAt(tap).mul(transmissionAt(fieldRadius(tap)));
        const weight = clamp(limit.sub(length(offset)).div(max(centreCoc, float(1e-4))), float(0), float(1));
        sum.assign(sum.add(sampleScene(tap).mul(weight)));
        total.assign(total.add(weight));
      }
    });

    // The frame is shaded by the illumination curve the trace solved - the cos⁴
    // law of the chief ray times the vignetting each rim removes - which at the
    // corner of a fast wide-angle is far from any single fixed falloff.
    let color = sum.div(total).mul(illuminationAt(radius)).mul(exposure).mul(wb);
    const gridLine = smoothstep(.96, .995, max(fract(warped.x.mul(8)), fract(warped.y.mul(8))));
    color = mix(color, vec3(1, .72, .2), gridLine.mul(grid).mul(.55));

    // --- CMOS photon transfer ---
    // A screen pixel integrates the photosites it covers, so noise averages down
    // as the square root of that count, exactly like on sensor binning.
    const binned = max(gridSize.x.div(canvasRes.x).mul(gridSize.y.div(canvasRes.y)), float(1));
    const electrons = color.mul(photonScale).mul(binned);
    const seed = cell.add(gridOrigin).dot(vec2(15731.743, 789221.271)).add(time.mul(91.7));
    const shot = sqrt(max(electrons, float(.25))).mul(gaussian(seed)).mul(noiseMix);
    const read = readNoise.mul(sqrt(binned)).mul(gaussian(seed.add(53.1))).mul(noiseMix);
    const mean = clamp(electrons.add(shot).add(read).div(binned).div(adcFullScale), float(0), float(1));
    const quantised = floor(mean.mul(adcMax).add(float(.5))).div(adcMax);

    const absolute = cell.add(gridOrigin);
    const oddX = step(float(.25), fract(absolute.x.mul(.5)));
    const oddY = step(float(.25), fract(absolute.y.mul(.5)));
    const mosaic = vec3(
      float(1).sub(oddX).mul(float(1).sub(oddY)),
      oddX.mul(float(1).sub(oddY)).add(float(1).sub(oddX).mul(oddY)),
      oddX.mul(oddY)
    );
    return pow(max(mix(quantised, quantised.mul(mosaic), cfaMix), vec3(0)), vec3(.4545));
  })();
  quad.material = material;

  // --- picking: focus on real geometry --------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pickables = [];
  // The pick list is derived from whatever scene is mounted, so it is rebuilt
  // whenever the world is swapped rather than captured once at start-up.
  const refreshPickables = () => {
    pickables.length = 0;
    world.scene.traverse((node) => { if (node.isMesh && !node.userData.ignorePick) pickables.push(node); });
  };
  refreshPickables();
  const hitPoint = new THREE.Vector3();
  const faceWorld = new THREE.Vector3();
  const faceNdc = new THREE.Vector3();

  // Returns null when the ray leaves the world, otherwise the axial distance to
  // what it hit plus, when that hit belongs to a person, where the face projects
  // on screen. The viewfinder snaps its autofocus box onto that point and focuses
  // on the face rather than on whatever body part was under the cursor.
  const pick = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    if (!hits.length) return null;
    hitPoint.copy(hits[0].point).applyMatrix4(camera.matrixWorldInverse);
    const distance = Math.max(0.1, -hitPoint.z);   // distance along the optical axis
    let person = hits[0].object;
    while (person && person.userData.isPerson !== true) person = person.parent;
    if (!person) return { distance, snap: null };
    // The figure is merged per material, so there is no separate head mesh to
    // read a position from; the face point travels with the person instead.
    person.updateWorldMatrix(true, false);
    faceWorld.copy(person.userData.facePoint);
    person.localToWorld(faceWorld);
    faceNdc.copy(faceWorld).project(camera);
    hitPoint.copy(faceWorld).applyMatrix4(camera.matrixWorldInverse);
    return {
      distance,
      snap: {
        x: (faceNdc.x + 1) / 2,
        y: (1 - faceNdc.y) / 2,
        distance: Math.max(0.1, -hitPoint.z)
      }
    };
  };

  let animationFrame;
  let captureRequest = null;
  const startTime = performance.now();

  // A drawing buffer is only readable in the same task that produced it, so a
  // capture is queued here and the pixels are pulled at the end of the next
  // develop pass rather than from the click handler.
  const capture = (type = 'image/jpeg', quality = 0.95) => new Promise((resolve) => {
    captureRequest = { type, quality, resolve };
  });

  const resize = () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.floor(size.x)); const h = Math.max(1, Math.floor(size.y));
    sceneTarget.setSize(w, h); depthTarget.setSize(w, h);
  };

  const render = (state, lens, body, focalLength, lightPath, sensor) => {
    const width = Math.max(1, canvas.clientWidth); const height = Math.max(1, canvas.clientHeight);
    const aspect = width / height;
    // The visible frame keeps the sensor width, so a canvas that is not 3:2
    // crops the frame vertically instead of stretching the optics.
    const frameHeight = body.width / aspect;

    camera.aspect = aspect;
    camera.fov = 2 * Math.atan(frameHeight / (2 * focalLength)) * 180 / Math.PI;
    // Both axes read as "grab the world and drag it": dragging down tilts the
    // view up and dragging right pans the view left. A positive rotation.x looks
    // up and a positive rotation.y looks left, which is why yaw is negated and
    // pitch is not.
    camera.rotation.set(state.pitch, -state.yaw, 0);
    camera.updateProjectionMatrix();

    const photositesX = body.pixels[0];
    const photositesY = Math.round(photositesX / aspect);
    let spanX = photositesX; let spanY = photositesY;
    let originX = 0; let originYTop = 0;
    if (state.peep) {
      spanX = state.peepSpan; spanY = spanX / aspect;
      originX = THREE.MathUtils.clamp(state.peepX - spanX / 2, 0, Math.max(0, photositesX - spanX));
      const centreY = THREE.MathUtils.clamp(state.peepY, 0, body.pixels[1]) * (photositesY / body.pixels[1]);
      const originYBottom = THREE.MathUtils.clamp(centreY - spanY / 2, 0, Math.max(0, photositesY - spanY));
      // setViewOffset counts rows from the top, and so does the render target uv
      // the develop pass samples with.
      originYTop = photositesY - (originYBottom + spanY);
      camera.setViewOffset(photositesX, photositesY, originX, originYTop, spanX, spanY);
    } else {
      camera.clearViewOffset();
    }

    const gains = whiteBalanceGain(state.whiteBalance);
    // The old single exposure multiplier is split in two: the light that reaches
    // the sensor, and the gain ISO applies afterwards. Their product is the same
    // as before, so brightness is unchanged, but the photon count now follows the
    // exposure rather than ISO - which is what makes a high ISO setting noisy.
    exposure.value = Math.pow(2, lightStops(state)) * 0.85;
    wb.value.set(gains[0], gains[1], gains[2]);
    distortion.value = lens.distortion;
    grid.value = state.grid ? 1 : 0;
    aspectU.value = aspect;
    // The illumination was fitted against the frame the panel reports, so it is
    // fed the visible frame, not the sensor: a canvas that is wider than 3:2
    // crops vertically and its corners sit further out.
    frameScale.value = frameHeight;
    diagonal.value = 0.5 * Math.hypot(body.width, frameHeight);
    const falloff = lightPath.vignetting || {};
    // A fit that failed would darken or brighten the whole frame; a constant 1
    // leaves the frame as the light path found it.
    const coefficients = (fit) => [0, 1, 2, 3, 4].map(i => (fit && Number.isFinite(fit[i]) ? fit[i] : (i ? 0 : 1)));
    const [i0, i1, i2, i3, i4] = coefficients(falloff.illumination);
    const [t0, t1, t2, t3, t4] = coefficients(falloff.transmission);
    illumination.value.set(i0, i1, i2, i3); illuminationTail.value = i4;
    transmission.value.set(t0, t1, t2, t3); transmissionTail.value = t4;
    blades.value = lens.blades || 7;
    // Blades only become the rim once they have travelled in from the wide open
    // bore, and `1 - max/f` is exactly that travel as a fraction of the pupil
    // radius; the polygon is fully formed a quarter of the way in. The slider can
    // sit above the lens's own maximum, so the travel is clamped at zero rather
    // than allowed to extrapolate the polygon through its own centre.
    const travel = lightPath.stop.fNumber > 0 ? 1 - (lens.maxAperture || 1) / lightPath.stop.fNumber : 0;
    bladeMix.value = Math.max(0, Math.min(1, travel * 4));
    // The Airy disc is reported in millimetres, like every other length the light
    // path returns; the shader solves the blur in frame heights.
    airy.value = lightPath.diffraction / frameHeight;
    // `ca` is the separation between the red and blue images over a field radius
    // of one frame height, so corner red and corner blue sit 0.9 of it apart.
    chroma.value = lens.ca || 0;
    invFocus.value = 1 / state.focusDistance;
    // Circle of confusion in frame heights: (exit pupil radius) x (image
    // distance) x |1/focus - 1/distance|, the classical light path relation.
    cocCouple.value = lightPath.stop.exit * 0.5 * lightPath.imageDistance / (1000 * frameHeight);
    cropOrigin.value.set(originX / photositesX, originYTop / photositesY);
    cropSize.value.set(spanX / photositesX, spanY / photositesY);
    // The frame as it is displayed: how many device pixels tall it currently is.
    // Peeping shrinks the crop, so the frame fills the canvas with far fewer
    // photosites and this number climbs with it.
    renderer.getDrawingBufferSize(drawSize);
    framePixels.value = drawSize.y / cropSize.value.y;
    gridSize.value.set(spanX, spanY);
    gridOrigin.value.set(originX, originYTop);
    canvasRes.value.set(width, height);
    photonScale.value = sensor.photonScale;
    adcFullScale.value = sensor.photonScale / Math.pow(2, gainStops(state));
    readNoise.value = sensor.readNoise; adcMax.value = sensor.adcMax;
    noiseMix.value = state.sensorNoise ? 1 : 0;
    peepMix.value = state.peep ? 1 : 0;
    cfaMix.value = state.peep && state.cfa ? 1 : 0;
    time.value = (performance.now() - startTime) / 1000;

    world.update(time.value);

    world.scene.overrideMaterial = depthMaterial;
    renderer.setRenderTarget(depthTarget);
    renderer.render(world.scene, camera);
    world.scene.overrideMaterial = null;

    renderer.setRenderTarget(sceneTarget);
    renderer.render(world.scene, camera);

    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);

    if (captureRequest) {
      const request = captureRequest;
      captureRequest = null;
      canvas.toBlob((blob) => request.resolve(blob), request.type, request.quality);
    }

    animationFrame = requestAnimationFrame(() => render(state, lens, body, focalLength, lightPath, sensor));
  };

  // Swapping the world keeps the renderer, the camera and the optical model: the
  // next frame simply renders the new geometry into the same targets. Asset
  // buffers are marked shared by the builders, so the outgoing scene frees only
  // what it created itself.
  const mountWorld = (id) => {
    const next = buildWorld({ world: id, personAsset, vehicleAsset });
    world.dispose();
    world = next;
    refreshPickables();
  };
  const rebuildWorld = () => mountWorld(world.id);
  const setWorld = (id) => {
    if (!id || id === world.id) return false;
    mountWorld(id);
    return true;
  };

  const start = (state, lens, body, focalLength, lightPath, sensor) => { stop(); render(state, lens, body, focalLength, lightPath, sensor); };
  const stop = () => { if (animationFrame) cancelAnimationFrame(animationFrame); animationFrame = undefined; };
  const dispose = () => {
    disposed = true;
    stop(); world.dispose();
    quad.geometry.dispose(); material.dispose(); depthMaterial.dispose();
    meterQuad.geometry.dispose(); meterMaterial.dispose();
    sceneTarget.dispose(); depthTarget.dispose(); meterTarget.dispose();
    renderer.dispose();
  };
  ready = true;
  return {
    start, stop, dispose, resize, pick, sampleMeter, capture, renderer, camera, setWorld,
    // Resolves once the glTF downloads settle; `true` means the world was rebuilt
    // with (some of) them, so the caller can re-read the sources below.
    assetsReady,
    // Getters, not values: the mounted world changes when the scene is switched.
    get world() { return world; },
    get personSource() { return world.personSource; },
    get vehicleSource() { return world.vehicleSource; },
    backend: isWebGPU ? 'WebGPU' : 'WebGL2'
  };
}

// Reported once the downloads settle, so the console shows what the scene is
// actually made of rather than what it was standing in with.
function logAssets(personAsset, vehicleAsset) {
  if (personAsset) console.info(`[lens-sim] people: ${personAsset.source} (${personAsset.sourceHeight.toFixed(2)} m tall, ${personAsset.clips.length} clips, facing turned ${Math.round(personAsset.yaw * 180 / Math.PI)} deg)`);
  else console.info('[lens-sim] people: procedural figure');
  if (vehicleAsset) console.info(`[lens-sim] vehicles: ${vehicleAsset.source} (${vehicleAsset.sourceSpan.toArray().map((v) => v.toFixed(2)).join(' x ')} m authored, facing turned ${Math.round(vehicleAsset.yaw * 180 / Math.PI)} deg)`);
  else console.info('[lens-sim] vehicles: box car');
}
