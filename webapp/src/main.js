import './style.css';
import { STARS } from './stars.js';
import { CONSTELLATIONS } from './constellations.js';
import { MESSIER } from './messier.js';
import { starAltAz, altAzToUnit, unitToAltAz, makeHorizonProjector } from './sky-math.js';
import {
  localUnitToServo,
  servoToLocalUnit,
  solveAlignment,
  trueToLocal,
  localToTrue,
} from './mount-align.js';

const CONSTELLATIONS_BY_ID = new Map(CONSTELLATIONS.map((c) => [c.id, c]));

function objectLabel(obj) {
  if (obj.kind === 'star' || obj.kind === 'constellation') {
    return obj.name;
  }
  return obj.name ? `${obj.id} (${obj.name})` : obj.id;
}

// Unique [ra, dec] vertices of a constellation's stick-figure lines, in
// first-occurrence order (shared vertices repeat verbatim across segments in
// the source data, so a simple string key dedupes them). Order roughly
// traces the figure's shape, which is what makes "slew around" look like a
// tour rather than a random jump between points.
function constellationVertices(constellation) {
  const seen = new Set();
  const vertices = [];
  constellation.lines.forEach((segment) => {
    segment.forEach(([ra, dec]) => {
      const key = `${ra},${dec}`;
      if (!seen.has(key)) {
        seen.add(key);
        vertices.push({ ra, dec });
      }
    });
  });
  return vertices;
}

// Reuses altAzToUnit/unitToAltAz (identical spherical math) by passing dec in
// place of altitude and ra-in-degrees in place of azimuth — these operate on
// fixed J2000 equatorial positions, not live alt/az.
function raDecToUnit(raHours, decDeg) {
  return altAzToUnit(decDeg, raHours * 15);
}

