import test from 'node:test';
import assert from 'node:assert/strict';
import { APERTURES, BODIES, LENSES, narrowestAperture, widestAperture } from '../src/core/constants.js';
import { createCameraState } from '../src/core/cameraState.js';
import { autoExpose } from '../src/core/exposure.js';
import { blurRadius, computeLightPath, imageDistance, traceMarginalRay } from '../src/core/optics.js';
import { apertureTransmission, fitPolynomial } from '../src/core/rayTrace.js';

const BODY = BODIES[0];
const evaluate = (fit, x) => fit.reduce((sum, coefficient, order) => sum + coefficient * x ** order, 0);
const legal = (lens) => {
  const indices = [];
  for (let index = widestAperture(lens); index <= narrowestAperture(lens); index++) indices.push(index);
  return indices;
};

// ---------------------------------------------------------------------------
// The aperture range the panel offers has to be a range the lens really has.
// ---------------------------------------------------------------------------
test('every lens is offered exactly the apertures it is built with', () => {
  const expected = {
    rf50: { widest: 3, narrowest: 11 },     // f/1.8 .. f/22
    ef70200: { widest: 5, narrowest: 11 },  // f/2.8 .. f/22 (table holds no f/32)
    ef1635: { widest: 5, narrowest: 11 },
    z85: { widest: 0, narrowest: 10 },      // f/1.2 .. f/16
    fe2470: { widest: 5, narrowest: 11 }
  };
  assert.deepEqual(Object.keys(expected).sort(), LENSES.map(lens => lens.id).sort());
  for (const lens of LENSES) {
    assert.equal(widestAperture(lens), expected[lens.id].widest, `${lens.id} widest`);
    assert.equal(narrowestAperture(lens), expected[lens.id].narrowest, `${lens.id} narrowest`);
    // The two ends have to agree with the published numbers, whichever way they
    // are expressed in the table.
    assert.ok(APERTURES[widestAperture(lens)] >= lens.maxAperture, `${lens.id} cannot open past its own maximum`);
    assert.ok(APERTURES[narrowestAperture(lens)] <= lens.minAperture, `${lens.id} cannot close past its own minimum`);
  }
});

test('the camera clamps the aperture into that range from either side', () => {
  for (const lens of LENSES) {
    const camera = createCameraState();
    camera.state.lens = LENSES.indexOf(lens);
    camera.state.aperture = 0;                       // drag wide open
    camera.update();
    assert.equal(camera.state.aperture, widestAperture(lens), `${lens.id} clamps up to its widest`);
    camera.state.aperture = APERTURES.length - 1;    // drag closed
    camera.update();
    assert.equal(camera.state.aperture, narrowestAperture(lens), `${lens.id} clamps down to its narrowest`);
  }
});

test('Tv metering never selects an aperture the lens does not have', () => {
  for (const lens of LENSES) {
    const camera = createCameraState();
    camera.state.lens = LENSES.indexOf(lens);
    camera.state.mode = 'Tv';
    let previous = null;
    for (let shutter = 0; shutter < 19; shutter++) {
      camera.state.shutter = shutter;
      autoExpose(camera.state, lens);
      assert.ok(camera.state.aperture >= widestAperture(lens), `${lens.id} stays closed enough for shutter index ${shutter}`);
      assert.ok(camera.state.aperture <= narrowestAperture(lens), `${lens.id} stays open enough for shutter index ${shutter}`);
      previous = camera.state.aperture;
    }
    assert.ok(previous !== null);
  }
});

// ---------------------------------------------------------------------------
// Illumination and vignetting.
// ---------------------------------------------------------------------------
test('the illumination curve is 1 on the axis and falls towards the corner', () => {
  for (const lens of LENSES) {
    for (const index of legal(lens)) {
      const light = computeLightPath({ lens, focal: lens.max, apertureIndex: index, focusDistance: 3, body: BODY });
      const { illumination, transmission, samples } = light.vignetting;
      const where = `${lens.id} f/${APERTURES[index]}`;
      assert.ok(Math.abs(evaluate(illumination, 0) - 1) < 5e-3, `${where} is 1 on the axis`);
      assert.ok(evaluate(illumination, 1) <= 1, `${where} does not brighten at the corner`);
      assert.ok(evaluate(illumination, 1) > 0.2, `${where} does not extinguish the corner`);
      assert.ok(evaluate(transmission, 1) <= 1, `${where} vignetting is a loss`);
      // The curve the shader evaluates has to be the curve the trace sampled.
      // A quartic cannot follow the knee a hard rear rim puts in the falloff
      // when it starts cutting the oblique beam: measured over every lens and
      // every legal aperture the worst case is the 70-200 at f/2.8, where the
      // fit is 1.21e-2 away from the trace mid-field. That is the model's
      // accuracy, and it is asserted here rather than assumed.
      for (const sample of samples) {
        assert.ok(Math.abs(evaluate(illumination, sample.fraction ** 2) - sample.relative) < 1.5e-2, `${where} fit tracks the trace`);
      }
      // ... and the trace's own samples cannot rise with field height.
      for (let i = 1; i < samples.length; i++) {
        assert.ok(samples[i].relative <= samples[i - 1].relative + 1e-6, `${where} falloff is monotone`);
      }
    }
  }
});

