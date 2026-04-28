# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Moved application sources under `src/` (`src/main`, `src/renderer`) and documented layout in `docs/ARCHITECTURE.md`
- Main process entry is now `src/main/index.js` (`package.json` `"main"`)
- **Release** workflow runs on every push to `main` and publishes installers with tag `v<version>-build.<run_number>` (from `package.json` + GitHub Actions run id)

## [0.1.0] - 2026-04-27

### Added

- Initial open-source release: Electron tray app for Cursor spending, billing, and usage views
- Cross-platform packaging via electron-builder (macOS, Windows, Linux)
- GitHub Actions workflows for CI and releases on push to `main`

[0.1.0]: https://github.com/fontana-labs/cursor-stats/releases/tag/v0.1.0