function unitToRaDec(vec) {
  const { altitude, azimuth } = unitToAltAz(vec);
  return { ra: azimuth / 15, dec: altitude };
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Fixed J2000 RA/Dec "center" of a constellation, from the mean unit vector
// of its stick-figure vertices — a fixed equatorial position, so it behaves
// exactly like a star's ra/dec for starAltAz() at goto time.
function constellationCentroid(constellation) {
  const vertices = constellationVertices(constellation);
  const sum = vertices.reduce(
    (acc, { ra, dec }) => {
      const [x, y, z] = raDecToUnit(ra, dec);
      return [acc[0] + x, acc[1] + y, acc[2] + z];
    },
    [0, 0, 0],
  );
  const length = Math.hypot(...sum);
  return unitToRaDec([sum[0] / length, sum[1] / length, sum[2] / length]);
}

// Pushes a vertex outward along the great circle from the constellation's
// centroid through that vertex, by an extra `extraDeg` of arc — so "slew
// around" traces a dilated border around the shape instead of landing
// exactly on each star (settings-controlled, default 1°).
function dilateRaDec(vertex, centroidUnit, extraDeg) {
  if (!extraDeg) {
    return vertex;
  }

  const vertexUnit = raDecToUnit(vertex.ra, vertex.dec);
  const cosOmega = Math.max(-1, Math.min(1, dot3(centroidUnit, vertexUnit)));
  const omega = Math.acos(cosOmega);
  if (omega < 1e-6) {
    return vertex;
  }

  const sinOmega = Math.sin(omega);
  const tangent = [0, 1, 2].map((i) => (vertexUnit[i] - cosOmega * centroidUnit[i]) / sinOmega);
  const theta = omega + extraDeg * DEG2RAD;
  const dilated = [0, 1, 2].map((i) => Math.cos(theta) * centroidUnit[i] + Math.sin(theta) * tangent[i]);
  return unitToRaDec(dilated);
}

const SERVICE_UUID = '6f94b030-1c3a-4c44-8f19-1f8b31d71f40';
const COMMAND_UUID = '6f94b031-1c3a-4c44-8f19-1f8b31d71f40';
const LOCATION_STORAGE_KEY = 'starmap:location';
const CALIBRATION_STORAGE_KEY = 'starmap:calibration';
const DEG2RAD = Math.PI / 180;
// Default location until the user sets their own (geolocation, manual entry,
// or a previously persisted choice) — Amsterdam.
const DEFAULT_LOCATION = { latitude: 52.3676, longitude: 4.9041 };

const state = {
  connected: false,
  device: null,
  characteristic: null,
  servo1: 90,
  servo2: 90,
  outputHigh: false,
  sweep1Active: false,
  sweep2Active: false,
  speedMs: 10,
  location: { ...DEFAULT_LOCATION },
  selectedObject: null,
  starmapOpen: false,
  showConstellations: true,
  showMessier: true,
  slewAroundDilationDeg: 1,
  calibrating: false,
  calibration: {
    points: [],
    matrix: null,
    residualsDeg: null,
    maxResidualDeg: null,
  },
};

const elements = {
  connectButton: document.getElementById('connectButton'),
  disconnectButton: document.getElementById('disconnectButton'),
  connectionPill: document.getElementById('connectionPill'),
  servo1Slider: document.getElementById('servo1Slider'),
  servo2Slider: document.getElementById('servo2Slider'),
  servo1Value: document.getElementById('servo1Value'),
  servo2Value: document.getElementById('servo2Value'),
  speedSlider: document.getElementById('speedSlider'),
  speedValue: document.getElementById('speedValue'),
  sweep1Button: document.getElementById('sweep1Button'),
  sweep2Button: document.getElementById('sweep2Button'),
  outputButton: document.getElementById('outputButton'),
  clearLogButton: document.getElementById('clearLogButton'),
  logList: document.getElementById('logList'),
  presetButtons: Array.from(document.querySelectorAll('.preset-button')),
  joystickButton: document.getElementById('joystickButton'),
  joystickOverlay: document.getElementById('joystickOverlay'),
  joystickCloseButton: document.getElementById('joystickCloseButton'),
  trackpadPad: document.getElementById('trackpadPad'),
  trackpadBall: document.getElementById('trackpadBall'),
  gyroButton: document.getElementById('gyroButton'),
  gyro2Button: document.getElementById('gyro2Button'),
  joystickOutputButton: document.getElementById('joystickOutputButton'),
  joystickServo1Value: document.getElementById('joystickServo1Value'),
  joystickServo2Value: document.getElementById('joystickServo2Value'),
  alignmentPill: document.getElementById('alignmentPill'),
  locateButton: document.getElementById('locateButton'),
  latInput: document.getElementById('latInput'),
  lonInput: document.getElementById('lonInput'),
  locationStatus: document.getElementById('locationStatus'),
  skyCanvas: document.getElementById('skyCanvas'),
  skyCanvasWrap: document.getElementById('skyCanvasWrap'),
  skyTooltip: document.getElementById('skyTooltip'),
  starmapServo1Value: document.getElementById('starmapServo1Value'),
  starmapServo2Value: document.getElementById('starmapServo2Value'),
  selectedStarInfo: document.getElementById('selectedStarInfo'),
  calibrateStartButton: document.getElementById('calibrateStartButton'),
  calibrateConfirmButton: document.getElementById('calibrateConfirmButton'),
  gotoButton: document.getElementById('gotoButton'),
  slewAroundButton: document.getElementById('slewAroundButton'),
  calibrationStepsList: document.getElementById('calibrationStepsList'),
  searchInput: document.getElementById('searchInput'),
  searchButton: document.getElementById('searchButton'),
  searchResults: document.getElementById('searchResults'),
  starmapButton: document.getElementById('starmapButton'),
  starmapOverlay: document.getElementById('starmapOverlay'),
  starmapCloseButton: document.getElementById('starmapCloseButton'),
  toggleConstellationsButton: document.getElementById('toggleConstellationsButton'),
  toggleMessierButton: document.getElementById('toggleMessierButton'),
  settingsButton: document.getElementById('settingsButton'),
  settingsOverlay: document.getElementById('settingsOverlay'),
  settingsCloseButton: document.getElementById('settingsCloseButton'),
  dilationSlider: document.getElementById('dilationSlider'),
  dilationValue: document.getElementById('dilationValue'),
  connectionWarningToast: document.getElementById('connectionWarningToast'),
  switchToStarmapButton: document.getElementById('switchToStarmapButton'),
  switchToJoystickButton: document.getElementById('switchToJoystickButton'),
};

const encoder = new TextEncoder();
let servo1Timer = null;
let servo2Timer = null;
let speedTimer = null;

const JOYSTICK_TICK_MS = 100;
const JOYSTICK_MAX_DEG_PER_TICK = 4;
const JOYSTICK_DEADZONE = 0.08;
const GYRO_MAX_DEG = 30;

let joystickTickTimer = null;
let joystickDx = 0;
let joystickDy = 0;
let pointerDragging = false;
let gyroActive = false;
let gyroCenter = null;
let gyro2Active = false;
let gyro2Center = null;
let targetServo1 = null;
let targetServo2 = null;
let padGeometry = null;

function log(message, tone = 'normal') {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  if (tone !== 'normal') {
    item.dataset.tone = tone;
  }
  elements.logList.prepend(item);
}

function render() {
  elements.servo1Value.textContent = `${state.servo1}°`;
  elements.servo2Value.textContent = `${state.servo2}°`;
  elements.speedValue.textContent = `${state.speedMs} ms`;
  elements.speedSlider.value = String(state.speedMs);
  elements.outputButton.textContent = state.outputHigh ? 'High' : 'Low';
  elements.outputButton.setAttribute('aria-pressed', String(state.outputHigh));
  elements.joystickOutputButton.textContent = state.outputHigh ? 'High' : 'Low';
  elements.joystickOutputButton.setAttribute('aria-pressed', String(state.outputHigh));
  elements.joystickOutputButton.classList.toggle('toggle-danger', state.outputHigh);
  elements.sweep1Button.textContent = state.sweep1Active ? 'Stop sweep 1' : 'Sweep servo 1';
  elements.sweep1Button.setAttribute('aria-pressed', String(state.sweep1Active));
  elements.sweep2Button.textContent = state.sweep2Active ? 'Stop sweep 2' : 'Sweep servo 2';
  elements.sweep2Button.setAttribute('aria-pressed', String(state.sweep2Active));
  elements.connectionPill.textContent = state.connected ? 'Connected' : 'Disconnected';
  elements.connectionPill.className = `pill ${state.connected ? 'pill-on' : 'pill-off'}`;
  elements.disconnectButton.disabled = !state.connected;
  // General controls stay usable without a connection (sendCommand just logs
  // "blocked" if actually clicked) — including the joystick itself now:
  // dragging it while disconnected just doesn't send anything. Only
  // calibration/goto stay gated on being connected, since a goto command
  // needs a device actually responding to be meaningful.
  elements.joystickServo1Value.textContent = `${state.servo1}°`;
  elements.joystickServo2Value.textContent = `${state.servo2}°`;
  elements.starmapServo1Value.textContent = `${state.servo1}°`;
  elements.starmapServo2Value.textContent = `${state.servo2}°`;
  updateCalibrationUI();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampAngle(value) {
  return clamp(Math.round(value), 0, 180);
}

let connectionWarningTimer = null;

function showConnectionWarning() {
  elements.connectionWarningToast.hidden = false;
  window.clearTimeout(connectionWarningTimer);
  connectionWarningTimer = window.setTimeout(() => {
    elements.connectionWarningToast.hidden = true;
  }, 2500);
}

async function sendCommandQuiet(command) {
  if (!state.characteristic) {
    showConnectionWarning();
    return;
  }
  try {
    await state.characteristic.writeValue(encoder.encode(`${command}\n`));
  } catch (error) {
    log(`joystick send failed: ${error.message}`, 'error');
  }
}

function setBallOffset(offsetX, offsetY) {
  elements.trackpadBall.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
}

function resetBallPosition() {
  setBallOffset(0, 0);
}

function applyVector(nx, ny) {
  const magnitude = Math.hypot(nx, ny);
  if (magnitude < JOYSTICK_DEADZONE) {
    joystickDx = 0;
    joystickDy = 0;
    return;
  }

  // Ease the response in from the deadzone edge instead of snapping straight to
  // full proportional speed — this smooths out the jump right past center and
  // gives finer low-speed control near it, while still reaching full speed at
  // full deflection.
  const normalized = Math.min(1, (magnitude - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE));
  const eased = normalized * normalized;
  const scale = eased / magnitude;

  joystickDx = clamp(-nx * scale, -1, 1);
  joystickDy = clamp(ny * scale, -1, 1);
}

function applyServoTargets(nextServo1, nextServo2) {
  const changed1 = nextServo1 !== state.servo1;
  const changed2 = nextServo2 !== state.servo2;

  if (!changed1 && !changed2) {
    return;
  }

  state.servo1 = nextServo1;
  state.servo2 = nextServo2;
  elements.servo1Slider.value = String(nextServo1);
  elements.servo2Slider.value = String(nextServo2);

  if (changed1 && changed2) {
    sendCommandQuiet(`servos:${nextServo1},${nextServo2}`);
  } else if (changed1) {
    sendCommandQuiet(`servo1:${nextServo1}`);
  } else {
    sendCommandQuiet(`servo2:${nextServo2}`);
  }

  render();
  if (state.starmapOpen) {
    renderSky();
  }
}

function joystickTick() {
  if (gyro2Active) {
    if (targetServo1 === null || targetServo2 === null) {
      return;
    }

    applyServoTargets(targetServo1, targetServo2);
    return;
  }

  if (joystickDx === 0 && joystickDy === 0) {
    return;
  }

  const nextServo1 = clampAngle(state.servo1 + joystickDx * JOYSTICK_MAX_DEG_PER_TICK);
  const nextServo2 = clampAngle(state.servo2 + joystickDy * JOYSTICK_MAX_DEG_PER_TICK);
  applyServoTargets(nextServo1, nextServo2);
}

function startJoystickLoop() {
  if (joystickTickTimer) {
    return;
  }
  log('joystick engaged');
  joystickTickTimer = window.setInterval(joystickTick, JOYSTICK_TICK_MS);
}

function stopJoystickLoop() {
  if (!joystickTickTimer) {
    return;
  }
  window.clearInterval(joystickTickTimer);
  joystickTickTimer = null;
  log(`joystick released — servo1: ${state.servo1}°, servo2: ${state.servo2}°`);
}

function getPadGeometry() {
  const padRect = elements.trackpadPad.getBoundingClientRect();
  const ballRect = elements.trackpadBall.getBoundingClientRect();
  const radius = padRect.width / 2;
  return {
    centerX: padRect.left + radius,
    centerY: padRect.top + radius,
    maxRadius: radius - ballRect.width / 2,
  };
}

function handlePointerDown(event) {
  if (gyroActive || gyro2Active) {
    return;
  }
  event.preventDefault();
  elements.trackpadPad.setPointerCapture(event.pointerId);
  padGeometry = getPadGeometry();
  pointerDragging = true;
  startJoystickLoop();
  handlePointerMove(event);
}

function handlePointerMove(event) {
  if (!pointerDragging || !padGeometry) {
    return;
  }

  const rawX = event.clientX - padGeometry.centerX;
  const rawY = event.clientY - padGeometry.centerY;
  const distance = Math.hypot(rawX, rawY);
  const clampedDistance = Math.min(distance, padGeometry.maxRadius);
  const angle = Math.atan2(rawY, rawX);
  const offsetX = distance === 0 ? 0 : Math.cos(angle) * clampedDistance;
  const offsetY = distance === 0 ? 0 : Math.sin(angle) * clampedDistance;
  setBallOffset(offsetX, offsetY);

  const nx = padGeometry.maxRadius === 0 ? 0 : offsetX / padGeometry.maxRadius;
  const ny = padGeometry.maxRadius === 0 ? 0 : -offsetY / padGeometry.maxRadius;
  applyVector(nx, ny);
}

function handlePointerUp() {
  if (!pointerDragging) {
    return;
  }
  pointerDragging = false;
  padGeometry = null;
  joystickDx = 0;
  joystickDy = 0;
  resetBallPosition();
  stopJoystickLoop();
}

function handleDeviceOrientation(event) {
  if (event.beta === null || event.gamma === null) {
    return;
  }

  if (gyro2Active) {
    handleGyro2Orientation(event);
    return;
  }

  if (!gyroActive) {
    return;
  }

  if (!gyroCenter) {
    gyroCenter = { beta: event.beta, gamma: event.gamma };
    return;
  }

  const dGamma = event.gamma - gyroCenter.gamma;
  const dBeta = event.beta - gyroCenter.beta;
  const nx = clamp(dGamma / GYRO_MAX_DEG, -1, 1);
  const ny = clamp(-dBeta / GYRO_MAX_DEG, -1, 1);

  if (padGeometry) {
    setBallOffset(nx * padGeometry.maxRadius, -ny * padGeometry.maxRadius);
  }
  applyVector(nx, ny);
}

function handleGyro2Orientation(event) {
  if (!gyro2Center) {
    gyro2Center = {
      beta: event.beta,
      gamma: event.gamma,
      servo1: state.servo1,
      servo2: state.servo2,
    };
    return;
  }

  const dGamma = event.gamma - gyro2Center.gamma;
  const dBeta = event.beta - gyro2Center.beta;
  targetServo1 = clampAngle(gyro2Center.servo1 + dGamma);
  targetServo2 = clampAngle(gyro2Center.servo2 - dBeta);

  if (padGeometry) {
    const nx = clamp(dGamma / GYRO_MAX_DEG, -1, 1);
    const ny = clamp(-dBeta / GYRO_MAX_DEG, -1, 1);
    setBallOffset(nx * padGeometry.maxRadius, -ny * padGeometry.maxRadius);
  }
}

async function requestGyroPermission() {
  if (typeof window.DeviceOrientationEvent === 'undefined') {
    log('device orientation is not available on this device/browser.', 'warn');
    return false;
  }

  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        log('gyroscope permission denied.', 'warn');
        return false;
      }
    } catch (error) {
      log(`gyroscope permission error: ${error.message}`, 'error');
      return false;
    }
  }

  return true;
}

