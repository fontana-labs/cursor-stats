# Contributing

Thanks for helping improve Cursor stats. This project is small and informal; the guidelines below keep reviews predictable.

## Prerequisites

- Node.js **20** or newer
- npm
- A Cursor account if you want to exercise the live dashboard flows

## Getting started

```bash
git clone https://github.com/fontana-labs/cursor-stats.git
cd cursor-stats
npm install
npm start
```

## Project layout

Source code is grouped under **`src/`** so the repo root stays clean for config and docs.

| Path | Role |
|------|------|
| `src/main/index.js` | Electron main process entry: tray, windows, refresh loop, IPC |
| `src/main/preload.js` | IPC bridge exposed to the dashboard (`window.cursorWidget`) |
| `src/main/lib/*.js` | Main-only helpers: parsing, session/HTTP, tray image, local history |
| `src/renderer/dashboard.html` | Renderer UI (loaded as `file://`) |

For IPC boundaries and module responsibilities, read **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

## Packaging

Do not edit generated output under `release/`. To verify a production bundle locally:

```bash
npm run pack    # unpacked app under release/
npm run dist    # installers for your current OS
```

`package.json` → `build.files` includes `src/**/*`. If you add assets **outside** `src/`, extend `build.files` so electron-builder packs them.

## Code style

- Match existing patterns in nearby files (CommonJS `require`, JSDoc where already used).
- Avoid drive-by refactors unrelated to your change.
- No new dependencies unless there is a clear need; prefer the standard library and Electron APIs.

## Pull requests

1. Open an issue first for large or ambiguous changes.
2. Keep commits focused; describe **what** changed and **why** in the PR body.
3. Confirm `npm start` still runs and, if you touched packaging, `npm run pack` succeeds.

## Code of conduct

All participants are expected to follow the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).
