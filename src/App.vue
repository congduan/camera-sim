<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { APERTURES, BODIES, ISOS, LENSES, SHUTTERS, narrowestAperture, shutterLabel, widestAperture } from './core/constants';
import { computeLightPath, depthOfField } from './core/optics';
import { sensorProfile } from './core/sensor';
import { exposureDeviation, gainStops } from './core/exposure';
import { createCameraState } from './core/cameraState';
import { createRenderer } from './core/webglRenderer';
import { withExif } from './core/exif';
import { METERING_MODES, calibrateEv, luminanceToEv, meteringCentre } from './core/metering';
import { bodyName, hint, htmlLang, lensDesign, locale, t, toggleLocale } from './core/i18n';

const canvas = ref(null); const error = ref(''); const help = ref(false); const previewSrc = ref(''); const dragging = ref(null); const didDrag = ref(false); const personSource = ref(null); const vehicleSource = ref(null); let renderer;
// The panel carries a lot of instrumentation, which on a phone would sit on top
// of the whole viewfinder. Below the sheet breakpoint it therefore starts folded
// into a bottom drawer that still offers the exposure readout and the shutter.
const narrowQuery = window.matchMedia('(max-width: 760px)');
const panelOpen = ref(!narrowQuery.matches);
function syncNarrow(event) { panelOpen.value = !event.matches; }
function toggleHelp() { help.value = !help.value; if (help.value) panelOpen.value = true; }
const { state, reset, currentLens, currentBody, focal, update } = createCameraState();
const lens = computed(() => currentLens()); const body = computed(() => currentBody());
const aperture = computed(() => APERTURES[state.aperture]); const shutter = computed(() => SHUTTERS[state.shutter]); const iso = computed(() => ISOS[state.iso]);
// The aperture slider spans only what the mounted lens has: an f/1.8 lens cannot
// be opened to f/1.2, and binding the wide end to the track means the handle sits
// where the f-number says it does instead of being clamped back on every drag.
const apertureMin = computed(() => widestAperture(lens.value));
const apertureMax = computed(() => narrowestAperture(lens.value));
const deviation = computed(() => exposureDeviation(state));
// Camera meters read positive when the frame will be brighter than correct, so
// the internal "+1 stop darker" deviation is negated for display.
const meter = computed(() => -deviation.value);
const gainEv = computed(() => gainStops(state));
const gainFullWell = computed(() => (sensor.value.fullWell / Math.pow(2, gainStops(state)) / 1000).toFixed(1));
const dof = computed(() => depthOfField({ focal: focal(), apertureIndex: state.aperture, focusDistance: state.focusDistance, bodyIndex: state.body }));
const lightPath = computed(() => computeLightPath({ lens: lens.value, focal: focal(), apertureIndex: state.aperture, focusDistance: state.focusDistance, body: body.value }));
const sensor = computed(() => sensorProfile(body.value));
const fov = computed(() => 2 * Math.atan(Math.hypot(body.value.width, body.value.height) / (2 * focal())) * 180 / Math.PI);
const formatDistance = value => value >= 10 ? `${value.toFixed(1)}m` : `${value.toFixed(2)}m`;
const formatMicron = value => `${value.toFixed(2)}µm`;
const exif = computed(() => `f/${aperture.value} · ${shutterLabel(shutter.value)} · ISO ${iso.value} · ${Math.round(focal())}mm · ${formatDistance(state.focusDistance)} · EV ${meter.value >= 0 ? '+' : ''}${meter.value.toFixed(1)}`);
function clampPeep() { state.peepX = Math.max(0, Math.min(sensor.value.pixelsX, state.peepX)); state.peepY = Math.max(0, Math.min(sensor.value.pixelsY, state.peepY)); }
function centerPeep() { state.peepX = sensor.value.pixelsX / 2; state.peepY = sensor.value.pixelsY / 2; }
function refresh() { update(); clampPeep(); if (renderer) renderer.start(state, lens.value, body.value, focal(), lightPath.value, sensor.value); }
function setLens(index) { state.lens = Number(index); state.zoom = 0; state.focusDistance = lens.value.mfd; refresh(); }
function setBody(index) { state.body = Number(index); centerPeep(); refresh(); }
function setMode(mode) { state.mode = mode; refresh(); }
// Autofocus. The box is placed where the frame was tapped, then snaps onto a
// face when the ray landed on a person, and the lens racks to that distance. The
// short delay is what makes it read as an acquisition rather than an instant jump.
const afStyle = computed(() => ({ left: `${state.afX * 100}%`, top: `${state.afY * 100}%` }));
const afStatus = computed(() => state.afState === 'searching' ? t('afSearching') : state.afState === 'locked' ? t('afLocked') : t('afFailed'));
let afTimers = [];
function clearAfTimers() { afTimers.forEach(clearTimeout); afTimers = []; }
function focus(event) {
  if (didDrag.value) { didDrag.value = false; return; }
  const rect = canvas.value.getBoundingClientRect();
  state.afX = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
  state.afY = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
  const result = renderer?.pick(event.clientX, event.clientY);
  clearAfTimers();
  state.afState = 'searching';
  afTimers.push(setTimeout(() => {
    if (!result) {
      state.afState = 'failed';
    } else {
      if (result.snap) { state.afX = result.snap.x; state.afY = result.snap.y; }
      state.focusDistance = Math.max(lens.value.mfd, Math.min(30, result.snap ? result.snap.distance : result.distance));
      state.lockSubject = false;
      refresh();
      state.afState = 'locked';
    }
    afTimers.push(setTimeout(() => { state.afState = 'idle'; }, 850));
  }, 170));
  meterSoon();   // the narrow patterns meter around the focus point
}

