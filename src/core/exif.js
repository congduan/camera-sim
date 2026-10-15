// EXIF 2.32 writing.
//
// A browser can only ever produce a bare JPEG: canvas.toBlob() has no channel
// for metadata, so the APP1 segment has to be built by hand and spliced in right
// behind the SOI marker, which is where the specification requires it.
//
// The TIFF block is laid out little endian with both directories in front and an
// overflow area behind them, so a value longer than four bytes can never
// overwrite a directory that points at it.

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const UNDEFINED = 7;
const SRATIONAL = 10;

// Tags used below, named so the entry lists read like the specification.
const TAG = {
  Make: 0x010F, Model: 0x0110, Orientation: 0x0112, XResolution: 0x011A,
  YResolution: 0x011B, ResolutionUnit: 0x0128, Software: 0x0131, DateTime: 0x0132,
  ImageDescription: 0x010E, ExifIfd: 0x8769,
  ExposureTime: 0x829A, FNumber: 0x829D, ExposureProgram: 0x8822, IsoSpeed: 0x8827,
  ExifVersion: 0x9000, DateTimeOriginal: 0x9003, DateTimeDigitized: 0x9004,
  ComponentsConfiguration: 0x9101, ShutterSpeedValue: 0x9201, ApertureValue: 0x9202,
  ExposureBiasValue: 0x9204, MeteringMode: 0x9207, Flash: 0x9209, FocalLength: 0x920A,
  UserComment: 0x9286, ColorSpace: 0xA001, PixelXDimension: 0xA002, PixelYDimension: 0xA003,
  ExposureMode: 0xA402, WhiteBalance: 0xA403, FocalLength35: 0xA405, SceneCaptureType: 0xA406,
  SubjectDistance: 0xA40C, LensSpecification: 0xA432, LensMake: 0xA433, LensModel: 0xA434
};

// EXIF strings are 7 bit. Lens and body names are ASCII already, but the summary
// lines carry units and separators that are not, so fold them down rather than
// emitting bytes a reader would choke on.
const SUBSTITUTES = { '·': '-', '×': 'x', 'µ': 'u', '°': 'deg', '\u2014': '-', '\u2013': '-', '\u221e': 'inf' };

export function toAscii(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, (character) => SUBSTITUTES[character] ?? '?');
}

function asciiBytes(text) {
  const clean = toAscii(text);
  const bytes = new Uint8Array(clean.length + 1);
  for (let i = 0; i < clean.length; i++) bytes[i] = clean.charCodeAt(i);
  return bytes;
}

function shortBytes(values) {
  const view = new DataView(new ArrayBuffer(2 * values.length));
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return new Uint8Array(view.buffer);
}

function longBytes(values) {
  const view = new DataView(new ArrayBuffer(4 * values.length));
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return new Uint8Array(view.buffer);
}

function rationalBytes(pairs, signed) {
  const view = new DataView(new ArrayBuffer(8 * pairs.length));
  pairs.forEach(([numerator, denominator], index) => {
    const at = index * 8;
    if (signed) { view.setInt32(at, numerator, true); view.setInt32(at + 4, denominator, true); }
    else { view.setUint32(at, numerator >>> 0, true); view.setUint32(at + 4, denominator >>> 0, true); }
  });
  return new Uint8Array(view.buffer);
}

// Exposure time is stored as a fraction: a whole number of seconds over one below
// a second, and one over the reciprocal above it, which is how a camera writes it.
function exposurePair(seconds) {
  return seconds >= 1 ? [Math.round(seconds), 1] : [1, Math.round(1 / seconds)];
}

function pad(day) { return String(day).padStart(2, '0'); }

