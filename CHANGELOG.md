# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.1.2]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.1]: https://github.com/fontana-labs/cursor-stats/releases
[0.1.0]: https://github.com/fontana-labs/cursor-stats/releases/tag/v0.1.0