// Metering. The frame is reduced on the GPU and read back a few times a second,
// the way a camera meter samples continuously. The first reading calibrates the
// scale, which is what ties relative renderer luminance to the scene EV.
let meterCalibration = null; let meterTimer; let meterDebounce;
async function meterNow() {
  if (!renderer) return;
  const centre = meteringCentre(state);
  const luminance = await renderer.sampleMeter(state.metering, centre.x, centre.y);
  if (!(luminance > 0)) return;
  if (meterCalibration === null) meterCalibration = calibrateEv(luminance);
  const ev = luminanceToEv(luminance, meterCalibration);
  // Only re-expose on a meaningful change, so meter noise cannot make the
  // shutter flicker between two adjacent values.
  if (Math.abs(ev - state.sceneEv) > 0.05) { state.sceneEv = ev; refresh(); }
}
function meterSoon() { if (meterDebounce) clearTimeout(meterDebounce); meterDebounce = setTimeout(meterNow, 80); }
function setMetering(mode) { state.metering = mode; meterSoon(); }
function resetAll() { reset(); centerPeep(); refresh(); }
// The pixels alone are not a photograph: a camera writes the exposure, the lens
// and where it was pointed into the file. Everything the panel reports is
// gathered here so a saved JPEG can be checked against the viewfinder.
const METERING_EXIF = { evaluative: 5, centre: 2, partial: 6, spot: 3 };
const EXPOSURE_PROGRAM = { M: 1, Av: 3, Tv: 4 };
let shotBlob = null;