test('stopping down relieves vignetting and shrinks the circle of confusion', () => {
  for (const lens of LENSES) {
    const indices = legal(lens);
    const path = (index) => computeLightPath({ lens, focal: lens.max, apertureIndex: index, focusDistance: 3, body: BODY });
    const open = path(indices[0]); const shut = path(indices[indices.length - 1]);
    assert.ok(shut.coc.buildings < open.coc.buildings, `${lens.id} gathers a tighter cone closed down`);
    assert.ok(shut.stop.exit < open.stop.exit, `${lens.id} exit pupil shrinks`);
    assert.ok(shut.vignetting.corner.mechanical >= open.vignetting.corner.mechanical - 1e-9, `${lens.id} vignetting does not worsen as it closes`);
  }
});

// ---------------------------------------------------------------------------
// Diffraction, the term that stops a small aperture from being perfectly sharp.
// ---------------------------------------------------------------------------
test('the Airy disc grows with f-number and is reported as a radius', () => {
  const wavelength = 550e-6;                       // mm
  for (const lens of LENSES) {
    let previous = 0;
    for (const index of legal(lens)) {
      const light = computeLightPath({ lens, focal: lens.max, apertureIndex: index, focusDistance: 3, body: BODY });
      const expected = 1.22 * wavelength * APERTURES[index];
      assert.ok(Math.abs(light.diffraction - expected) < 1e-9, `${lens.id} f/${APERTURES[index]} Airy radius`);
      assert.ok(light.diffraction > previous, `${lens.id} diffraction grows as the aperture closes`);
      previous = light.diffraction;
      // The spread the panel reports is the two discs combined as the renderer
      // combines them, which is what keeps the two in step.
      for (const [name, radius] of Object.entries(light.layers)) {
        assert.ok(Math.abs(light.psf[name] - Math.hypot(radius.radius, light.diffraction) / light.sensorHeight) < 1e-12, `${lens.id} ${name} psf`);
      }
    }
  }
});

test('a wide open aperture is diffraction limited long before it is defocus limited', () => {
  const lens = LENSES[0];
  const light = computeLightPath({ lens, focal: lens.max, apertureIndex: 11, focusDistance: 3, body: BODY });
  // At f/22 the Airy radius covers a couple of photosites: the frame is soft
  // because of the aperture, not because of the focus.
  const pitch = BODY.width / BODY.pixels[0];
  assert.ok(light.diffraction / pitch > 2, `Airy radius covers ${(light.diffraction / pitch).toFixed(2)} photosites`);
  assert.ok(light.psf.buildings > light.coc.buildings, 'diffraction dominates the far buildings');
});

// ---------------------------------------------------------------------------
// The circle of confusion itself.
// ---------------------------------------------------------------------------
test('the circle of confusion vanishes at the plane that is in focus', () => {
  for (const lens of LENSES) {
    const index = widestAperture(lens);
    const focal = lens.max;
    assert.ok(blurRadius(lens, focal, index, 3, 3) < 1e-9, `${lens.id} is sharp at the focus distance`);
    assert.ok(blurRadius(lens, focal, index, 3, 4) > 0, `${lens.id} blurs behind it`);
    assert.ok(blurRadius(lens, focal, index, 3, 2) > 0, `${lens.id} blurs in front of it`);
  }
});

test('image distance and the marginal ray agree with the thin lens relation', () => {
  const focal = 50;
  const object = 3000;                                    // mm
  const image = imageDistance(focal, object);
  assert.ok(Math.abs(1 / focal - 1 / object - 1 / image) < 1e-12, 'conjugate relation holds');
  // A ray through the edge of the entrance pupil lands on the axis at focus.
  assert.ok(Math.abs(traceMarginalRay(focal, object, 12.5, image)) < 1e-9);
});

// ---------------------------------------------------------------------------
// The primitives the light path is built from.
// ---------------------------------------------------------------------------
test('aperture transmission is 1 when nothing clips and falls as rims close in', () => {
  assert.equal(apertureTransmission(10, []), 1);
  const clip = (semiDiameter) => [{ scale: 1, shift: 0, semiDiameter }];
  const wide = apertureTransmission(10, clip(12));
  const tight = apertureTransmission(10, clip(6));
  assert.equal(wide, 1, 'a rim wider than the stop removes nothing');
  assert.ok(tight > 0 && tight < 1, 'a rim inside the stop removes light');
  assert.ok(tight < wide);
  // Shifting the rim off axis removes more than leaving it centred.
  assert.ok(apertureTransmission(10, [{ scale: 1, shift: 5, semiDiameter: 10 }]) < 1);
});

test('the falloff fit reproduces a polynomial it was given', () => {
  const coefficients = [1, -0.3, 0.08, -0.016, 0.0022];
  const samples = [];
  for (let i = 0; i <= 20; i++) {
    const x = i / 20;
    samples.push([x, coefficients.reduce((sum, c, order) => sum + c * x ** order, 0)]);
  }
  const fit = fitPolynomial(samples);
  assert.equal(fit.length, coefficients.length);
  for (const [x, value] of samples) assert.ok(Math.abs(evaluate(fit, x) - value) < 1e-9, `reproduces x=${x}`);
});

test('focus is clamped to what the lens can actually focus on', () => {
  const camera = createCameraState();
  camera.state.focusDistance = 0.01;
  camera.update();
  assert.ok(camera.state.focusDistance >= LENSES[camera.state.lens].mfd);
});
