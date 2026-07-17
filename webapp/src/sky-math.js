import {
  Observer,
  Spherical,
  VectorFromSphere,
  Rotation_EQJ_HOR,
  RotateVector,
  HorizonFromVector,
} from 'astronomy-engine';

// True Alt/Az of a J2000 catalog star, for an observer at a given place/time.
// Handles precession/nutation/sidereal time via astronomy-engine's rotation
// matrices rather than hand-rolled trig.
export function starAltAz(star, date, latitude, longitude) {
  const observer = new Observer(latitude, longitude, 0);
  const equatorialJ2000 = new Spherical(star.dec, star.ra * 15, 1);
  const vecEqj = VectorFromSphere(equatorialJ2000, date);
  const rotation = Rotation_EQJ_HOR(date, observer);
  const vecHor = RotateVector(rotation, vecEqj);
  const horizontal = HorizonFromVector(vecHor, 'normal');
  return { altitude: horizontal.lat, azimuth: horizontal.lon };
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Alt/Az (degrees, azimuth clockwise from north) -> unit vector.
// x = north, y = east, z = up. Convention only needs to be self-consistent
// with unitToAltAz below.
export function altAzToUnit(altitudeDeg, azimuthDeg) {
  const alt = altitudeDeg * DEG2RAD;
  const az = azimuthDeg * DEG2RAD;
  const cosAlt = Math.cos(alt);
  return [cosAlt * Math.cos(az), cosAlt * Math.sin(az), Math.sin(alt)];
}

export function unitToAltAz([x, y, z]) {
  const altitude = Math.asin(Math.max(-1, Math.min(1, z))) * RAD2DEG;
  let azimuth = Math.atan2(y, x) * RAD2DEG;
  if (azimuth < 0) {
    azimuth += 360;
  }
  return { altitude, azimuth };
}
