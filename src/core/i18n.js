import { computed, ref } from 'vue';

// Presentation-layer localization. Equipment specs stay authoritative in
// `data/equipment.js`; only their human-readable labels live here.
const STORAGE_KEY = 'lens-sim.locale';

const zh = {
  documentTitle: 'Lens Sim · WebGL 相机仿真器',
  tagline: '模块化光学仿真器',
  appTitle: '相机实验室',
  helpA: '点击画面任意物体即可对它合焦（射线拾取真实几何），拖动改变取景方向，滚轮调整变焦。Av/Tv 会自动联动曝光，M 模式可观察过曝与欠曝。',
  helpB: '焦距与传感器尺寸直接映射到透视相机的 FOV，景深由深度缓冲与旁轴光路（出瞳、像距）逐像素解算，焦外是真实几何的散景；开启「像素窥视」后画面按真实感光像元成像，可看到拜耳阵列与光子散粒噪声，此时拖动为平移取样区域。', helpC: '街上站着三位约 1.72m 高的人像主体，分别在 3.4m、6.2m、9.2m 处，对应 24–135mm、50–200mm、85–200mm 的取景；点击面部即可合焦。',
  lens: '镜头',
  body: '机身',
  aperture: '光圈',
  shutter: '快门',
  focal: '焦距',
  focus: '对焦',
  whiteBalance: '白平衡',
  depthOfField: '景深',
  hyperfocal: '超焦距',
  blades: '叶片',
  equivalentShort: '等效',
  lightPath: '光路',
  equivalentFocal: '等效焦距',
  imageDistance: '像距',
  entrancePupil: '入瞳直径',
  exitPupil: '出瞳直径',
  pupilMagnification: '瞳孔倍率',
  airyRadius: '艾里半径',
  diagonalFov: '对角视角',
  resolution: '分辨率',
  pixelPitch: '像素间距',
  totalPixels: '总像素',
  fullWell: '满阱',
  readNoise: '读出噪声',
  quantumEfficiency: '量子效率',
  dynamicRange: '动态范围',
  coc: '弥散圆 @4m',
  isoGain: 'ISO 增益',
  singleFrameWell: '单帧满阱',
  lookLeft: '← 左看',
  frontView: '正前方',
  lookRight: '右看 →',
  peepField: '窥视视场',
  recenter: '回到中心',
  distortionGrid: '畸变网格',
  lockSubject: '主体锁定',
  cmosNoise: 'CMOS 噪声',
  bayerArray: '拜耳阵列',
  pixelPeep: '像素窥视',
  resetRig: '复位机位',
  viewfinder: '取景器',
  shots: '已拍',
  metering: '测光',
  meterEvaluative: '评价',
  meterCentre: '中央重点',
  meterPartial: '局部',
  meterSpot: '点测',
  meteredEv: '实测 EV',
  character: '人物模型',
  characterFallback: '程序化人形',
  vehicle: '车辆模型',
  vehicleFallback: '方块车',
  afSearching: '对焦中…',
  afLocked: '已合焦',
  afFailed: '未合焦',
  photoPreview: '照片预览',
  shotPreviewAlt: '刚拍摄的相片预览',
  backToViewfinder: '返回取景',
  savePhoto: '保存照片',
  collapsePanel: '收起参数面板',
  expandPanel: '展开参数面板',
  switchTo: 'EN'
};