function exifDate(date) {
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function entry(tag, type, count, bytes) { return { tag, type, count, bytes }; }

/**
 * Builds the whole APP1 segment for a shot.
 *
 * @param {object} meta - Shot metadata, all lengths already in EXIF units.
 * @return {Uint8Array} The segment, including its marker and length field.
 */
export function buildExifApp1(meta) {
  const date = exifDate(meta.date ?? new Date());

  const ifd0 = [
    entry(TAG.ImageDescription, ASCII, 0, asciiBytes(meta.description ?? '')),
    entry(TAG.Make, ASCII, 0, asciiBytes(meta.make ?? '')),
    entry(TAG.Model, ASCII, 0, asciiBytes(meta.model ?? '')),
    entry(TAG.Orientation, SHORT, 1, shortBytes([1])),
    entry(TAG.XResolution, RATIONAL, 1, rationalBytes([[72, 1]])),
    entry(TAG.YResolution, RATIONAL, 1, rationalBytes([[72, 1]])),
    entry(TAG.ResolutionUnit, SHORT, 1, shortBytes([2])),
    entry(TAG.Software, ASCII, 0, asciiBytes(meta.software ?? 'Lens Sim')),
    entry(TAG.DateTime, ASCII, 0, asciiBytes(date)),
    { tag: TAG.ExifIfd, type: LONG, count: 1, pointer: true }
  ];

  const comment = asciiBytes(meta.comment ?? '');
  const userComment = new Uint8Array(8 + comment.length);
  userComment.set([0x41, 0x53, 0x43, 0x49, 0x49, 0x00, 0x00, 0x00], 0);   // "ASCII\0\0\0"
  userComment.set(comment, 8);

  const subIfd = [
    entry(TAG.ExposureTime, RATIONAL, 1, rationalBytes([exposurePair(meta.exposureTime ?? 1)])),
    entry(TAG.FNumber, RATIONAL, 1, rationalBytes([[Math.round((meta.fNumber ?? 1) * 100), 100]])),
    entry(TAG.ExposureProgram, SHORT, 1, shortBytes([meta.exposureProgram ?? 0])),
    entry(TAG.IsoSpeed, SHORT, 1, shortBytes([meta.iso ?? 100])),
    entry(TAG.ExifVersion, UNDEFINED, 4, new Uint8Array([0x30, 0x32, 0x33, 0x32])),
    entry(TAG.DateTimeOriginal, ASCII, 0, asciiBytes(date)),
    entry(TAG.DateTimeDigitized, ASCII, 0, asciiBytes(date)),
    entry(TAG.ComponentsConfiguration, UNDEFINED, 4, new Uint8Array([1, 2, 3, 0])),
    entry(TAG.ShutterSpeedValue, SRATIONAL, 1, rationalBytes([[-Math.round(Math.log2(meta.exposureTime ?? 1) * 100), 100]], true)),
    entry(TAG.ApertureValue, RATIONAL, 1, rationalBytes([[Math.round(2 * Math.log2(meta.fNumber ?? 1) * 100), 100]])),
    entry(TAG.ExposureBiasValue, SRATIONAL, 1, rationalBytes([[Math.round((meta.exposureBias ?? 0) * 100), 100]], true)),
    entry(TAG.MeteringMode, SHORT, 1, shortBytes([meta.meteringMode ?? 0])),
    entry(TAG.Flash, SHORT, 1, shortBytes([0])),
    entry(TAG.FocalLength, RATIONAL, 1, rationalBytes([[Math.round((meta.focalLength ?? 50) * 100), 100]])),
    entry(TAG.UserComment, UNDEFINED, userComment.length, userComment),
    entry(TAG.ColorSpace, SHORT, 1, shortBytes([1])),
    entry(TAG.PixelXDimension, LONG, 1, longBytes([meta.width ?? 0])),
    entry(TAG.PixelYDimension, LONG, 1, longBytes([meta.height ?? 0])),
    entry(TAG.ExposureMode, SHORT, 1, shortBytes([meta.exposureMode ?? 0])),
    entry(TAG.WhiteBalance, SHORT, 1, shortBytes([meta.whiteBalance ?? 0])),
    entry(TAG.FocalLength35, SHORT, 1, shortBytes([Math.round(meta.focalLength35 ?? 0)])),
    entry(TAG.SceneCaptureType, SHORT, 1, shortBytes([0])),
    entry(TAG.SubjectDistance, RATIONAL, 1, rationalBytes([[Math.round((meta.subjectDistance ?? 0) * 100), 100]])),
    entry(TAG.LensSpecification, RATIONAL, 4, rationalBytes((meta.lensSpec ?? [0, 0, 0, 0]).map((value) => [Math.round(value * 100), 100]))),
    entry(TAG.LensMake, ASCII, 0, asciiBytes(meta.lensMake ?? '')),
    entry(TAG.LensModel, ASCII, 0, asciiBytes(meta.lensModel ?? ''))
  ];

  // A directory entry stores its value inline when it fits in four bytes, so the
  // byte count decides both the count field and the overflow area.
  const finalise = (list) => list.map((item) => {
    if (item.pointer) return item;
    const count = item.type === ASCII ? item.bytes.length : item.count;
    return { ...item, count };
  });
  const directory = finalise(ifd0);
  const sub = finalise(subIfd);

  const ifd0Base = 8;
  const ifd0Size = 2 + directory.length * 12 + 4;
  const subBase = ifd0Base + ifd0Size;
  const subSize = 2 + sub.length * 12 + 4;
  let overflow = subBase + subSize;

  const overflowSize = [...directory, ...sub]
    .filter((item) => !item.pointer && item.bytes.length > 4)
    .reduce((total, item) => total + item.bytes.length + (item.bytes.length % 2), 0);

  const tiff = new Uint8Array(overflow + overflowSize);
  const view = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49;          // "II", little endian
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd0Base, true);

  const writeDirectory = (list, base) => {
    view.setUint16(base, list.length, true);
    let at = base + 2;
    for (const item of list) {
      view.setUint16(at, item.tag, true);
      view.setUint16(at + 2, item.type, true);
      view.setUint32(at + 4, item.count, true);
      if (item.pointer) {
        view.setUint32(at + 8, subBase, true);       // patched once the sub IFD is placed
      } else if (item.bytes.length > 4) {
        view.setUint32(at + 8, overflow, true);
        tiff.set(item.bytes, overflow);
        overflow += item.bytes.length + (item.bytes.length % 2);
      } else {
        tiff.set(item.bytes, at + 8);
      }
      at += 12;
    }
    view.setUint32(at, 0, true);                     // no next directory
  };

  writeDirectory(directory, ifd0Base);
  writeDirectory(sub, subBase);

  const payloadLength = overflow;
  const app1 = new Uint8Array(4 + 6 + payloadLength);
  app1[0] = 0xFF; app1[1] = 0xE1;                    // APP1 marker, not counted
  // The length counts the two length bytes themselves plus the "Exif\0\0"
  // identifier and the TIFF block. Getting this two bytes short leaves a reader
  // that trusts it hunting for a marker inside the metadata.
  const segmentLength = 2 + 6 + payloadLength;
  app1[2] = (segmentLength >> 8) & 0xFF;             // big endian
  app1[3] = segmentLength & 0xFF;
  app1.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // "Exif\0\0"
  app1.set(tiff.subarray(0, payloadLength), 10);
  return app1;
}

/**
 * Splices the EXIF segment into a JPEG, directly behind its SOI marker.
 *
 * @param {Blob} jpegBlob - Pixels already encoded as JPEG.
 * @param {object} meta - Shot metadata for {@link buildExifApp1}.
 * @return {Promise<Blob>} A JPEG blob carrying the metadata.
 */
export async function withExif(jpegBlob, meta) {
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
  if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) throw new Error('Not a JPEG');
  const app1 = buildExifApp1(meta);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);                   // SOI
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return new Blob([out], { type: 'image/jpeg' });
}