function enableGyro() {
  if (gyro2Active) {
    disableGyro2();
  }
  gyroActive = true;
  gyroCenter = null;
  padGeometry = getPadGeometry();
  window.addEventListener('deviceorientation', handleDeviceOrientation);
  elements.gyroButton.textContent = 'Stop Gyro 1';
  elements.gyroButton.setAttribute('aria-pressed', 'true');
  startJoystickLoop();
  log('Gyro 1 enabled — current orientation is the new center');
}

function disableGyro() {
  if (!gyroActive) {
    return;
  }
  gyroActive = false;
  gyroCenter = null;
  padGeometry = null;
  window.removeEventListener('deviceorientation', handleDeviceOrientation);
  elements.gyroButton.textContent = 'Gyro 1';
  elements.gyroButton.setAttribute('aria-pressed', 'false');
  joystickDx = 0;
  joystickDy = 0;
  resetBallPosition();
  stopJoystickLoop();
  log('Gyro 1 disabled');
}

async function toggleGyro() {
  if (gyroActive) {
    disableGyro();
    return;
  }

  if (!(await requestGyroPermission())) {
    return;
  }

  enableGyro();
}

function enableGyro2() {
  if (gyroActive) {
    disableGyro();
  }
  gyro2Active = true;
  gyro2Center = null;
  targetServo1 = null;
  targetServo2 = null;
  padGeometry = getPadGeometry();
  window.addEventListener('deviceorientation', handleDeviceOrientation);
  elements.gyro2Button.textContent = 'Stop Gyro 2';
  elements.gyro2Button.setAttribute('aria-pressed', 'true');
  startJoystickLoop();
  log('Gyro 2 enabled — current orientation is the new center');
}