function shotMeta() {
  const far = dof.value.far === Infinity ? 'inf' : formatDistance(dof.value.far);
  return {
    make: body.value.name.split(' ')[0],
    model: body.value.name.split(' · ')[0],
    lensMake: lens.value.name.split(' ')[0],
    lensModel: lens.value.name,
    software: 'Lens Sim',
    description: `f/${aperture.value} ${shutterLabel(shutter.value)} ISO ${iso.value} ${Math.round(focal())}mm`,
    comment: [
      `light path: image ${lightPath.value.imageDistance.toFixed(2)}mm`,
      `pupil ${lightPath.value.stop.magnification.toFixed(2)}x`,
      `CoC@4m ${(lightPath.value.coc.subject * body.value.sensorHeight * 1000).toFixed(1)}um`,
      `DoF ${formatDistance(dof.value.near)}-${far}`,
      `WB ${state.whiteBalance}K`,
      `meter ${state.metering} ${state.sceneEv.toFixed(1)}EV`
    ].join(', '),
    focalLength: focal(),
    focalLength35: focal() * body.value.crop,
    fNumber: aperture.value,
    exposureTime: shutter.value,
    iso: iso.value,
    exposureProgram: EXPOSURE_PROGRAM[state.mode] ?? 0,
    exposureMode: state.mode === 'M' ? 1 : 0,
    meteringMode: METERING_EXIF[state.metering] ?? 0,
    exposureBias: state.exposureComp,
    whiteBalance: 1,
    subjectDistance: state.focusDistance,
    lensSpec: [lens.value.min, lens.value.max, lens.value.maxAperture, lens.value.maxAperture],
    width: canvas.value?.width ?? 0,
    height: canvas.value?.height ?? 0,
    date: new Date()
  };
}

async function takePhoto() {
  if (!renderer) return;
  if (previewSrc.value) URL.revokeObjectURL(previewSrc.value);
  shotBlob = await renderer.capture('image/jpeg', 0.95);
  previewSrc.value = shotBlob ? URL.createObjectURL(shotBlob) : '';
  state.shots += 1;
}
function closePreview() { if (previewSrc.value) URL.revokeObjectURL(previewSrc.value); previewSrc.value = ''; }
async function downloadPhoto() {
  if (!shotBlob) return;
  try {
    const blob = await withExif(shotBlob, shotMeta());
    const link = document.createElement('a');
    link.download = `lens-sim-${Date.now()}.jpg`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 3000);
  } catch (err) {
    error.value = err.message;
  }
}
function startDrag(event) { dragging.value = { x: event.clientX, y: event.clientY }; canvas.value?.setPointerCapture(event.pointerId); }
function moveView(event) { if (!dragging.value) return; const dx = event.clientX - dragging.value.x; const dy = event.clientY - dragging.value.y; if (Math.abs(dx) + Math.abs(dy) > 2) didDrag.value = true; if (state.peep) { const rect = canvas.value.getBoundingClientRect(); const step = state.peepSpan / Math.max(1, rect.width); state.peepX -= dx * step; state.peepY += dy * step * (sensor.value.pixelsY / (sensor.value.pixelsX * rect.height / Math.max(1, rect.width))); } else { state.yaw = Math.max(-.45, Math.min(.45, state.yaw - dx * .0025)); state.pitch = Math.max(-.25, Math.min(.25, state.pitch + dy * .0025)); } dragging.value = { x: event.clientX, y: event.clientY }; refresh(); }
function endDrag() { dragging.value = null; }
function zoomBy(delta) { if (lens.value.min === lens.value.max) return; state.zoom = Math.max(0, Math.min(100, state.zoom + (delta > 0 ? 4 : -4))); refresh(); }
function setView(yaw, pitch = 0) { state.yaw = yaw; state.pitch = pitch; refresh(); }

