// ---------------------------------------------------------------------------
// Sequential paraxial ray tracer with finite apertures.
//
// A spec sheet gives the focal length, the f-number, the pupil magnification and
// the mechanical envelope; it never gives the prescription. Where the pupils sit
// and which rim trims an oblique beam are nevertheless properties of a
// prescription, so this module knows how to carry one: a short sequence of thin
// surfaces, each with a real semi-diameter, traced with the usual ray transfer
// algebra. Everything the light path needs is then *read out of the trace*
// instead of assumed — the aperture stop, the pupil positions and diameters, the
// field angle, and how much of an off-axis beam each rim removes.
//
// Conventions, all lengths in millimetres, z growing towards the sensor:
//   a ray is [y, u] with u = dy/dz, and a matrix [A,B,C,D] maps
//   y' = A·y + B·u, u' = C·y + D·u. In this convention the reverse of a system
//   is simply its inverse matrix, which is what lets the same primitives trace
//   from the image side (the chief ray) as easily as from the object side.
// ---------------------------------------------------------------------------

export const IDENTITY = [1, 0, 0, 1];

export const freeSpace = distance => [1, distance, 0, 1];

export function refraction(indexIn, indexOut, radius) {
  if (!Number.isFinite(radius) || radius === 0) return [1, 0, 0, indexIn / indexOut];
  return [1, 0, (indexIn - indexOut) / (indexOut * radius), indexIn / indexOut];
}

export const thinLens = focal => [1, 0, -1 / focal, 1];

export function multiply(after, before) {
  return [
    after[0] * before[0] + after[1] * before[2], after[0] * before[1] + after[1] * before[3],
    after[2] * before[0] + after[3] * before[2], after[2] * before[1] + after[3] * before[3]
  ];
}

export function inverse([A, B, C, D]) {
  const determinant = A * D - B * C;
  return [D / determinant, -B / determinant, -C / determinant, A / determinant];
}

export function cardinalPoints(matrix) {
  const [A, B, C, D] = matrix;
  return { efl: -1 / C, bfd: -A / C, ffd: D / C, matrix };
}

// ---------------------------------------------------------------------------
// A system is a list of surfaces { focal, semiDiameter, gap }, where `gap` is
// the distance to the next surface. The last surface carries no gap: the image
// plane moves with focus, so it is passed to the routines below instead of being
// baked into the matrix.
// ---------------------------------------------------------------------------
function stepOf(surface) {
  const lens = surface.focal ? thinLens(surface.focal) : IDENTITY;
  return surface.gap ? multiply(freeSpace(surface.gap), lens) : lens;
}

export function compose(surfaces) {
  const count = surfaces.length;
  const planes = new Array(count);
  let matrix = IDENTITY;
  for (let i = 0; i < count; i++) {
    planes[i] = matrix;                                  // plane of this surface
    const surface = surfaces[i];
    if (surface.focal) matrix = multiply(thinLens(surface.focal), matrix);
    if (surface.gap && i < count - 1) matrix = multiply(freeSpace(surface.gap), matrix);
  }
  const rest = new Array(count);                         // plane i -> last plane
  let suffix = IDENTITY;
  for (let i = count - 1; i >= 0; i--) {
    rest[i] = suffix;
    if (i > 0) suffix = multiply(suffix, stepOf(surfaces[i - 1]));
  }
  return { planes, rest, end: matrix };
}

// ---------------------------------------------------------------------------
// Pupils. The entry pupil is the image of the stop formed by the surfaces in
// front of it, the exit pupil the image formed by the surfaces behind it. Both
// fall out of the sub-system matrices: a point at the stop plane is imaged where
// the transfer matrix has a zero B element, and the magnification that goes with
// it is 1/A going forward, 1/D coming back — the usual ray transfer identities.
//
// `entrance.at` is measured from the first surface (negative = in front of the
// lens) and `exit.at` from the last surface.
// ---------------------------------------------------------------------------
export function pupilGeometry(surfaces, stopIndex) {
  const { planes, end } = compose(surfaces);
  const front = planes[stopIndex];
  const behind = multiply(end, inverse(front));
  return {
    entrance: { at: front[1] / front[0], magnification: 1 / front[0] },
    exit: { at: -behind[1] / behind[3], magnification: 1 / behind[3] }
  };
}

