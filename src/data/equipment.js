// Manufacturer specifications captured 2026-10-15.
// These values are authoritative mechanical/spec inputs; optical prescriptions
// are not published by manufacturers, so the renderer uses a thin-lens model
// calibrated from these public specifications.
export const EQUIPMENT_SOURCES = {
  rf50: 'https://www.canon-europe.com/files/webcontent/rf-lens-world/features/rf-lineup/index.html?pop=pop34',
  ef70200: 'https://sfcc-service.canon-europe.com/3044C005/3044C005.html',
  ef1635: 'https://sfcc-service.canon-europe.com/0573C005/0573C005.html',
  z85: 'https://www.nikonusa.com/p/nikkor-z-85mm-f12-s/20114/overview',
  fe2470: 'https://electronics.sony.com/imaging/lenses/all-e-mount/p/sel2470gm2',
  r62: 'https://sfcc-service.canon-europe.com/5666C004/5666C004.html',
  d90: 'https://sfcc-service.canon-europe.com/3616C003/3616C003.html'
};

// Mount throat diameters, in mm, as published in the mount specifications. The
// throat is the mechanical limit the rear of the barrel has to live inside, so
// it doubles as the rear aperture of the modelled light path.
export const MOUNTS = { RF: 54, EF: 54, Z: 55, E: 46.1 };

// `pupilMagnification` is the exit/entrance pupil diameter ratio. It is set from
// each lens's published construction type: retrofocus wide-angles shrink the
// exit pupil (<1), telephoto designs grow it (>1). It scales the size of the
// out-of-focus cones and therefore the light path itself.
//
// `backFocus` (mm) is the distance from the rear vertex of the lens to the film
// plane: the mount register keeps it roughly constant across a zoom, so it is
// given in millimetres rather than as a multiple of the focal length. Like the
// pupil magnification it is a modelled value inferred from the construction type.
export const VERIFIED_LENSES = [
  { id: 'rf50', name: 'Canon RF 50mm F1.8 STM', min: 50, max: 50, maxAperture: 1.8, minAperture: 22, blades: 7, mfd: 0.30, filter: 43, weight: 160, elements: 6, groups: 5, distortion: -0.015, ca: 0.004, pupilMagnification: 1.06, mount: 'RF', backFocus: 39, design: '标准双高斯', source: EQUIPMENT_SOURCES.rf50 },
  { id: 'ef70200', name: 'Canon EF 70-200mm F2.8L IS III USM', min: 70, max: 200, maxAperture: 2.8, minAperture: 32, blades: 8, mfd: 1.20, filter: 77, weight: 1480, elements: 23, groups: 19, distortion: -0.004, ca: 0.0015, pupilMagnification: 1.22, mount: 'EF', backFocus: 65, design: '内对焦远摄', source: EQUIPMENT_SOURCES.ef70200 },
  { id: 'ef1635', name: 'Canon EF 16-35mm F2.8L III USM', min: 16, max: 35, maxAperture: 2.8, minAperture: 22, blades: 9, mfd: 0.28, filter: 82, weight: 790, elements: 16, groups: 11, distortion: -0.085, ca: 0.008, pupilMagnification: 0.72, mount: 'EF', backFocus: 40, design: '反望远广角', source: EQUIPMENT_SOURCES.ef1635 },
  { id: 'z85', name: 'NIKKOR Z 85mm F1.2 S', min: 85, max: 85, maxAperture: 1.2, minAperture: 16, blades: 11, mfd: 0.85, filter: 82, weight: 1160, elements: 15, groups: 10, distortion: -0.002, ca: 0.001, pupilMagnification: 1.15, mount: 'Z', backFocus: 35, design: '大口径远摄', source: EQUIPMENT_SOURCES.z85 },
  { id: 'fe2470', name: 'Sony FE 24-70mm F2.8 GM II', min: 24, max: 70, maxAperture: 2.8, minAperture: 22, blades: 11, mfd: 0.21, mfdTele: 0.30, filter: 82, weight: 695, elements: 20, groups: 15, distortion: -0.02, ca: 0.004, pupilMagnification: 0.98, mount: 'E', backFocus: 30, design: '反望远变焦', source: EQUIPMENT_SOURCES.fe2470 }
];

// Sensor parameters feed the CMOS model: `pixels` is the active photosite
// count, `fullWell` the saturation charge per photosite in electrons,
// `readNoise` the input-referred read noise in electrons, `qe` the peak
// quantum efficiency and `bitDepth` the ADC resolution.
export const VERIFIED_BODIES = [
  { id: 'r62', name: 'Canon EOS R6 Mark II · 全画幅', width: 36.0, height: 24.0, crop: 1, pixels: [6000, 4000], fullWell: 50000, readNoise: 3.0, qe: 0.72, bitDepth: 14, cfa: 'RGGB', source: EQUIPMENT_SOURCES.r62 },
  { id: '5d4', name: 'Canon EOS 5D Mark IV · 全画幅', width: 36.0, height: 24.0, crop: 1, pixels: [6720, 4480], fullWell: 47000, readNoise: 3.6, qe: 0.55, bitDepth: 14, cfa: 'RGGB', source: EQUIPMENT_SOURCES.r62 },
  { id: '90d', name: 'Canon EOS 90D · APS-C', width: 22.3, height: 14.9, crop: 1.6, pixels: [6960, 4640], fullWell: 32000, readNoise: 2.8, qe: 0.62, bitDepth: 14, cfa: 'RGGB', source: EQUIPMENT_SOURCES.d90 }
];
