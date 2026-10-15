// CMOS sensor model.
// Every number is derived from the body's published pixel count and physical
// sensor size, so changing the body changes photosite pitch, full-well,
// diffraction limit and the noise floor of the render.
export function sensorProfile(body) {
  const [pixelsX, pixelsY] = body.pixels;
  const pitchX = body.width * 1000 / pixelsX;
  const pitchY = body.height * 1000 / pixelsY;
  const pitch = (pitchX + pitchY) / 2;
  const adcMax = 2 ** body.bitDepth - 1;
  const dynamicRange = Math.log2(body.fullWell / body.readNoise);
  return {
    pixelsX, pixelsY,
    resolution: [pixelsX, pixelsY],
    megapixels: pixelsX * pixelsY / 1e6,
    pitch, pitchX, pitchY,
    fullWell: body.fullWell,
    readNoise: body.readNoise,
    qe: body.qe,
    bitDepth: body.bitDepth,
    adcMax,
    dynamicRange,
    cfa: body.cfa,
    // Radiance of 1.0 (post-exposure) fills the photosite to full well.
    photonScale: body.fullWell * body.qe
  };
}