function disableGyro2() {
  if (!gyro2Active) {
    return;
  }
  gyro2Active = false;
  gyro2Center = null;
  targetServo1 = null;
  targetServo2 = null;
  padGeometry = null;
  window.removeEventListener('deviceorientation', handleDeviceOrientation);
  elements.gyro2Button.textContent = 'Gyro 2';
  elements.gyro2Button.setAttribute('aria-pressed', 'false');
  resetBallPosition();
  stopJoystickLoop();
  log('Gyro 2 disabled');
}

async function toggleGyro2() {
  if (gyro2Active) {
    disableGyro2();
    return;
  }

  if (!(await requestGyroPermission())) {
    return;
  }

  enableGyro2();
}

function isDesktopViewport() {
  return window.matchMedia('(min-width: 760px)').matches;
}

function openJoystick() {
  if (!isDesktopViewport() && state.starmapOpen) {
    closeStarmap();
  }
  elements.joystickOverlay.classList.add('open');
  elements.joystickOverlay.setAttribute('aria-hidden', 'false');
  resetBallPosition();
}

function closeJoystick() {
  if (gyroActive) {
    disableGyro();
  }
  if (gyro2Active) {
    disableGyro2();
  }
  if (pointerDragging) {
    handlePointerUp();
  }
  joystickDx = 0;
  joystickDy = 0;
  resetBallPosition();
  elements.joystickOverlay.classList.remove('open');
  elements.joystickOverlay.setAttribute('aria-hidden', 'true');
}

async function sendCommand(command) {
  if (!state.characteristic) {
    log(`blocked (not connected): ${command}`, 'warn');
    showConnectionWarning();
    return;
  }

  await state.characteristic.writeValue(encoder.encode(`${command}\n`));
  log(`sent: ${command}`);
}

function queueServoCommand(index, value) {
  const normalized = Math.max(0, Math.min(180, Number(value)));

  if (index === 1) {
    state.servo1 = normalized;
    clearTimeout(servo1Timer);
    servo1Timer = window.setTimeout(() => sendCommand(`servo1:${normalized}`), 100);
  } else {
    state.servo2 = normalized;
    clearTimeout(servo2Timer);
    servo2Timer = window.setTimeout(() => sendCommand(`servo2:${normalized}`), 100);
  }

  render();
}

function queueSpeedCommand(value) {
  const normalized = Math.max(0, Math.min(100, Number(value)));
  state.speedMs = normalized;
  clearTimeout(speedTimer);
  speedTimer = window.setTimeout(() => sendCommand(`speed:${normalized}`), 80);
  render();
}

async function toggleSweep(servo) {
  if (servo === 1) {
    state.sweep1Active = !state.sweep1Active;
  } else {
    state.sweep2Active = !state.sweep2Active;
  }
  render();
  await sendCommand(`sweep${servo}:${servo === 1 ? (state.sweep1Active ? 1 : 0) : (state.sweep2Active ? 1 : 0)}`);
}

function setPresetAngle(servo, angle) {
  if (servo === 1) {
    state.servo1 = angle;
    elements.servo1Slider.value = String(angle);
    sendCommand(`servo1:${angle}`);
  } else {
    state.servo2 = angle;
    elements.servo2Slider.value = String(angle);
    sendCommand(`servo2:${angle}`);
  }
  render();
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    log('Web Bluetooth is not available in this browser.', 'error');
    return;
  }

  try {
    log('opening Bluetooth picker...');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });

    device.addEventListener('gattserverdisconnected', handleDisconnect);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const characteristic = await service.getCharacteristic(COMMAND_UUID);

    state.device = device;
    state.characteristic = characteristic;
    state.connected = true;
    render();

    log(`connected to ${device.name || 'device'}`);
    await sendCommand(`servos:${state.servo1},${state.servo2}`);
    await sendCommand(`speed:${state.speedMs}`);
    await sendCommand(`sweep1:${state.sweep1Active ? 1 : 0}`);
    await sendCommand(`sweep2:${state.sweep2Active ? 1 : 0}`);
    await sendCommand(`out:${state.outputHigh ? 1 : 0}`);
  } catch (error) {
    log(`connect failed: ${error.message}`, 'error');
  }
}

function handleDisconnect() {
  state.connected = false;
  state.characteristic = null;
  state.device = null;
  closeJoystick();
  render();
  log('disconnected');
}

function disconnectBluetooth() {
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
  } else {
    handleDisconnect();
  }
}

let projectedObjects = [];
let hoverSegments = [];
let mountMarker = null;

function openStarmap() {
  if (!isDesktopViewport() && elements.joystickOverlay.classList.contains('open')) {
    closeJoystick();
  }
  state.starmapOpen = true;
  elements.starmapOverlay.classList.add('open');
  elements.starmapOverlay.setAttribute('aria-hidden', 'false');
  renderSky();
}

function closeStarmap() {
  state.starmapOpen = false;
  elements.starmapOverlay.classList.remove('open');
  elements.starmapOverlay.setAttribute('aria-hidden', 'true');
  hideTooltip();
  hideSearchResults();
}

function persistLocation() {
  if (state.location) {
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(state.location));
  }
}

function reflectLocationInUI() {
  elements.latInput.value = state.location.latitude;
  elements.lonInput.value = state.location.longitude;
  elements.locationStatus.textContent = `Location set: ${state.location.latitude.toFixed(4)}, ${state.location.longitude.toFixed(4)}`;
}

function loadPersistedLocation() {
  try {
    const raw = localStorage.getItem(LOCATION_STORAGE_KEY);
    if (!raw) {
      reflectLocationInUI();
      return;
    }
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
      state.location = parsed;
    }
  } catch {
    // ignore corrupt storage
  }
  reflectLocationInUI();
}

function persistCalibration() {
  localStorage.setItem(
    CALIBRATION_STORAGE_KEY,
    JSON.stringify({
      matrix: state.calibration.matrix,
      residualsDeg: state.calibration.residualsDeg,
      maxResidualDeg: state.calibration.maxResidualDeg,
    }),
  );
}

function loadPersistedCalibration() {
  try {
    const raw = localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (parsed.matrix) {
      state.calibration.matrix = parsed.matrix;
      state.calibration.residualsDeg = parsed.residualsDeg;
      state.calibration.maxResidualDeg = parsed.maxResidualDeg;
    }
  } catch {
    // ignore corrupt storage
  }
}

function setLocation(latitude, longitude) {
  state.location = { latitude, longitude };
  reflectLocationInUI();
  persistLocation();
  renderSky();
}

