# CEE 3rd Sem Timetable — PWA

An installable, offline-capable timetable for Civil & Environmental Engineering,
3rd semester (Autumn 2026), including the reserved 2–3 PM HSS elective slot.

```
index.html              the app
manifest.webmanifest    app name, icons, colours, standalone display
sw.js                   service worker (offline app shell)
icons/                  192 / 512 / maskable / apple-touch / favicon
```

## Why it needs hosting

Service workers and install prompts only work over `https://` (or `localhost`).
Opening `index.html` straight from disk still shows the timetable, but it will
not install or cache. Put the folder on any static host.

## Option 1 — GitHub Pages (free, permanent URL)

1. Create a repository, e.g. `cee-timetable`.
2. Upload the **contents** of this folder to the repo root.
3. Settings → Pages → Source: `main`, folder `/root` → Save.
4. Open `https://<username>.github.io/cee-timetable/`.

## Option 2 — Netlify Drop (fastest, no account needed)

1. Go to <https://app.netlify.com/drop>.
2. Drag this whole folder onto the page.
3. Use the `https://…netlify.app` URL it gives you.

## Option 3 — Test locally

```bash
cd path/to/this/folder
python3 -m http.server 8080
# open http://localhost:8080
```

## Installing it

- **Android / Chrome / Edge:** tap the **Install app** button in the header, or
  browser menu → *Install app* / *Add to Home screen*.
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*. iOS has no install
  button, so the header button stays hidden — this is expected.
- **Desktop Chrome / Edge:** install icon in the address bar.

After the first load the app works with no internet. Your selected HSS elective
is saved on the device.

## Editing the schedule

All data lives in two arrays near the top of the `<script>` in `index.html`:

- `CORE` — core CE classes: `{d: dayIndex 0=Mon, s: "HH:MM", e: "HH:MM", c: code, f: faculty, r: room, t: "Lecture"|"Tutorial"|"Lab"}`
- `HSS` — electives: `{code, name, days:{dayIndex: room}}`

After editing, bump `VERSION` in `sw.js` (e.g. `cee-tt-v2`) so devices pick up
the change; the app will show a “new version is ready” prompt.

## Course names

Course titles live in the `NAMES` map near the top of the `<script>` in `index.html`:

    CE2101 Geomatics Engineering
    CE2102 Structural Mechanics
    CE2103 Fluid Mechanics
    CE2104 Geology for Engineers

Cards show the course name as the heading with the code underneath. Lab and
Tutorial sessions reuse the parent course name and are distinguished by their tag.
HSS names live in the `HSS` array (`name` is shown on the card, `short` on the button).
