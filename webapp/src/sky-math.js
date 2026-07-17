import {
  Observer,
  Spherical,
  VectorFromSphere,
  Rotation_EQJ_HOR,
  RotateVector,
  HorizonFromVector,
} from 'astronomy-engine';

// Builds a reusable RA/Dec -> Alt/Az projector for a fixed date/location.
// The EQJ->HOR rotation matrix only depends on date+observer, not on the
// object being projected, so computing it once and reusing it is much
// cheaper than rebuilding it per-star when projecting hundreds of
// constellation-line points in a single render pass.
export function makeHorizonProjector(date, latitude, longitude) {
  const observer = new Observer(latitude, longitude, 0);
  const rotation = Rotation_EQJ_HOR(date, observer);
  return (raHours, decDeg) => {
    const vecEqj = VectorFromSphere(new Spherical(decDeg, raHours * 15, 1), date);
    const vecHor = RotateVector(rotation, vecEqj);
    const horizontal = HorizonFromVector(vecHor, 'normal');
    return { altitude: horizontal.lat, azimuth: horizontal.lon };
  };
}

// True Alt/Az of a single J2000 catalog object, for an observer at a given
// place/time. Handles precession/nutation/sidereal time via
// astronomy-engine's rotation matrices rather than hand-rolled trig.
export function starAltAz(star, date, latitude, longitude) {
  return makeHorizonProjector(date, latitude, longitude)(star.ra, star.dec);
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