function requestGeolocation() {
  if (!navigator.geolocation) {
    elements.locationStatus.textContent = 'Geolocation is not available in this browser.';
    return;
  }
  elements.locationStatus.textContent = 'Requesting location...';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setLocation(position.coords.latitude, position.coords.longitude);
      log('location set from device GPS');
    },
    (error) => {
      elements.locationStatus.textContent = `Location error: ${error.message}`;
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

function handleManualLocationInput() {
  const latitude = Number(elements.latInput.value);
  const longitude = Number(elements.lonInput.value);
  if (
    Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90
    && Math.abs(longitude) <= 180
  ) {
    setLocation(latitude, longitude);
  }
}

function resizeCanvasIfNeeded(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, ratio };
}

function renderSky() {
  const canvas = elements.skyCanvas;
  const ctx = canvas.getContext('2d');
  const { width, height, ratio } = resizeCanvasIfNeeded(canvas);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 10 * ratio;

  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.lineWidth = ratio;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
  ctx.font = `${12 * ratio}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([label, az]) => {
    const azRad = az * DEG2RAD;
    const x = cx + (radius + 14 * ratio) * Math.sin(azRad);
    const y = cy - (radius + 14 * ratio) * Math.cos(azRad);
    ctx.fillText(label, x, y);
  });

  projectedObjects = [];
  hoverSegments = [];
  mountMarker = null;

  if (!state.location) {
    ctx.fillText('Set a location to show the sky', cx, cy);
    return;
  }

  const now = new Date();
  const project = makeHorizonProjector(now, state.location.latitude, state.location.longitude);
  const toScreen = (altitude, azimuth) => {
    const r = ((90 - altitude) / 90) * radius;
    const azRad = azimuth * DEG2RAD;
    return { x: cx + r * Math.sin(azRad), y: cy - r * Math.cos(azRad) };
  };

  const calibratedNames = new Set(state.calibration.points.map((point) => point.starName));
  const highlightConId = state.selectedObject?.kind === 'star'
    ? state.selectedObject.con
    : state.selectedObject?.kind === 'constellation'
      ? state.selectedObject.id
      : null;
  const highlightPoints = [];

  if (state.showConstellations) {
    CONSTELLATIONS.forEach((constellation) => {
      const isHighlighted = constellation.id === highlightConId;
      ctx.strokeStyle = isHighlighted ? 'rgba(56, 189, 248, 0.85)' : 'rgba(148, 163, 184, 0.22)';
      ctx.lineWidth = (isHighlighted ? 2 : 1) * ratio;

      constellation.lines.forEach((segment) => {
        for (let i = 0; i < segment.length - 1; i += 1) {
          const a = project(segment[i][0], segment[i][1]);
          const b = project(segment[i + 1][0], segment[i + 1][1]);
          if (a.altitude < -2 || b.altitude < -2) {
            continue;
          }
          const pa = toScreen(a.altitude, a.azimuth);
          const pb = toScreen(b.altitude, b.azimuth);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
          if (isHighlighted) {
            highlightPoints.push(pa, pb);
          }
          hoverSegments.push({
            id: constellation.id,
            name: constellation.name,
            ax: pa.x,
            ay: pa.y,
            bx: pb.x,
            by: pb.y,
          });
        }
      });
    });
  }

  if (highlightPoints.length) {
    const cxh = highlightPoints.reduce((sum, p) => sum + p.x, 0) / highlightPoints.length;
    const cyh = highlightPoints.reduce((sum, p) => sum + p.y, 0) / highlightPoints.length;
    const rh = Math.max(...highlightPoints.map((p) => Math.hypot(p.x - cxh, p.y - cyh))) + 14 * ratio;
    ctx.beginPath();
    ctx.arc(cxh, cyh, rh, 0, Math.PI * 2);
    ctx.setLineDash([6 * ratio, 5 * ratio]);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1.5 * ratio;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  STARS.forEach((star) => {
    const { altitude, azimuth } = project(star.ra, star.dec);
    if (altitude < -2) {
      return;
    }

    const { x, y } = toScreen(altitude, azimuth);
    projectedObjects.push({ kind: 'star', ref: star, altitude, azimuth, x, y });

    const starRadius = Math.max(1.5, 4.5 - star.mag * 0.6) * ratio;
    ctx.beginPath();
    ctx.arc(x, y, starRadius, 0, Math.PI * 2);
    ctx.fillStyle = altitude < 0 ? 'rgba(226, 232, 240, 0.25)' : '#e2e8f0';
    ctx.fill();

    if (calibratedNames.has(star.name)) {
      ctx.beginPath();
      ctx.arc(x, y, starRadius + 4 * ratio, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.85)';
      ctx.lineWidth = 1.5 * ratio;
      ctx.stroke();
    }

    if (state.selectedObject?.kind === 'star' && state.selectedObject.name === star.name) {
      ctx.beginPath();
      ctx.arc(x, y, starRadius + 7 * ratio, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.lineWidth = 2 * ratio;
      ctx.stroke();
    }
  });

  if (state.showMessier) {
    MESSIER.forEach((entry) => {
      const { altitude, azimuth } = project(entry.ra, entry.dec);
      if (altitude < -2) {
        return;
      }

      const { x, y } = toScreen(altitude, azimuth);
      projectedObjects.push({ kind: 'messier', ref: entry, altitude, azimuth, x, y });

      const half = Math.max(2, 4 - entry.mag * 0.3) * ratio;
      ctx.strokeStyle = altitude < 0 ? 'rgba(196, 181, 253, 0.3)' : 'rgba(196, 181, 253, 0.85)';
      ctx.lineWidth = ratio;
      ctx.strokeRect(x - half, y - half, half * 2, half * 2);

      if (state.selectedObject?.kind === 'messier' && state.selectedObject.id === entry.id) {
        ctx.beginPath();
        ctx.arc(x, y, half + 7 * ratio, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
        ctx.lineWidth = 2 * ratio;
        ctx.stroke();
      }
    });
  }

  if (state.calibration.matrix) {
    const localVec = servoToLocalUnit(state.servo1, state.servo2);
    const trueVec = localToTrue(state.calibration.matrix, localVec);
    const { altitude, azimuth } = unitToAltAz(trueVec);
    if (altitude >= -2) {
      const { x, y } = toScreen(altitude, azimuth);
      mountMarker = { x, y, altitude, azimuth };

      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2 * ratio;
      ctx.beginPath();
      ctx.arc(x, y, 9 * ratio, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 14 * ratio, y);
      ctx.lineTo(x - 4 * ratio, y);
      ctx.moveTo(x + 4 * ratio, y);
      ctx.lineTo(x + 14 * ratio, y);
      ctx.moveTo(x, y - 14 * ratio);
      ctx.lineTo(x, y - 4 * ratio);
      ctx.moveTo(x, y + 4 * ratio);
      ctx.lineTo(x, y + 14 * ratio);
      ctx.stroke();
    }
  }
}

function preslewToward(star, altitude, azimuth) {
  const { matrix } = solveAlignment(state.calibration.points);
  const trueVec = altAzToUnit(altitude, azimuth);
  const localVec = trueToLocal(matrix, trueVec);
  const { servo1, servo2, inRange } = localUnitToServo(localVec);

  if (!inRange) {
    log(`${star.name} looks outside the mount's range from a partial estimate — aim manually`, 'warn');
    return;
  }

  applyServoTargets(servo1, servo2);
  log(
    `pre-slewing toward ${star.name} (estimate from ${state.calibration.points.length} point`
    + `${state.calibration.points.length === 1 ? '' : 's'}) — fine-tune, then confirm`,
  );
}

