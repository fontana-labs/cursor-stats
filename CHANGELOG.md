# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-01

### Client

- Usage pace warnings now show an expected allowance runout date with ordinal day/month copy and reset-relative timing.
- Month vs allowance chart now draws color-matched dashed runout projections for Auto + Composer and API usage when either pool is ahead of pace.
- Runout projections now use actual elapsed billing time, so over-pace warnings no longer predict runout after reset or show misleading API dashes when API usage is under pace.
- Footer credit spacing and label order are adjusted for cleaner alignment.

## [0.1.5] - 2026-04-29

### Client

- Packaged app checks GitHub Releases for a newer version than the running build and shows an **info banner** on the dashboard with a **Download** link (opens the release page in the browser). Skips the check in development; caches the result for 24 hours.

## [0.1.4] - 2026-04-28

### Changed

- README **Install** table: Windows, macOS, and Linux icons use fixed **40×40** HTML `<img>` tags so SVGs from jsDelivr no longer render at intrinsic (oversized) dimensions.

### Fixed

- **Linux CI:** `linux.artifactName` uses literal **`cursor-stats-${version}-${arch}.${ext}`** — **`${executableName}`** is not a supported macro in that electron-builder template.

## [0.1.3] - 2026-04-28

### Client

- Packaged **executable / installer basename** is **`cursor-stats`**; window title and branding stay **Cursor stats**. Linux **AppImage** and **deb** use flat names under **`release/`** (no scoped `@fontana-labs/` path segment).

### Fixed

- **Linux deb** on CI: **fpm** no longer targets a missing **`release/@fontana-labs/...`** directory when **`package.json` `name`** is scoped — **`executableName`** plus **`linux.artifactName`** control outputs.
- **Windows** release builds: electron-builder no longer demands **`GH_TOKEN`** mid-**`dist:win`**; **`publish`: `null`** defers uploads to **GitHub Actions** (**`softprops/action-gh-release`**).

### Removed

- **`.github/workflows/ci.yml`** — packaging is already exercised by the **Release** workflow on every **`main`** push.

## [0.1.2] - 2026-04-28

### Added

- Cursor custom command **`logthis`** (`.cursor/commands/logthis.md`) for release-style changelog and semver updates, aligned with Fontana sibling repos.

## [0.1.1] - 2026-04-28

### Client

- README **Install** section is a compact three-column table with release links; removed the extra “prebuilt binaries” sentence above it.

### Changed

- **Release** workflow runs on every push to `main`, publishes installers under tag `v<version>-build.<run_number>`, queues concurrent runs, and marks the new GitHub release as latest.
- Linux **deb** packaging: `package.json` **author** includes **email** (electron-builder maintainer field); contact set to **admin@fontana-ai.com**.

## [0.1.0] - 2026-04-27

### Added

- Initial open-source release: Electron tray app for Cursor spending, billing, and usage views
- Cross-platform packaging via electron-builder (macOS, Windows, Linux)
- GitHub Actions workflows for CI and releases on push to `main`

[0.2.0]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.5]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.4]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.3]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.2]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.1]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.0]: https://github.com/fontana-labs/cursor-stats/releases/tag/v0.1.0
