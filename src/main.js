import './style.css';

const SERVICE_UUID = '6f94b030-1c3a-4c44-8f19-1f8b31d71f40';
const COMMAND_UUID = '6f94b031-1c3a-4c44-8f19-1f8b31d71f40';

const state = {
  connected: false,
  device: null,
  characteristic: null,
  servo1: 90,
  servo2: 90,
  outputHigh: false,
  sweep1Active: false,
  sweep2Active: false,
  speedMs: 0,
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
  elements.joystickOutputButton.disabled = !state.connected;
  elements.sweep1Button.textContent = state.sweep1Active ? 'Stop sweep 1' : 'Sweep servo 1';
  elements.sweep1Button.setAttribute('aria-pressed', String(state.sweep1Active));
  elements.sweep2Button.textContent = state.sweep2Active ? 'Stop sweep 2' : 'Sweep servo 2';
  elements.sweep2Button.setAttribute('aria-pressed', String(state.sweep2Active));
  elements.connectionPill.textContent = state.connected ? 'Connected' : 'Disconnected';
  elements.connectionPill.className = `pill ${state.connected ? 'pill-on' : 'pill-off'}`;
  elements.disconnectButton.disabled = !state.connected;
  elements.servo1Slider.disabled = !state.connected;
  elements.servo2Slider.disabled = !state.connected;
  elements.outputButton.disabled = !state.connected;
  elements.speedSlider.disabled = !state.connected;
  elements.sweep1Button.disabled = !state.connected;
  elements.sweep2Button.disabled = !state.connected;
  elements.joystickButton.disabled = !state.connected;
  elements.joystickServo1Value.textContent = `${state.servo1}°`;
  elements.joystickServo2Value.textContent = `${state.servo2}°`;
  elements.presetButtons.forEach((button) => {
    button.disabled = !state.connected;
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampAngle(value) {
  return clamp(Math.round(value), 0, 180);
}

async function sendCommandQuiet(command) {
  if (!state.characteristic) {
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
  if (Math.hypot(nx, ny) < JOYSTICK_DEADZONE) {
    joystickDx = 0;
    joystickDy = 0;
    return;
  }
  joystickDx = clamp(-nx, -1, 1);
  joystickDy = clamp(ny, -1, 1);
}

function joystickTick() {
  if (gyro2Active) {
    let changed = false;

    if (targetServo1 !== null && targetServo1 !== state.servo1) {
      state.servo1 = targetServo1;
      elements.servo1Slider.value = String(targetServo1);
      sendCommandQuiet(`servo1:${targetServo1}`);
      changed = true;
    }

    if (targetServo2 !== null && targetServo2 !== state.servo2) {
      state.servo2 = targetServo2;
      elements.servo2Slider.value = String(targetServo2);
      sendCommandQuiet(`servo2:${targetServo2}`);
      changed = true;
    }

    if (changed) {
      render();
    }
    return;
  }

  if (joystickDx === 0 && joystickDy === 0) {
    return;
  }

  const nextServo1 = clampAngle(state.servo1 + joystickDx * JOYSTICK_MAX_DEG_PER_TICK);
  const nextServo2 = clampAngle(state.servo2 + joystickDy * JOYSTICK_MAX_DEG_PER_TICK);
  let changed = false;

  if (nextServo1 !== state.servo1) {
    state.servo1 = nextServo1;
    elements.servo1Slider.value = String(nextServo1);
    sendCommandQuiet(`servo1:${nextServo1}`);
    changed = true;
  }

  if (nextServo2 !== state.servo2) {
    state.servo2 = nextServo2;
    elements.servo2Slider.value = String(nextServo2);
    sendCommandQuiet(`servo2:${nextServo2}`);
    changed = true;
  }

  if (changed) {
    render();
  }
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

function openJoystick() {
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
    await sendCommand(`servo1:${state.servo1}`);
    await sendCommand(`servo2:${state.servo2}`);
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

render();
log('ready. connect a compatible Bluetooth device to start.');