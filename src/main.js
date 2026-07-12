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
};

const encoder = new TextEncoder();
let servo1Timer = null;
let servo2Timer = null;
let speedTimer = null;

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
  elements.presetButtons.forEach((button) => {
    button.disabled = !state.connected;
  });
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

elements.outputButton.addEventListener('click', async () => {
  state.outputHigh = !state.outputHigh;
  render();
  await sendCommand(`out:${state.outputHigh ? 1 : 0}`);
});

elements.clearLogButton.addEventListener('click', () => {
  elements.logList.innerHTML = '';
});

window.addEventListener('beforeunload', () => {
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
  }
});

render();
log('ready. connect a compatible Bluetooth device to start.');