function selectObject(kind, ref, altitude, azimuth) {
  state.selectedObject = { kind, ...ref };

  if (kind === 'star') {
    elements.selectedStarInfo.textContent = `${ref.name} (${CONSTELLATIONS_BY_ID.get(ref.con)?.name ?? ref.con}) — alt ${altitude.toFixed(1)}°, az ${azimuth.toFixed(1)}°`;
  } else if (kind === 'constellation') {
    elements.selectedStarInfo.textContent = `${ref.name} (constellation center) — alt ${altitude.toFixed(1)}°, az ${azimuth.toFixed(1)}°`;
  } else {
    elements.selectedStarInfo.textContent = `${objectLabel({ kind, ...ref })} — ${ref.type}, mag ${ref.mag} — alt ${altitude.toFixed(1)}°, az ${azimuth.toFixed(1)}°`;
  }

  if (kind === 'star' && state.calibrating && state.connected && state.calibration.points.length > 0) {
    preslewToward(ref, altitude, azimuth);
  }

  updateCalibrationUI();
  renderSky();
}

function selectConstellation(constellation) {
  if (!state.location) {
    log('set a location before selecting a constellation', 'warn');
    return;
  }

  const { ra, dec } = constellationCentroid(constellation);
  const now = new Date();
  const { altitude, azimuth } = starAltAz({ ra, dec }, now, state.location.latitude, state.location.longitude);
  selectObject('constellation', { id: constellation.id, name: constellation.name, ra, dec }, altitude, azimuth);
}

function handleSkyCanvasClick(event) {
  if (!projectedObjects.length && !hoverSegments.length) {
    return;
  }

  const canvas = elements.skyCanvas;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const clickX = (event.clientX - rect.left) * ratio;
  const clickY = (event.clientY - rect.top) * ratio;

  let closest = null;
  let closestDist = Infinity;
  projectedObjects.forEach((entry) => {
    const dist = Math.hypot(entry.x - clickX, entry.y - clickY);
    if (dist < closestDist) {
      closestDist = dist;
      closest = entry;
    }
  });

  const threshold = 16 * ratio;
  if (closest && closestDist <= threshold) {
    selectObject(closest.kind, closest.ref, closest.altitude, closest.azimuth);
    return;
  }

  let closestLine = null;
  let closestLineDist = Infinity;
  hoverSegments.forEach((segment) => {
    const dist = distanceToSegment(clickX, clickY, segment.ax, segment.ay, segment.bx, segment.by);
    if (dist < closestLineDist) {
      closestLineDist = dist;
      closestLine = segment;
    }
  });

  if (closestLine && closestLineDist <= 8 * ratio) {
    const constellation = CONSTELLATIONS_BY_ID.get(closestLine.id);
    if (constellation) {
      selectConstellation(constellation);
    }
  }
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const nearX = ax + t * dx;
  const nearY = ay + t * dy;
  return Math.hypot(px - nearX, py - nearY);
}

function hideTooltip() {
  elements.skyTooltip.hidden = true;
}

function showTooltip(clientX, clientY, text) {
  const wrapRect = elements.skyCanvasWrap.getBoundingClientRect();
  elements.skyTooltip.textContent = text;
  elements.skyTooltip.style.left = `${clientX - wrapRect.left}px`;
  elements.skyTooltip.style.top = `${clientY - wrapRect.top}px`;
  elements.skyTooltip.hidden = false;
}

function handleSkyCanvasHover(event) {
  const canvas = elements.skyCanvas;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const hoverX = (event.clientX - rect.left) * ratio;
  const hoverY = (event.clientY - rect.top) * ratio;

  if (mountMarker) {
    const mountDist = Math.hypot(mountMarker.x - hoverX, mountMarker.y - hoverY);
    if (mountDist <= 16 * ratio) {
      showTooltip(event.clientX, event.clientY, 'Mount (current position)');
      return;
    }
  }

  let closestPoint = null;
  let closestPointDist = Infinity;
  projectedObjects.forEach((entry) => {
    const dist = Math.hypot(entry.x - hoverX, entry.y - hoverY);
    if (dist < closestPointDist) {
      closestPointDist = dist;
      closestPoint = entry;
    }
  });

  if (closestPoint && closestPointDist <= 16 * ratio) {
    showTooltip(event.clientX, event.clientY, objectLabel({ kind: closestPoint.kind, ...closestPoint.ref }));
    return;
  }

  let closestLine = null;
  let closestLineDist = Infinity;
  hoverSegments.forEach((segment) => {
    const dist = distanceToSegment(hoverX, hoverY, segment.ax, segment.ay, segment.bx, segment.by);
    if (dist < closestLineDist) {
      closestLineDist = dist;
      closestLine = segment;
    }
  });

  if (closestLine && closestLineDist <= 8 * ratio) {
    showTooltip(event.clientX, event.clientY, closestLine.name);
    return;
  }

  hideTooltip();
}

function renderCalibrationSteps() {
  elements.calibrationStepsList.innerHTML = '';
  for (let i = 0; i < 3; i += 1) {
    const point = state.calibration.points[i];
    const item = document.createElement('li');
    if (point) {
      const residual = state.calibration.residualsDeg ? state.calibration.residualsDeg[i] : null;
      item.textContent = residual !== null && residual !== undefined
        ? `Point ${i + 1}: ${point.starName} (residual ${residual.toFixed(2)}°)`
        : `Point ${i + 1}: ${point.starName} — captured`;
      item.dataset.done = 'true';
    } else {
      item.textContent = `Point ${i + 1}: not captured`;
    }
    elements.calibrationStepsList.appendChild(item);
  }
}

