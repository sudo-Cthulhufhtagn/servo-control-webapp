# Star map — client-side architecture options

Goal: mobile webapp, no server-side. User enters coordinates (or geolocation),
sees a sky map, calibrates orientation using Polaris + one other bright star,
then can interactively navigate/hover over constellations.

Everything below is achievable statically (fits the current GitHub Pages /
vanilla-JS + Vite setup) because sky positions are pure math given
time + location, not a live-data feed.

## 1. Star/constellation data
Catalog (RA/Dec + magnitude for stars, line/boundary sets for constellations)
barely changes over human timescales — it's a static asset, not a backend.
- Bundle a trimmed catalog (bright stars only, mag < ~5, a few thousand
  entries + 88 constellation line sets) as JSON in the Vite build — tens of
  KB, trivial for a static site.
- Sources: Yale Bright Star Catalog / HYG database (stars), Stellarium's
  `constellationship.fab`-style data (lines) — both long-standing open
  datasets.

## 2. Coordinate math (the real engine)
Catalog gives fixed RA/Dec (equatorial); need Alt/Az (horizon-relative,
depends on lat/long/time) to know where a star actually is right now.
- **Roll your own**: standard spherical-astronomy formulas (local sidereal
  time → hour angle → alt/az). ~50-100 lines of trig, well documented, no
  dependency.
- **astronomy-engine** (MIT, pure JS/TS, no data files — algorithmic /
  VSOP87-based): computes star/planet/sun/moon positions, rise/set, etc.
  Fits a small hand-rolled app well since it's code, not a database.

## 3. Location
- `navigator.geolocation.getCurrentPosition` (needs HTTPS — already have via
  Pages) as the primary path.
- Manual lat/long entry as fallback/override (indoor testing, precise
  control).

## 4. Orientation + two-star calibration
`DeviceOrientationEvent` plumbing already exists (used for the servo gyro
joystick). Raw compass heading (magnetometer) is unreliable — magnetic
interference, no correction for magnetic declination, drifts indoors. This
is why real "point phone at sky" apps (SkyView, Star Walk) and telescopes
use manual star-alignment instead of trusting the compass — exactly what's
being asked for here.

Two-star calibration flow:
1. App computes true Alt/Az of Polaris (and a second bright, well-separated
   star — e.g. Vega/Capella/Sirius/Arcturus depending on season) for the
   user's location/time.
2. User points the phone at Polaris, taps confirm → capture raw
   device-orientation reading at that instant (pair 1: device vector ↔ true
   celestial vector).
3. Repeat for the second star (pair 2). Stars should be far apart in the sky
   (~60-90°+) for a well-conditioned solve.
4. From the two vector pairs, solve for the rotation offset between "device
   frame" and "true sky frame":
   - **TRIAD algorithm** — classic closed-form two-vector attitude solution,
     built for exactly this problem, cheap to implement.
   - **Simplified version**: assume the error is basically a constant
     heading (azimuth) bias plus maybe a tilt bias; average
     `reported_azimuth - true_azimuth` across the two stars instead of a
     full rotation solve. Less rigorous, much simpler, probably good enough
     for a hobby star finder.
5. Store the calibration transform in memory (or `localStorage` for
   in-session reuse) and apply it to every subsequent live orientation
   reading.

## 5. Rendering approach — two modes, pick one to start
- **Flat sky-chart / planetarium mode**: static 2D projected chart
  (stereographic/orthographic) you pan/zoom/tap, driven purely by
  lat/long/time — no device orientation needed. Simplest to build first,
  reuses none of the calibration complexity.
- **AR / "look through phone" mode**: continuously read calibrated
  orientation, recompute which patch of true sky is centered, render that —
  the payoff feature, depends on calibration being solid. Could optionally
  composite over camera feed (`getUserMedia`) for true AR, or just render on
  a plain background (simpler, still effective).
- Natural build order: flat chart first (validates math/rendering), then
  layer live orientation on top reusing the same projection code, re-centered
  each frame instead of fixed.

## 6. Interactivity ("hover around constellations")
- Track each rendered star/line's screen coordinates per frame; on pointer
  move/tap, nearest-neighbor search against stars/line segments within a
  pixel threshold → highlight that constellation's lines + show its name.
- Purely a rendering/hit-testing concern once the projection pipeline
  exists — Canvas 2D is enough, no need for WebGL at this data scale.

## 7. Build-vs-buy for the whole thing
- **Stellarium Web Engine (WASM)** — the real Stellarium C engine compiled
  to WASM. Extremely accurate/rich, but heavy (several MB) and harder to
  skin with custom calibration UI.
- **d3-celestial** — mid-weight, D3-based, decent constellation art, less
  actively maintained.
- **Hand-rolled (astronomy-engine + Canvas)** — most control, smallest
  footprint, most consistent with how this webapp is currently built
  (vanilla JS, no framework, hand-rolled DOM/canvas). More work, but the
  trigonometry is well-trodden and the calibration UX is custom regardless
  of library choice.

## Recommendation
Given the app's current style (small Vite/vanilla-JS bundle, no framework,
hand-rolled interactions like the trackpad), **hand-rolled astronomy-engine +
Canvas** fits best — everything else (geolocation, orientation, calibration
math, hit-testing) is custom logic on top regardless of which rendering
library is picked, so a heavier library mostly buys polish that would need
to be fought to restyle anyway.

Status: not started — this file captures options only, no implementation yet.
