# Bluetooth Servo Mount + Star Map

A two-servo pan/tilt (yaw/pitch) mount and digital output, controlled from a browser over Web Bluetooth — with a
built-in sky map that can align the mount against real stars and then automatically slew it to any star,
constellation, or Messier object.

The browser talks directly to the ESP32-C3 controller over Web Bluetooth. There is no server-side bridge — the
whole system is just a static web app + firmware.

## What It Does

- Drives 2x SG90 servos (yaw + pitch, 0–180° each) and 1 digital output (high/low) from a browser UI.
- Manual control via sliders, angle presets, sweep, an on-screen joystick (trackpad drag, phone-tilt "Gyro 1", or
  direct-angle "Gyro 2"), all disableable behind a collapsible "Manual servo control" panel.
- A star map (`Star Map` button) that:
  - Computes live Alt/Az for ~30 bright named stars, all 88 IAU constellations, and the full 110-object Messier
    catalog, from your location and the current time (via `astronomy-engine`).
  - Lets you **calibrate** the mount against 3 real stars — aim the mount manually (joystick/sliders), confirm each
    point, and it solves for the arbitrary 3D rotation between the mount's own frame and the true sky (Wahba's
    problem via Davenport's q-method), which handles a mount that isn't level or aligned to true north.
  - Once calibrated, **"Slew here"** points the mount at any selected star/constellation-center/Messier object;
    **"Slew around"** tours every star in a selected constellation's figure (with a settings-configurable dilated
    border so it traces around the shape rather than landing exactly on each star).
  - Search by name (filtered to whichever layers — constellations / Messier — are currently toggled on), or click
    stars/constellation lines/Messier markers directly on the map; hover shows names.
  - Shows a live crosshair for where the mount is *actually* pointing right now, separate from any selected target,
    so it's visible if you nudge the joystick after a slew.
- Settings (gear icon, top-right): interpolation speed, slew-around border angle, and Disconnect.
- On desktop, the Joystick and Star Map panels are independent floating panels that can both be open at once
  (calibration needs the joystick usable while watching the map); on narrow/mobile screens only one is open at a
  time. Esc closes any open panel.
- Controls stay clickable even before connecting — sending anything while disconnected just shows a warning toast
  instead of doing nothing silently.

## Monorepo Layout

```text
.
├── platformio.ini   # PlatformIO project config (src/include/lib dirs point into hardware/)
├── hardware/        # ESP32-C3 firmware (src/, include/, lib/, test/)
├── webapp/          # Browser UI (Vite, vanilla JS)
└── README.md
```

`platformio.ini` lives at the repo root so a plain `pio run` works from there; it points `src_dir`/`include_dir`/
`lib_dir`/`test_dir` at the corresponding folders under `hardware/`.

## Hardware

- Controller board: Adafruit QT Py ESP32-C3
- Servo 1 (yaw): SG90, GPIO0
- Servo 2 (pitch): SG90, GPIO1
- Digital output: GPIO2, toggled high/low

### Notes

- SG90 servos should be powered from a suitable external 5V supply.
- Share ground between the controller board, servos, and any external load.
- Do not power multiple servos directly from a weak USB port unless you have confirmed the current draw is safe.

## Software

### Web App (`webapp/`)

- Vanilla JS + Vite, no framework.
- Connects via Web Bluetooth to a custom GATT service/characteristic (UUIDs in `webapp/src/main.js` and
  `hardware/src/main.cpp` — must match).
- Star map math lives in `webapp/src/sky-math.js` (Alt/Az via `astronomy-engine`) and `webapp/src/mount-align.js`
  (servo-angle ⟷ unit-vector mapping, Wahba's-problem solver, goto inverse). Catalogs are static data in
  `stars.js`, `constellations.js`, `messier.js`.
- Calibration and the last-known geolocation persist in `localStorage`; servo/connection state does not (a fresh
  page load needs a fresh connection, but not necessarily a fresh calibration).

### Firmware (`hardware/src/main.cpp`)

- Runs on the ESP32-C3, advertises the GATT service, parses newline-terminated text commands from either the BLE
  characteristic or the USB serial console.
- Interpolates both servos toward their targets at a configurable step delay (`speed:<ms>`), independent sweep
  mode per servo, and the digital output.
- Restarts BLE advertising on client disconnect (`BLEServerCallbacks::onDisconnect`) — without this the board
  becomes unreachable after any disconnect (including a browser tab reload) until power-cycled.

## Command Format

Newline-terminated text commands, written to the BLE characteristic (or sent over serial):

- `servo1:<0-180>` — set yaw
- `servo2:<0-180>` — set pitch
- `servos:<0-180>,<0-180>` — set both yaw and pitch in one write (used wherever both axes move together, e.g. the
  joystick and star-map goto, so they slew as one motion instead of racing each other)
- `speed:<0-100>` — ms delay between 1° interpolation steps (lower = faster)
- `sweep1:<0|1>`, `sweep2:<0|1>` — continuous 0↔180° sweep per servo
- `out:<0|1>` — digital output low/high

## Development

Web app:

```powershell
cd webapp
npm install
npm run dev
```

Open the local Vite URL, then connect from a Chromium-based browser that supports Web Bluetooth (desktop Chrome/
Edge, or Android Chrome — not supported on iOS).

Firmware, from the repo root:

```bash
platformio run --target upload
platformio device monitor
```

## Docker Deploy

The frontend builds into a static Docker image from `webapp/`.

```bash
cd webapp
docker build -t servo-control-webapp:latest .
docker run --rm -p 8080:80 servo-control-webapp:latest
```

Publish to your registry by tagging and pushing after logging in:

```bash
docker tag servo-control-webapp:latest your-registry.example.com/servo-control-webapp:latest
docker push your-registry.example.com/servo-control-webapp:latest
```

Coolify deploy helper:

```powershell
.\webapp\deploy-coolify.ps1 -CoolifyDomain "YOUR_COOLIFY_DOMAIN" -AppUuid "YOUR_APP_UUID" -Token "YOUR_COOLIFY_TOKEN"
```

GitHub Pages deploys automatically on push to `master` via `.github/workflows/pages.yml` (builds `webapp/`,
publishes `webapp/dist`).

## Status / Known Gaps

- The star map, calibration, search, and slew-around features are implemented and pass build/math-level checks,
  but haven't all been driven end-to-end in a browser against real hardware yet.
- iOS is not a target (no Web Bluetooth support in Safari).
