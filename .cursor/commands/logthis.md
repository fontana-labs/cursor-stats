# LOGTHIS Command

## Description

When the user types **`LOGTHIS`** (or runs this command from the palette), record a **release-style** update: summarize the session, bump **`package.json`** semver if needed, append **`CHANGELOG.md`**, then stage and commit. Same workflow intent as the sibling [Fontana](https://github.com/fontana-labs) repos’ `logthis` command, tailored to this project (single root package, Electron tray app).

## What to Do

1. **Respond with**: `🫡 Cursor stats: CREATING CHANGELOG! 🫡`
2. **Review** the changes in this session: fix obvious issues in files you touched; ensure user-facing behavior matches intent.
3. **Summarize** session achievements in short, factual bullets (what shipped, not process narration).
4. **Version bump** — authoritative source is **root** `package.json` (`version` field). Choose bump from the nature of the work:
   - **Patch** (`x.x.X`): bug fixes, docs-only, internal refactors with no user-visible change
   - **Minor** (`x.X.x`): new features, enhancements (backward compatible)
   - **Major** (`X.x.x`): breaking changes, incompatible API or behavior
5. **Update** `CHANGELOG.md`:
   - Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (already used in this repo).
   - Add a dated section `## [<version>] - YYYY-MM-DD` under `## [Unreleased]` content **or** move items from `[Unreleased]` into the new version block—**keep** an empty or minimal `[Unreleased]` after release prep, per project convention.
   - **Order**: newest version sections near the top (below `[Unreleased]` if present).
   - **`### Client`**: When changes affect the tray app UI, installers, or user-visible behavior, add a `### Client` subsection with one-line user-facing bullets (plain language, no Conventional Commit type prefixes).
   - Update the compare link at the bottom if the project uses release URL footers (match existing `CHANGELOG.md` style).
6. **Git — staging rule**: If the working tree has **unrelated** edits (other WIP or agents), **`git add` only** paths that belong to this session’s deliverable plus `CHANGELOG.md` and `package.json`. Use explicit paths or `git add -p`; do **not** `git add .` unless the user asked to commit everything. If the tree is clean and only session files changed, staging all touched files is fine.
7. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/) **and** a leading emoji (match recent project style), e.g. `📝 chore(release): v0.1.1` or `✨ feat(tray): …`.
8. **Push** only if the user asked to push or release; otherwise stop after commit and state what’s staged/committed.

## Idempotency

Do not duplicate the same release entry for the same logical change set. If `CHANGELOG.md` already documents this version or the same bullets for the current commit, skip re-appending.

## Usage

Type **`LOGTHIS`** in chat or run **“logthis”** from Cursor’s custom commands.

## Note

This repo does not use Fontana MiniSpec/MegaSpec files; there is no `docs/specs/` requirement here. If specs are added later, you may still use **`LOGTHIS`** after closeout using those docs as the achievement list, plus the rules above.