// Virtual viewfinder. The frame is shown inside a 3:2 eyepiece, which is also the
// sensor's own aspect, so the viewfinder shows the whole frame with no vertical
// crop. The canvas changes size, so the render targets have to be resized once
// the browser has laid the class out.
const needleLeft = computed(() => `${((Math.max(-3, Math.min(3, meter.value)) + 3) / 6) * 100}%`);
const needleClass = computed(() => Math.abs(meter.value) <= 0.5 ? 'ok' : meter.value > 0 ? 'over' : 'under');
async function toggleViewfinder() {
  state.viewfinder = !state.viewfinder;
  await nextTick();
  renderer?.resize();
  refresh();
}
watch(() => [state.aperture, state.shutter, state.iso, state.zoom, state.focusDistance, state.lens, state.body, state.mode, state.grid, state.whiteBalance, state.yaw, state.pitch, state.peep, state.peepX, state.peepY, state.peepSpan, state.cfa, state.sensorNoise], refresh, { deep: true });
function handleResize() { renderer?.resize(); refresh(); }
watch([locale, htmlLang], () => { document.documentElement.lang = htmlLang.value; document.title = t('documentTitle'); }, { immediate: true });
onMounted(async () => { await nextTick(); try { centerPeep(); renderer = await createRenderer(canvas.value); personSource.value = renderer.personSource; vehicleSource.value = renderer.vehicleSource; renderer.start(state, lens.value, body.value, focal(), lightPath.value, sensor.value); window.addEventListener('resize', handleResize); narrowQuery.addEventListener('change', syncNarrow); meterTimer = setInterval(meterNow, 400); } catch (err) { error.value = err.message; } });
onBeforeUnmount(() => { window.removeEventListener('resize', handleResize); narrowQuery.removeEventListener('change', syncNarrow); clearInterval(meterTimer); clearTimeout(meterDebounce); clearAfTimers(); if (previewSrc.value) URL.revokeObjectURL(previewSrc.value); renderer?.dispose(); });
</script>