const en = {
  documentTitle: 'Lens Sim · WebGL Camera Simulator',
  tagline: 'MODULAR OPTICAL SIMULATOR',
  appTitle: 'Camera Lab',
  helpA: 'Click any object in the frame to focus on it (ray-picked against real geometry), drag to change the viewing direction and scroll to zoom. Av/Tv link the exposure automatically, while M mode lets you watch over- and under-exposure.',
  helpB: 'Focal length and sensor size map straight onto the perspective camera FOV, and depth of field is solved per pixel from the depth buffer and the paraxial light path (exit pupil, image distance) — out-of-focus areas are genuine geometric bokeh. Switching on Pixel peep renders the frame at true photosensitive-site granularity, revealing the Bayer array and photon shot noise; dragging then pans the sampling window.', helpC: 'Three 1.72 m standing subjects line the street at 3.4 m, 6.2 m and 9.2 m, framed by 24–135 mm, 50–200 mm and 85–200 mm respectively. Click a face to focus on it.',
  lens: 'Lens',
  body: 'Body',
  aperture: 'Aperture',
  shutter: 'Shutter',
  focal: 'Focal',
  focus: 'Focus',
  whiteBalance: 'WB',
  depthOfField: 'DoF',
  hyperfocal: 'Hyperfocal',
  blades: 'blades',
  equivalentShort: 'Eq.',
  lightPath: 'Light path',
  equivalentFocal: 'Equivalent focal',
  imageDistance: 'Image distance',
  entrancePupil: 'Entrance pupil',
  exitPupil: 'Exit pupil',
  pupilMagnification: 'Pupil mag.',
  airyRadius: 'Airy radius',
  diagonalFov: 'Diagonal FoV',
  resolution: 'Resolution',
  pixelPitch: 'Pixel pitch',
  totalPixels: 'Total pixels',
  fullWell: 'Full well',
  readNoise: 'Read noise',
  quantumEfficiency: 'Quantum eff.',
  dynamicRange: 'Dynamic range',
  coc: 'CoC @4m',
  isoGain: 'ISO gain',
  singleFrameWell: '1-frame well',
  lookLeft: '← Look left',
  frontView: 'Straight ahead',
  lookRight: 'Look right →',
  peepField: 'Peep field',
  recenter: 'Recenter',
  distortionGrid: 'Grid',
  lockSubject: 'Lock',
  cmosNoise: 'Noise',
  bayerArray: 'Bayer',
  pixelPeep: 'Peep',
  resetRig: 'Reset',
  viewfinder: 'EVF',
  shots: 'Shots',
  metering: 'Meter',
  meterEvaluative: 'Evaluative',
  meterCentre: 'Centre',
  meterPartial: 'Partial',
  meterSpot: 'Spot',
  meteredEv: 'Metered EV',
  character: 'Character',
  characterFallback: 'procedural',
  vehicle: 'Vehicle',
  vehicleFallback: 'box car',
  afSearching: 'Focusing…',
  afLocked: 'Focused',
  afFailed: 'No focus',
  photoPreview: 'Photo preview',
  shotPreviewAlt: 'Preview of the shot just taken',
  backToViewfinder: 'Back to viewfinder',
  savePhoto: 'Save photo',
  collapsePanel: 'Collapse settings',
  expandPanel: 'Expand settings',
  switchTo: '中文'
};

const dictionaries = { zh, en };

// Longer labels that would not fit the compact tool row are exposed as tooltips.
const hints = {
  zh: { distortionGrid: '畸变网格', lockSubject: '主体锁定', cmosNoise: 'CMOS 噪声', bayerArray: '拜耳阵列', pixelPeep: '像素窥视', resetRig: '复位机位', viewfinder: '虚拟取景器预览：3:2 目镜框 + 曝光标尺 + 拍摄参数' },
  en: { distortionGrid: 'Distortion grid', lockSubject: 'Lock subject', cmosNoise: 'CMOS noise', bayerArray: 'Bayer array', pixelPeep: 'Pixel peep', resetRig: 'Reset rig', viewfinder: 'Virtual viewfinder preview: 3:2 eyepiece, exposure scale and shooting data' }
};

const lensDesigns = {
  zh: { rf50: '标准双高斯', ef70200: '内对焦远摄', ef1635: '反望远广角', z85: '大口径远摄', fe2470: '反望远变焦' },
  en: { rf50: 'Double Gauss', ef70200: 'IF telephoto', ef1635: 'Retrofocus wide', z85: 'Fast telephoto', fe2470: 'Retrofocus zoom' }
};

const bodyNames = {
  zh: { r62: 'Canon EOS R6 Mark II · 全画幅', '5d4': 'Canon EOS 5D Mark IV · 全画幅', '90d': 'Canon EOS 90D · APS-C' },
  en: { r62: 'Canon EOS R6 Mark II · Full Frame', '5d4': 'Canon EOS 5D Mark IV · Full Frame', '90d': 'Canon EOS 90D · APS-C' }
};

function storedLocale() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export const locale = ref(storedLocale() === 'zh' ? 'zh' : 'en');

export function setLocale(value) {
  locale.value = value === 'zh' ? 'zh' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, locale.value);
  } catch {
    // Private browsing modes can reject storage writes; the in-memory ref still works.
  }
}

export function toggleLocale() {
  setLocale(locale.value === 'zh' ? 'en' : 'zh');
}

export function t(key) {
  return dictionaries[locale.value][key] ?? en[key] ?? key;
}

export function hint(key) {
  return hints[locale.value][key] ?? key;
}

export function lensDesign(lens) {
  return lensDesigns[locale.value][lens.id] ?? lens.design;
}

export function bodyName(body) {
  return bodyNames[locale.value][body.id] ?? body.name;
}

export const htmlLang = computed(() => (locale.value === 'zh' ? 'zh-CN' : 'en'));