function updateCalibrationUI() {
  elements.calibrateStartButton.disabled = !state.connected;
  elements.calibrateConfirmButton.disabled = !(
    state.connected
    && state.calibrating
    && state.selectedObject?.kind === 'star'
    && state.calibration.points.length < 3
  );
  elements.gotoButton.disabled = !(state.connected && state.calibration.matrix && state.selectedObject);
  elements.slewAroundButton.disabled = !(
    slewAroundActive
    || (state.connected && state.calibration.matrix && state.selectedObject?.kind === 'constellation')
  );

  if (state.calibration.matrix) {
    elements.alignmentPill.textContent = `Calibrated (±${state.calibration.maxResidualDeg.toFixed(1)}°)`;
    elements.alignmentPill.className = 'pill pill-on';
  } else if (state.calibrating) {
    elements.alignmentPill.textContent = `Calibrating (${state.calibration.points.length}/3)`;
    elements.alignmentPill.className = 'pill pill-soft';
  } else {
    elements.alignmentPill.textContent = 'Not calibrated';
    elements.alignmentPill.className = 'pill pill-off';
  }
}

function startCalibration() {
  if (!state.connected) {
    return;
  }
  state.calibration.points = [];
  state.calibration.matrix = null;
  state.calibration.residualsDeg = null;
  state.calibration.maxResidualDeg = null;
  state.calibrating = true;
  elements.selectedStarInfo.textContent = 'Calibration started — select a star, aim the mount at it, then confirm.';
  renderCalibrationSteps();
  updateCalibrationUI();
  renderSky();
  log('calibration started — pick 3 well-separated stars');
}

function confirmCalibrationPoint() {
  if (!state.location) {
    log('set a location before calibrating', 'warn');
    return;
  }
  if (!state.calibrating || state.selectedObject?.kind !== 'star' || state.calibration.points.length >= 3) {
    return;
  }

  const now = new Date();
  const { altitude, azimuth } = starAltAz(
    state.selectedObject,
    now,
    state.location.latitude,
    state.location.longitude,
  );

  state.calibration.points.push({
    starName: state.selectedObject.name,
    servo1: state.servo1,
    servo2: state.servo2,
    altitude,
    azimuth,
  });

  log(`calibration point ${state.calibration.points.length}/3 captured: ${state.selectedObject.name}`);
  renderCalibrationSteps();

  if (state.calibration.points.length === 3) {
    const { matrix, residualsDeg, maxResidualDeg } = solveAlignment(state.calibration.points);
    state.calibration.matrix = matrix;
    state.calibration.residualsDeg = residualsDeg;
    state.calibration.maxResidualDeg = maxResidualDeg;
    state.calibrating = false;
    persistCalibration();
    log(
      `calibration solved — max residual ${maxResidualDeg.toFixed(2)}°`,
      maxResidualDeg > 3 ? 'warn' : 'normal',
    );
    renderCalibrationSteps();
  }

  updateCalibrationUI();
  renderSky();
}

function performGoto() {
  if (!state.calibration.matrix || !state.selectedObject || !state.location || !state.connected) {
    return;
  }

  const now = new Date();
  const { altitude, azimuth } = starAltAz(
    state.selectedObject,
    now,
    state.location.latitude,
    state.location.longitude,
  );
  const trueVec = altAzToUnit(altitude, azimuth);
  const localVec = trueToLocal(state.calibration.matrix, trueVec);
  const { servo1, servo2, inRange } = localUnitToServo(localVec);
  const label = objectLabel(state.selectedObject);

  if (!inRange) {
    log(`${label} is outside the mount's reachable range`, 'warn');
    return;
  }

  applyServoTargets(servo1, servo2);
  log(`slewing to ${label} (servo1:${servo1}, servo2:${servo2})`);
}

const SLEW_AROUND_STEP_MS = 1800;
let slewAroundActive = false;
let slewAroundCancelled = false;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stopSlewAround() {
  slewAroundCancelled = true;
}

async function performSlewAround() {
  if (
    slewAroundActive
    || !state.calibration.matrix
    || state.selectedObject?.kind !== 'constellation'
    || !state.location
    || !state.connected
  ) {
    return;
  }

  const constellation = CONSTELLATIONS_BY_ID.get(state.selectedObject.id);
  if (!constellation) {
    return;
  }

  const centroid = constellationCentroid(constellation);
  const centroidUnit = raDecToUnit(centroid.ra, centroid.dec);
  const dilationDeg = state.slewAroundDilationDeg;
  const vertices = constellationVertices(constellation).map((vertex) => dilateRaDec(vertex, centroidUnit, dilationDeg));

  slewAroundActive = true;
  slewAroundCancelled = false;
  elements.slewAroundButton.textContent = 'Stop tour';
  log(`touring ${constellation.name} (${vertices.length} points, +${dilationDeg}° border)`);

  for (let i = 0; i < vertices.length; i += 1) {
    if (slewAroundCancelled) {
      break;
    }

    const now = new Date();
    const { altitude, azimuth } = starAltAz(vertices[i], now, state.location.latitude, state.location.longitude);
    if (altitude >= -2) {
      const trueVec = altAzToUnit(altitude, azimuth);
      const localVec = trueToLocal(state.calibration.matrix, trueVec);
      const { servo1, servo2, inRange } = localUnitToServo(localVec);
      if (inRange) {
        applyServoTargets(servo1, servo2);
        // eslint-disable-next-line no-await-in-loop
        await sleep(SLEW_AROUND_STEP_MS);
        continue;
      }
    }
  }

  slewAroundActive = false;
  elements.slewAroundButton.textContent = 'Slew around';
  log(slewAroundCancelled ? `tour of ${constellation.name} stopped` : `tour of ${constellation.name} complete`);
  updateCalibrationUI();
}

function toggleSlewAround() {
  if (slewAroundActive) {
    stopSlewAround();
  } else {
    performSlewAround();
  }
}

function openSettings() {
  elements.settingsOverlay.classList.add('open');
  elements.settingsOverlay.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  elements.settingsOverlay.classList.remove('open');
  elements.settingsOverlay.setAttribute('aria-hidden', 'true');
}

function toggleSettings() {
  if (elements.settingsOverlay.classList.contains('open')) {
    closeSettings();
  } else {
    openSettings();
  }
}

const SEARCH_RESULT_LIMIT = 8;

// Only searches whichever layers are currently toggled on — stars are
// always shown (no toggle exists for them), constellations/Messier follow
// their respective layer buttons.
function searchCatalog(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }

  const results = [];

  STARS.forEach((star) => {
    if (star.name.toLowerCase().includes(q)) {
      results.push({ kind: 'star', ref: star, label: star.name });
    }
  });

  if (state.showConstellations) {
    CONSTELLATIONS.forEach((constellation) => {
      if (constellation.name.toLowerCase().includes(q) || constellation.id.toLowerCase().includes(q)) {
        results.push({ kind: 'constellation', ref: constellation, label: constellation.name });
      }
    });
  }

  if (state.showMessier) {
    MESSIER.forEach((entry) => {
      if (entry.id.toLowerCase().includes(q) || (entry.name && entry.name.toLowerCase().includes(q))) {
        results.push({ kind: 'messier', ref: entry, label: objectLabel({ kind: 'messier', ...entry }) });
      }
    });
  }

  return results.slice(0, SEARCH_RESULT_LIMIT);
}

