# Security policy

## Supported versions

Only the **latest release** on the default branch receives security fixes when practical. This is a small volunteer-maintained project; if you need long-term support for older versions, consider maintaining a fork.

## Reporting a vulnerability

**Please do not open a public GitHub issue** for undisclosed security problems.

Instead:

1. Open a **private security advisory** on GitHub (Repository → **Security** → **Advisories** → **Report a vulnerability**), or  
2. Email the maintainer if they publish a contact address on their GitHub profile.

Include:

- A short description of the issue and its impact
- Steps to reproduce (or a proof of concept), if safe to share
- Affected version or commit, if known

We aim to acknowledge reports within a few days. Fixes are coordinated before public disclosure when possible.

## Scope

In scope:

- This repository’s application code (Electron main/preload/renderer)
- Packaging and CI configuration that could lead to compromised installs

Out of scope:

- Social engineering of Cursor’s official services
- Issues in upstream Electron, Node.js, or operating systems (report those to their respective projects)
- The security posture of cursor.com or third-party APIs beyond what this app intentionally calls

## Hardening notes for users

- Install only from **official releases** in this repository’s GitHub Releases or from source you have audited.
- The app uses an Electron **partitioned session** to read Cursor dashboard data; treat the machine account as sensitive, as with any desktop app that can access browser-like sessions.
