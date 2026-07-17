# Bluetooth Servo Controller Monorepo

Simple hardware + software project for controlling two SG90 servos and one digital output from a web browser over Bluetooth.

The browser app talks directly to the controller over Web Bluetooth. A server-side bridge can be added later if you want a local relay or a non-Bluetooth transport.

## What It Does

- Controls 2x SG90 servos from a browser UI.
- Sets 1 digital output high or low.
- Sends commands over Bluetooth from the browser.
- Uses a server-side bridge when the browser cannot talk to the device directly.

## Monorepo Layout

The repository is organized as a simple monorepo so the UI and hardware code can evolve together.

```text
.
├── webapp/        # Browser UI for sliders, buttons, and Bluetooth connection status
├── server/        # Optional future bridge service
├── hardware/      # Embedded firmware for the controller board
└── README.md
```

This repository currently contains the embedded PlatformIO project used on the controller board and a browser UI in `webapp/`.

## Hardware

- Controller board: Adafruit QT Py ESP32-C3
- Servo 1: SG90
- Servo 2: SG90
- Digital output: 1 GPIO output, toggled high/low

### Notes

- SG90 servos should be powered from a suitable external 5V supply.
- Share ground between the controller board, servos, and any external load.
- Do not power multiple servos directly from a weak USB port unless you have confirmed the current draw is safe.

## Software

### Web App

- Runs in the browser.
- Provides controls for servo position and digital output state.
- Connects through Web Bluetooth when supported by the browser.
- Uses a custom GATT service and command characteristic defined in `webapp/src/main.js`.

### Server Bridge

- Receives commands from the web app when a local bridge is needed.
- Forwards those commands to the hardware controller.
- Keeps the browser UI simple and focused on control.

### Firmware

- Runs on the ESP32-C3 controller board.
- Receives commands.
- Moves both servos.
- Sets the digital output high or low.

## Development

The embedded project uses PlatformIO.

Run the web UI on Windows:

```powershell
cd webapp
npm install
npm run dev
```

Open the local Vite URL that appears in the terminal, then connect from a Chromium-based browser that supports Web Bluetooth.

## Docker Deploy

The frontend can be built into a static Docker image from `webapp/`.

Build locally:

```bash
cd webapp
docker build -t servo-control-webapp:latest .
```

Run locally:

```bash
docker run --rm -p 8080:80 servo-control-webapp:latest
```

Publish to your registry by tagging and pushing the image after logging in, for example:

```bash
docker tag servo-control-webapp:latest your-registry.example.com/servo-control-webapp:latest
docker push your-registry.example.com/servo-control-webapp:latest
```

If you want, I can also add a `docker-compose.yml` or a GitHub Actions workflow for automated builds and pushes.

Coolify deploy helper:

```powershell
.\deploy-coolify.ps1 -CoolifyDomain "YOUR_COOLIFY_DOMAIN" -AppUuid "YOUR_APP_UUID" -Token "YOUR_COOLIFY_TOKEN"
```

Build and upload:

```bash
platformio run --target upload
```

Open the serial monitor:

```bash
platformio device monitor
```

## Command Format

The exact command format can be whatever the web app and firmware agree on. A simple approach is:

- `servo1:90`
- `servo2:180`
- `out:1`
- `out:0`

## Future Work

- Add the web UI.
- Add the Bluetooth transport layer.
- Add the server bridge protocol.
- Add firmware for both servos and the digital output.
