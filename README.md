# Cursor stats

**Open-source**, cross-platform **system tray app** for [Cursor](https://cursor.com) — live usage, billing pace, pool breakdown, and per-model spend in a dashboard next to the tray. Built with **Electron**; ships **Windows**, **macOS**, and **Linux** installers via [electron-builder](https://www.electron.build/).

> **Unofficial.** This project is not affiliated with or endorsed by Cursor. It reads data from your Cursor account session the same way a browser would after you sign in.

## Install

| Windows | macOS | Linux |
|:-------:|:-----:|:-----:|
| [![Windows](https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/windows11/windows11-original.svg)](https://github.com/fontana-labs/cursor-stats/releases) | [![macOS](https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/apple/apple-original.svg)](https://github.com/fontana-labs/cursor-stats/releases) | [![Linux](https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/linux/linux-original.svg)](https://github.com/fontana-labs/cursor-stats/releases) |
| **[Download →](https://github.com/fontana-labs/cursor-stats/releases)** | **[Download →](https://github.com/fontana-labs/cursor-stats/releases)** | **[Download →](https://github.com/fontana-labs/cursor-stats/releases)** |
| NSIS **Setup** (`.exe`) or **portable** `.exe` | **DMG** or **ZIP** | **AppImage** or **deb** |

### From source

- **Node.js 20+** and npm
- Clone, install, run:

```bash
git clone https://github.com/fontana-labs/cursor-stats.git
cd cursor-stats
npm install
npm start
```

**Production bundles** land in `release/`:

| Command | Output |
|--------|--------|
| `npm run pack` | Unpacked app under `release/` (quick local test) |
| `npm run dist` | Installers for the **current** OS |
| `npm run dist:win` / `dist:mac` / `dist:linux` | One platform only |

## Contents

- [Install](#install)
- [Features](#features)
- [First run](#first-run)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Tray icon** — At-a-glance status; open the dashboard from the menu.
- **Month vs allowance pace** — Chart comparing usage to an even pace through the billing cycle (Auto + Composer, API pool, on-demand context).
- **Usage breakdown** — Donut-style pool usage, pacing hints, and cap warnings when data is available.
- **Models table** — Reference **$ / 1M tokens** and estimated **usage for the current cycle** using live Cursor docs pricing (scraped per load) and aggregated usage events.
- **Isolated session** — Uses a dedicated Electron partition (`persist:cursor-widget`) so Cursor web login cookies stay separate from your default browser profile.
- **Local history** — Append-only usage snapshots under the app’s user data directory for chart history (`usage-history.json`).

## First run

1. Launch **Cursor stats**; it appears in the system tray / menu bar.
2. If you are not signed in to Cursor in this app, use the **sign-in** flow when prompted (opens Cursor’s web login in a dedicated window).
3. Open the dashboard from the tray menu. Stats refresh on a timer; you can also trigger a refresh from the UI when available.

Data comes from Cursor’s dashboard and APIs while you are logged in. If Cursor changes their site or APIs, some panels may need an app update.

## Screenshots

### System Tray

![Cursor stats main window: allowance pace chart, pool usage, and per-model costs](./docs/Screenshot%202026-04-28%20at%2016.55.30.png)

### Stats Panel

![Cursor stats dashboard showing month vs allowance pace and usage breakdown](./docs/Screenshot%202026-04-28%20at%2017.43.44.png)

![Cursor stats dashboard with models pricing and usage table](./docs/Screenshot%202026-04-28%20at%2017.43.48.png)

## How it works

The **main process** loads Cursor spending/billing pages in hidden windows, parses embedded `__NEXT_DATA__` and related text, and combines that with authenticated `fetch` calls (`/api/auth/me`, billing and usage endpoints). Results are merged, optionally written to local history, and pushed to the **renderer** over IPC. The **preload** script exposes a small `window.cursorWidget` API so the HTML dashboard stays sandboxed.

For module-level detail, IPC channels, and packaging notes, see **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

## Development

- **Run:** `npm start`
- **Style:** Match nearby code (CommonJS, existing JSDoc). Avoid unrelated refactors and unnecessary dependencies.
- **PRs:** Keep changes focused; confirm `npm start` still runs. If you change packaging or `build.files`, verify `npm run pack`.

Full guidelines: **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Repository layout

| Path | Role |
|------|------|
| `src/main/index.js` | Main process: tray, windows, refresh loop, IPC |
| `src/main/preload.js` | `contextBridge` → `window.cursorWidget` |
| `src/main/lib/` | Parsing, session/HTTP, tray image, history |
| `src/main/lib/model-pricing-fetch.js` | Live scrape of Cursor docs pricing each time (no cache) |
| `src/renderer/dashboard.html` | Dashboard UI (`file://`) |

## Documentation

| Doc | Purpose |
|-----|---------|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Runtime layout, data flow, IPC, adding code |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Setup, packaging, PR expectations |
| [SECURITY.md](./SECURITY.md) | Reporting vulnerabilities, scope, user hardening |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Contributor Covenant |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |

## Security

Report security issues **privately** per **[SECURITY.md](./SECURITY.md)** (GitHub Security Advisories preferred). Install from **[GitHub Releases](https://github.com/fontana-labs/cursor-stats/releases)** or source you trust.

## Contributing

Issues and PRs are welcome. See **[CONTRIBUTING.md](./CONTRIBUTING.md)** and the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © cursor-stats contributors.

---

Made by **[Fontana Labs](https://github.com/fontana-labs)** · [Issues](https://github.com/fontana-labs/cursor-stats/issues)
