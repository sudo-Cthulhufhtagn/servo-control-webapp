import { altAzToUnit, unitToAltAz } from './sky-math.js';

// Maps the mount's own servo angles (servo1 = yaw 0-180°, servo2 = pitch
// 0-180°, centered at 90°) to a unit vector in the mount's local frame. The
// mapping's "meaning" doesn't matter (it isn't necessarily true
// azimuth/altitude) — it only needs to be a consistent, invertible
// parameterization of the two servo axes. Whatever tilt/rotation offset
// exists between this local frame and the true sky frame is exactly what
// the 3-point alignment solve below recovers.
export function servoToLocalUnit(servo1, servo2) {
  return altAzToUnit(servo2 - 90, servo1);
}

export function localUnitToServo(vec) {
  const { altitude, azimuth } = unitToAltAz(vec);
  const servo1 = azimuth;
  const servo2 = altitude + 90;
  const inRange = servo1 >= 0 && servo1 <= 180 && servo2 >= 0 && servo2 <= 180;
  return {
    servo1: Math.max(0, Math.min(180, Math.round(servo1))),
    servo2: Math.max(0, Math.min(180, Math.round(servo2))),
    inRange,
  };
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function matVecMul4(m, v) {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2] + row[3] * v[3]);
}

function norm4(v) {
  return Math.hypot(v[0], v[1], v[2], v[3]);
}

// Dominant eigenvector of a symmetric 4x4 matrix via shifted power iteration.
// The shift guarantees every shifted eigenvalue is positive, so "largest
// magnitude" (what plain power iteration converges to) is also "largest
// value" — which is the eigenvector Davenport's q-method needs.
function dominantEigenvector4(k) {
  const shift = 10;
  const shifted = k.map((row, i) => row.map((value, j) => value + (i === j ? shift : 0)));

  let v = [0, 0, 0, 1];
  for (let iter = 0; iter < 200; iter += 1) {
    const next = matVecMul4(shifted, v);
    const length = norm4(next);
    v = next.map((x) => x / length);
  }
  return v;
}

// Solves Wahba's problem: the least-squares rotation matrix R such that
// R * local_i ≈ true_i for a set of unit-vector pairs, via Davenport's
// q-method. Three (or more) points make this a robust least-squares fit
// rather than an exact two-vector solve, which matters here because each
// calibration point carries human aiming error and the mount's base tilt
// is unknown.
export function solveAlignment(points) {
  const pairs = points.map(({ servo1, servo2, altitude, azimuth }) => ({
    local: servoToLocalUnit(servo1, servo2),
    true: altAzToUnit(altitude, azimuth),
  }));

  const b = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  pairs.forEach(({ local, true: t }) => {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        b[i][j] += t[i] * local[j];
      }
    }
  });

  const sigma = b[0][0] + b[1][1] + b[2][2];
  const s = b.map((row, i) => row.map((value, j) => value + b[j][i]));
  const z = [b[1][2] - b[2][1], b[2][0] - b[0][2], b[0][1] - b[1][0]];

  const k = [
    [s[0][0] - sigma, s[0][1], s[0][2], z[0]],
    [s[1][0], s[1][1] - sigma, s[1][2], z[1]],
    [s[2][0], s[2][1], s[2][2] - sigma, z[2]],
    [z[0], z[1], z[2], sigma],
  ];

  const [q1, q2, q3, q4] = dominantEigenvector4(k);

  const matrix = [
    [q1 * q1 - q2 * q2 - q3 * q3 + q4 * q4, 2 * (q1 * q2 + q3 * q4), 2 * (q1 * q3 - q2 * q4)],
    [2 * (q1 * q2 - q3 * q4), -q1 * q1 + q2 * q2 - q3 * q3 + q4 * q4, 2 * (q2 * q3 + q1 * q4)],
    [2 * (q1 * q3 + q2 * q4), 2 * (q2 * q3 - q1 * q4), -q1 * q1 - q2 * q2 + q3 * q3 + q4 * q4],
  ];

  const residualsDeg = pairs.map(({ local, true: t }) => {
    const predicted = matVecMul3(matrix, local);
    const cos = Math.max(-1, Math.min(1, dot(predicted, t)));
    return (Math.acos(cos) * 180) / Math.PI;
  });

  return { matrix, residualsDeg, maxResidualDeg: Math.max(...residualsDeg) };
}

function matVecMul3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function transpose3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function localToTrue(matrix, localVec) {
  return matVecMul3(matrix, localVec);
}

export function trueToLocal(matrix, trueVec) {
  return matVecMul3(transpose3(matrix), trueVec);
}
