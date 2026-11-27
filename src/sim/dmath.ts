/**
 * Deterministic math for the simulation.
 *
 * Online play runs the same sim on two machines (rollback netcode), so every
 * tick must produce bit-identical results in Chrome, Firefox and Safari.
 * +, -, *, / and Math.sqrt are exactly rounded by IEEE 754 everywhere, but
 * Math.sin / cos / atan2 / hypot are approximations that differ between
 * engines. These replacements use only the exact operations.
 */

const PIO2_HI = 1.5707963267341256; // pi/2 split in two for accurate range reduction
const PIO2_LO = 6.077100506506192e-11;
const PI = 3.141592653589793;
const PIO2 = 1.5707963267948966;

function sinPoly(r: number): number {
  // Taylor series on |r| <= pi/4, error below 1e-16.
  const r2 = r * r;
  return r * (1 + r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800
    + r2 * (1 / 6227020800 + r2 * (-1 / 1307674368000))))))));
}

function cosPoly(r: number): number {
  const r2 = r * r;
  return 1 + r2 * (-1 / 2 + r2 * (1 / 24 + r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800
    + r2 * (1 / 479001600 + r2 * (-1 / 87178291200 + r2 * (1 / 20922789888000))))))));
}

function reduce(x: number): { r: number; q: number } {
  const k = Math.round(x / PIO2);
  const r = (x - k * PIO2_HI) - k * PIO2_LO;
  return { r, q: ((k % 4) + 4) % 4 };
}

export function dsin(x: number): number {
  const { r, q } = reduce(x);
  switch (q) {
    case 0: return sinPoly(r);
    case 1: return cosPoly(r);
    case 2: return -sinPoly(r);
    default: return -cosPoly(r);
  }
}

export function dcos(x: number): number {
  const { r, q } = reduce(x);
  switch (q) {
    case 0: return cosPoly(r);
    case 1: return -sinPoly(r);
    case 2: return -cosPoly(r);
    default: return sinPoly(r);
  }
}

const TAN_PI_12 = 0.2679491924311227;
const SQRT3 = 1.7320508075688772;

/** atan for x >= 0. */
function atanPos(x: number): number {
  let offset = 0;
  let inv = false;
  if (x > 1) { x = 1 / x; inv = true; }
  if (x > TAN_PI_12) { x = (x * SQRT3 - 1) / (x + SQRT3); offset = PI / 6; }
  // Series on |x| <= tan(pi/12): x - x^3/3 + x^5/5 - ...
  const x2 = x * x;
  let sum = 0;
  for (let n = 15; n >= 0; n--) sum = (n % 2 === 0 ? 1 : -1) / (2 * n + 1) + x2 * sum;
  const a = offset + x * sum;
  return inv ? PIO2 - a : a;
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? PIO2 : -PIO2;
  const a = atanPos(Math.abs(y / x));
  if (x > 0) return y >= 0 ? a : -a;
  return y >= 0 ? PI - a : -(PI - a);
}

export const dhypot = (x: number, y: number) => Math.sqrt(x * x + y * y);