function hideSearchResults() {
  elements.searchResults.hidden = true;
  elements.searchResults.innerHTML = '';
}

function handleSearchSelect(result) {
  elements.searchInput.value = '';
  hideSearchResults();

  if (result.kind === 'constellation') {
    selectConstellation(result.ref);
    return;
  }

  if (!state.location) {
    log('set a location before selecting a search result', 'warn');
    return;
  }

  const now = new Date();
  const { altitude, azimuth } = starAltAz(result.ref, now, state.location.latitude, state.location.longitude);
  selectObject(result.kind, result.ref, altitude, azimuth);
}

function renderSearchResults() {
  const results = searchCatalog(elements.searchInput.value);
  elements.searchResults.innerHTML = '';

  if (!results.length) {
    elements.searchResults.hidden = true;
    return;
  }

  const icons = { star: '★', messier: '◆', constellation: '▦' };
  results.forEach((result) => {
    const item = document.createElement('li');
    item.textContent = `${icons[result.kind]} ${result.label}`;
    item.addEventListener('click', () => handleSearchSelect(result));
    elements.searchResults.appendChild(item);
  });
  elements.searchResults.hidden = false;
}

elements.connectButton.addEventListener('click', connectBluetooth);
elements.disconnectButton.addEventListener('click', disconnectBluetooth);

elements.servo1Slider.addEventListener('input', (event) => queueServoCommand(1, event.target.value));
elements.servo2Slider.addEventListener('input', (event) => queueServoCommand(2, event.target.value));
elements.speedSlider.addEventListener('input', (event) => queueSpeedCommand(event.target.value));
elements.sweep1Button.addEventListener('click', () => toggleSweep(1));
elements.sweep2Button.addEventListener('click', () => toggleSweep(2));

elements.presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const servo = Number(button.dataset.servo);
    const angle = Number(button.dataset.angle);
    setPresetAngle(servo, angle);
  });
});

async function toggleOutput() {
  state.outputHigh = !state.outputHigh;
  render();
  await sendCommand(`out:${state.outputHigh ? 1 : 0}`);
}

elements.outputButton.addEventListener('click', toggleOutput);
elements.joystickOutputButton.addEventListener('click', toggleOutput);

elements.clearLogButton.addEventListener('click', () => {
  elements.logList.innerHTML = '';
});

elements.joystickButton.addEventListener('click', openJoystick);
elements.joystickCloseButton.addEventListener('click', closeJoystick);
elements.switchToStarmapButton.addEventListener('click', openStarmap);
elements.gyroButton.addEventListener('click', toggleGyro);
elements.gyro2Button.addEventListener('click', toggleGyro2);

elements.trackpadPad.addEventListener('pointerdown', handlePointerDown);
elements.trackpadPad.addEventListener('pointermove', handlePointerMove);
elements.trackpadPad.addEventListener('pointerup', handlePointerUp);
elements.trackpadPad.addEventListener('pointercancel', handlePointerUp);

window.addEventListener('beforeunload', () => {
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
  }
});

elements.locateButton.addEventListener('click', requestGeolocation);
elements.latInput.addEventListener('change', handleManualLocationInput);
elements.lonInput.addEventListener('change', handleManualLocationInput);
elements.skyCanvas.addEventListener('click', handleSkyCanvasClick);
elements.skyCanvas.addEventListener('mousemove', handleSkyCanvasHover);
elements.skyCanvas.addEventListener('mouseleave', hideTooltip);
elements.calibrateStartButton.addEventListener('click', startCalibration);
elements.calibrateConfirmButton.addEventListener('click', confirmCalibrationPoint);
elements.gotoButton.addEventListener('click', performGoto);
elements.slewAroundButton.addEventListener('click', toggleSlewAround);
elements.searchInput.addEventListener('input', renderSearchResults);
elements.searchButton.addEventListener('click', renderSearchResults);
elements.searchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  const [firstResult] = searchCatalog(elements.searchInput.value);
  if (firstResult) {
    handleSearchSelect(firstResult);
  }
});
document.addEventListener('click', (event) => {
  if (
    !elements.searchResults.hidden
    && !elements.searchResults.contains(event.target)
    && event.target !== elements.searchInput
    && event.target !== elements.searchButton
  ) {
    hideSearchResults();
  }
});
elements.starmapButton.addEventListener('click', openStarmap);
elements.starmapCloseButton.addEventListener('click', closeStarmap);
elements.switchToJoystickButton.addEventListener('click', openJoystick);
elements.toggleConstellationsButton.addEventListener('click', () => {
  state.showConstellations = !state.showConstellations;
  elements.toggleConstellationsButton.setAttribute('aria-pressed', String(state.showConstellations));
  renderSky();
});
elements.toggleMessierButton.addEventListener('click', () => {
  state.showMessier = !state.showMessier;
  elements.toggleMessierButton.setAttribute('aria-pressed', String(state.showMessier));
  renderSky();
});
window.addEventListener('resize', () => {
  if (state.starmapOpen) {
    renderSky();
  }
});

elements.dilationSlider.addEventListener('input', (event) => {
  state.slewAroundDilationDeg = Number(event.target.value);
  elements.dilationValue.textContent = `${state.slewAroundDilationDeg}°`;
});
elements.settingsButton.addEventListener('click', toggleSettings);
elements.settingsCloseButton.addEventListener('click', closeSettings);
document.addEventListener('click', (event) => {
  if (
    elements.settingsOverlay.classList.contains('open')
    && !elements.settingsOverlay.contains(event.target)
    && event.target !== elements.settingsButton
  ) {
    closeSettings();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (elements.joystickOverlay.classList.contains('open')) {
    closeJoystick();
  }
  if (elements.starmapOverlay.classList.contains('open')) {
    closeStarmap();
  }
  if (elements.settingsOverlay.classList.contains('open')) {
    closeSettings();
  }
  hideSearchResults();
  hideTooltip();
});

loadPersistedLocation();
loadPersistedCalibration();
renderCalibrationSteps();
updateCalibrationUI();
window.setInterval(() => {
  if (state.starmapOpen) {
    renderSky();
  }
}, 5000);

render();
log('ready. connect a compatible Bluetooth device to start.');