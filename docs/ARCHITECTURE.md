# Architecture

Cursor stats is a **single-package Electron app**: one main process, one preload, one HTML renderer, and CommonJS modules bundled into the packaged app via `electron-builder`.

## Runtime layout

| Path | Process | Role |
|------|---------|------|
| [src/main/index.js](../src/main/index.js) | Main | Entry point: tray, window lifecycle, refresh orchestration, `ipcMain` handlers |
| [src/main/preload.js](../src/main/preload.js) | Preload | `contextBridge` → `window.cursorWidget` for safe IPC from the UI |
| [src/renderer/dashboard.html](../src/renderer/dashboard.html) | Renderer | Dashboard UI (no Node integration) |
| [src/main/lib/](../src/main/lib/) | Main (required) | Parsing, HTTP/session helpers, tray pixmap logic |
| [src/main/lib/model-pricing-fetch.js](../src/main/lib/model-pricing-fetch.js) | Main | Loads [Models & pricing](https://cursor.com/docs/models-and-pricing) in a hidden window every resolve (no disk/memory cache). Deletes legacy `model-pricing-cache.json` if present. Logs **`[model-pricing]`** |

Packaging includes everything under `src/**` plus `package.json` (see `build.files` in `package.json`).

## Data flow

1. **Session:** The app uses a fixed Electron session partition (`persist:cursor-widget`) so cookies from Cursor’s web login are isolated from your default browser but shared across hidden windows and the optional sign-in window.
2. **Refresh loop:** The main process loads Cursor spending/billing pages in hidden `BrowserWindow`s, scrapes `#__NEXT_DATA__` and `innerText`, and merges results with `/api/auth/me`, billing APIs, and usage-event endpoints (see `cursor-session.js`).
3. **UI:** The dashboard loads as `file://` HTML; the preload exposes `getChartData`, `onStats`, etc., so the page stays sandboxed while still receiving live updates.

## Main-process modules (`src/main/lib/`)

| Module | Responsibility |
|--------|----------------|
| **billing-period.js** | Derives billing cycle bounds (current day index, period end label) from parsed spending stats |
| **cursor-session.js** | `net`/`session` requests with cookies; auth probe; hidden-window fetches for usage APIs |
| **parse-spending.js** | Normalizes the spending dashboard scrape into `autoPercent`, `apiPercent`, login state, etc. |
| **parse-billing-breakdown.js** | Extracts Auto vs API pie slices from billing `__NEXT_DATA__` |
| **parse-current-period-usage.js** | Parses `get-current-period-usage` JSON (on-demand spend, limits) |
| **usage-event-extract.js** | Pulls event arrays from varied API/JSON shapes |
| **usage-events-aggregate.js** | Paginates filtered usage events and builds time-series for the chart |
| **usage-history.js** | Append-only style history file (`usage-history.json` in `userData`) |
| **tray-icon.js** | Builds `nativeImage` for the tray from current usage stats |

## IPC contract (preload ↔ main)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `cursor:sign-in` | invoke | Open sign-in window |
| `cursor:refresh-stats` | invoke | Full refresh; pushes to open dashboard |
| `cursor:get-pricing` | invoke | Fresh docs scrape each call (**`ok: false`** if scrape fails; **`meta.source`: `live`** when ok) |
| `cursor:last-stats` / `cursor:get-chart-data` / `cursor:get-session` | invoke | Snapshot for UI |
| `cursor:open-external` | invoke | `shell.openExternal` for `https:` only |
| `cursor:stats` / `cursor:chart` / `cursor:session` / `cursor:login-closed` | main → renderer | Push updates |

## Adding code

- New main-only modules belong in `src/main/lib/` and are imported from `index.js` or other lib files.
- If you add files outside `src/`, update `package.json` → `build.files` so installers still contain them.
- Renderer assets stay under `src/renderer/`; load them with `path.join(__dirname, "..", "renderer", …)` from the main process.