// Image distance for an axial object `objectDistance` in front of the first
// surface, obtained by tracing a real ray instead of applying the thin lens
// equation: a thick system has no single plane to measure from.
export function imageDistanceFromRearVertex(surfaces, objectDistance) {
  const [A, B, C, D] = compose(surfaces).end;
  const y = A * objectDistance + B;
  const u = C * objectDistance + D;
  return -y / u;
}

// A ray defined at the image plane, sampled at every surface. Expressing the
// chief ray (through the centre of the stop) and the marginal ray (through the
// edge of the exit pupil) this way keeps the vignetting geometry in one frame.
export function traceBack(surfaces, imageDistance, rayAtImage) {
  const { rest } = compose(surfaces);
  return rest.map((matrix) => {
    const [A, B, C, D] = inverse(multiply(freeSpace(imageDistance), matrix));
    return { y: A * rayAtImage[0] + B * rayAtImage[1], u: C * rayAtImage[0] + D * rayAtImage[1] };
  });
}

// ---------------------------------------------------------------------------
// Transmission through a set of circular apertures.
//
// Seen from the stop plane, an aperture of semi-diameter `semiDiameter` at some
// other surface maps to the disc |scale·p + shift| <= semiDiameter, because the
// height of a ray at that surface is affine in its height at the stop. Every
// aperture therefore crops the stop into a disc, and the light that reaches the
// sensor is the area common to all of them — the cat's eye shape an off-axis
// beam really has. Sampling a uniform-area polar grid keeps the weights equal.
// ---------------------------------------------------------------------------
export function apertureTransmission(stopRadius, clips, radiusSteps = 12, angleSteps = 24) {
  let open = 0;
  let total = 0;
  for (let r = 0; r < radiusSteps; r++) {
    const radius = stopRadius * Math.sqrt((r + 0.5) / radiusSteps);
    for (let a = 0; a < angleSteps; a++) {
      const angle = (a + 0.5) / angleSteps * Math.PI * 2;
      const x = radius * Math.cos(angle);
      const y = radius * Math.sin(angle);
      total++;
      let clear = true;
      for (const clip of clips) {
        const dx = clip.scale * x + clip.shift;
        const dy = clip.scale * y;
        if (dx * dx + dy * dy > clip.semiDiameter * clip.semiDiameter) { clear = false; break; }
      }
      if (clear) open++;
    }
  }
  return total ? open / total : 1;
}

// Least-squares fit of c0 + c1·x + … + cn·xⁿ. Falloff curves are even in the
// field radius, so the caller passes x = (h/hmax)² and the odd powers stay out
// of the basis. The coefficients are returned packed as the shader evaluates
// them, low order first.
export function fitPolynomial(samples, degree = 4) {
  const size = degree + 1;
  const rows = Array.from({ length: size }, () => new Array(size + 1).fill(0));
  for (const [x, value] of samples) {
    const basis = [];
    let power = 1;
    for (let i = 0; i < size; i++) { basis.push(power); power *= x; }
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) rows[i][j] += basis[i] * basis[j];
      rows[i][size] += basis[i] * value;
    }
  }
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const lead = rows[col][col] || 1;
    for (let k = col; k <= size; k++) rows[col][k] /= lead;
    for (let row = 0; row < size; row++) {
      if (row === col) continue;
      const factor = rows[row][col];
      if (!factor) continue;
      for (let k = col; k <= size; k++) rows[row][k] -= factor * rows[col][k];
    }
  }
  return rows.map(row => row[size]);
}