<template>
  <main class="camera-app"><div class="stage" :class="{ evf: state.viewfinder }"><canvas ref="canvas" class="viewport" @click="focus" @pointerdown="startDrag" @pointermove="moveView" @pointerup="endDrag" @pointercancel="endDrag" @wheel.prevent="zoomBy($event.deltaY)"></canvas><section class="assist" :class="{ on: state.grid }"><span></span><span></span></section><div v-if="state.afState !== 'idle'" class="af-box" :class="state.afState" :style="afStyle" role="status"><span></span><span></span><span></span><span></span><em>{{ afStatus }}</em></div>
      <div v-if="state.viewfinder" class="evf"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i><div class="evf-bar top"><span>{{ state.mode }}</span><span>{{ t('meter' + state.metering.charAt(0).toUpperCase() + state.metering.slice(1)) }}</span><span>{{ state.whiteBalance }}K</span><span>{{ Math.round(focal() * body.crop) }}mm {{ t('equivalentShort') }}</span></div><div class="evf-scale"><i v-for="n in 13" :key="n" :class="{ major: (n - 7) % 2 === 0 }"></i><b :class="needleClass" :style="{ left: needleLeft }"></b></div><div class="evf-bar bottom"><span><b>f/{{ aperture }}</b> {{ shutterLabel(shutter) }}</span><span><b>ISO {{ iso }}</b></span><span>{{ Math.round(focal()) }}mm</span><span>{{ t('shots') }} <b>{{ String(state.shots).padStart(4, '0') }}</b></span></div></div></div><div v-if="error" class="fatal">⚠️ {{ error }}</div>
    <header class="topbar"><span>{{ exif }}</span><b>LENS SIM · VUE ENGINE</b></header>
    <aside class="control-panel" :class="{ collapsed: !panelOpen }"><div class="panel-title"><div><small>{{ t('tagline') }}</small><h1>{{ t('appTitle') }}</h1></div><div class="panel-actions"><button class="locale" :title="t('switchTo')" @click="toggleLocale">{{ t('switchTo') }}</button><button @click="toggleHelp">?</button><button class="fold" :aria-expanded="panelOpen" :aria-label="panelOpen ? t('collapsePanel') : t('expandPanel')" :title="panelOpen ? t('collapsePanel') : t('expandPanel')" @click="panelOpen = !panelOpen">{{ panelOpen ? '▾' : '▴' }}</button></div></div>
      <div class="panel-compact"><span>{{ exif }}</span><button class="mini-shutter" type="button" :aria-label="t('photoPreview')" @click="takePhoto"><span></span></button></div>
      <div class="panel-body"><div v-if="help" class="help">{{ t('helpA') }}<br>{{ t('helpB') }}<br>{{ t('helpC') }}</div>
      <div class="modes"><button v-for="mode in ['Av','Tv','M']" :key="mode" :class="{ active: state.mode === mode }" @click="setMode(mode)">{{ mode }}</button></div>
      <div class="selectors"><label>{{ t('lens') }}<select :value="state.lens" @change="setLens($event.target.value)"><option v-for="(item,index) in LENSES" :key="item.id" :value="index">{{ item.name }}</option></select></label><label>{{ t('body') }}<select :value="state.body" @change="setBody($event.target.value)"><option v-for="(item,index) in BODIES" :key="item.id" :value="index">{{ bodyName(item) }}</option></select></label></div>
      <div class="readouts"><span>{{ t('aperture') }}<strong>f/{{ aperture }}</strong><input v-model.number="state.aperture" type="range" :min="apertureMin" :max="apertureMax" :disabled="state.mode === 'Tv'" /></span><span>{{ t('shutter') }}<strong>{{ shutterLabel(shutter) }}</strong><input v-model.number="state.shutter" type="range" min="0" :max="SHUTTERS.length - 1" :disabled="state.mode === 'Av'" /></span><span>ISO<strong>{{ iso }}</strong><input v-model.number="state.iso" type="range" min="0" :max="ISOS.length - 1" /></span><span>{{ t('focal') }}<strong>{{ Math.round(focal()) }}mm</strong><input v-model.number="state.zoom" type="range" min="0" max="100" :disabled="lens.min === lens.max" /></span><span>{{ t('focus') }}<strong>{{ formatDistance(state.focusDistance) }}</strong><input v-model.number="state.focusDistance" type="range" :min="lens.mfd" max="30" step=".01" @input="state.lockSubject = false" /></span><span>{{ t('whiteBalance') }}<strong>{{ state.whiteBalance }}K</strong><input v-model.number="state.whiteBalance" type="range" min="2500" max="9500" step="100" /></span></div>
      <div class="meta">{{ t('depthOfField') }} {{ formatDistance(dof.near) }} – {{ dof.far === Infinity ? '∞' : formatDistance(dof.far) }} · {{ t('hyperfocal') }} {{ formatDistance(dof.hyperfocal) }}<br>{{ lens.blades }} {{ t('blades') }} · MFD {{ lens.mfd.toFixed(2) }}m · {{ t('equivalentShort') }} {{ Math.round(focal() * body.crop) }}mm</div>
      <div class="optics"><div><h2>{{ t('lightPath') }} · {{ lensDesign(lens) }}</h2>
        <span>{{ t('equivalentFocal') }}<b>{{ focal().toFixed(1) }}mm</b></span><span>{{ t('imageDistance') }}<b>{{ lightPath.imageDistance.toFixed(2) }}mm</b></span><span>{{ t('entrancePupil') }}<b>{{ lightPath.stop.entrance.toFixed(1) }}mm</b></span>
        <span>{{ t('exitPupil') }}<b>{{ lightPath.stop.exit.toFixed(1) }}mm</b></span><span>{{ t('pupilMagnification') }}<b>{{ lightPath.stop.magnification.toFixed(2) }}×</b></span><span>{{ t('airyRadius') }}<b>{{ (lightPath.diffraction * 1000).toFixed(2) }}µm</b></span>
        <span>{{ t('diagonalFov') }}<b>{{ fov.toFixed(1) }}°</b></span>
      </div><div><h2>CMOS · {{ sensor.cfa }}</h2>
        <span>{{ t('resolution') }}<b>{{ sensor.pixelsX }}×{{ sensor.pixelsY }}</b></span><span>{{ t('pixelPitch') }}<b>{{ formatMicron(sensor.pitch) }}</b></span><span>{{ t('totalPixels') }}<b>{{ sensor.megapixels.toFixed(1) }}MP</b></span>
        <span>{{ t('fullWell') }}<b>{{ (sensor.fullWell / 1000).toFixed(0) }}ke⁻</b></span><span>{{ t('readNoise') }}<b>{{ sensor.readNoise.toFixed(1) }}e⁻</b></span><span>{{ t('quantumEfficiency') }}<b>{{ (sensor.qe * 100).toFixed(0) }}%</b></span>
        <span>{{ t('dynamicRange') }}<b>{{ sensor.dynamicRange.toFixed(1) }}EV</b></span><span>ADC<b>{{ sensor.bitDepth }}bit</b></span><span>{{ t('coc') }}<b>{{ (lightPath.coc.subject * body.sensorHeight * 1000).toFixed(1) }}µm</b></span>
        <span>{{ t('isoGain') }}<b>{{ gainEv >= 0 ? '+' : '' }}{{ gainEv.toFixed(0) }}EV → {{ t('singleFrameWell') }} {{ gainFullWell }}ke⁻</b></span>
        <span>{{ t('character') }}<b>{{ personSource ?? t('characterFallback') }}</b></span>
        <span>{{ t('vehicle') }}<b>{{ vehicleSource ?? t('vehicleFallback') }}</b></span>
      </div></div>
      <div class="view-tools"><button @click="setView(-.3)">{{ t('lookLeft') }}</button><button @click="setView(0)">{{ t('frontView') }}</button><button @click="setView(.3)">{{ t('lookRight') }}</button></div><button class="shutter" type="button" :aria-label="t('photoPreview')" @click="takePhoto"><span></span></button><div v-if="state.peep" class="view-tools"><label>{{ t('peepField') }} {{ Math.round(state.peepSpan) }}px<input v-model.number="state.peepSpan" type="range" min="8" max="400" step="2" /></label><button @click="centerPeep">{{ t('recenter') }}</button></div><div class="meter-row"><span class="meter-label">{{ t('metering') }}</span><button v-for="mode in METERING_MODES" :key="mode" :class="{ active: state.metering === mode }" @click="setMetering(mode)">{{ t('meter' + mode.charAt(0).toUpperCase() + mode.slice(1)) }}</button><span class="meter-ev">{{ t('meteredEv') }} {{ state.sceneEv.toFixed(1) }}</span></div><div class="tools"><button :class="{ active: state.grid }" :title="hint('distortionGrid')" @click="state.grid = !state.grid">{{ t('distortionGrid') }}</button><button :class="{ active: state.lockSubject }" :title="hint('lockSubject')" @click="state.lockSubject = !state.lockSubject">{{ t('lockSubject') }}</button><button :class="{ active: state.sensorNoise }" :title="hint('cmosNoise')" @click="state.sensorNoise = !state.sensorNoise">{{ t('cmosNoise') }}</button><button :class="{ active: state.cfa }" :title="hint('bayerArray')" :disabled="!state.peep" @click="state.cfa = !state.cfa">{{ t('bayerArray') }}</button><button :class="{ active: state.peep }" :title="hint('pixelPeep')" @click="state.peep = !state.peep">{{ t('pixelPeep') }}</button><button :class="{ active: state.viewfinder }" :title="hint('viewfinder')" @click="toggleViewfinder">{{ t('viewfinder') }}</button><button :title="hint('resetRig')" @click="resetAll">{{ t('resetRig') }}</button></div>
      </div>
    </aside>
    <section v-if="previewSrc" class="playback" :aria-label="t('photoPreview')"><img :src="previewSrc" :alt="t('shotPreviewAlt')" /><div class="playback-actions"><button @click="closePreview">{{ t('backToViewfinder') }}</button><button class="primary" @click="downloadPhoto">{{ t('savePhoto') }}</button></div></section>
  </main>
</template>
