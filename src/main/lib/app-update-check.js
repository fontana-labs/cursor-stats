/**
 * Compare published GitHub release tag to app version; used for “update available” UI.
 */

const fs = require("fs");
const https = require("https");
const path = require("path");

const OWNER = "fontana-labs";
const REPO = "cursor-stats";
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
/** User-facing downloads page — always resolves to newest release assets. */
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_MS = 12000;

let memoryCache = { at: 0, result: null };

/**
 * Strip leading `v` and compare X.Y.Z (ignores prerelease suffix on patch).
 * @returns {-1 | 0 | 1}
 */
function compareSemver(tagA, tagB) {
  const norm = (t) =>
    String(t || "")
      .trim()
      .replace(/^v/i, "")
      .split(/[+\s]/)[0];
  const parts = (s) => {
    const m = norm(s).match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parts(tagA);
  const b = parts(tagB);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function isLatestNewerThanCurrent(latestTag, currentVersion) {
  return compareSemver(currentVersion, latestTag) === -1;
}

function fetchLatestReleaseOnce() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      RELEASES_API,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "cursor-stats-update-check",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub releases returned ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_MS, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function readDiskCache(userData) {
  try {
    const p = path.join(userData, "update-check-cache.json");
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.checkedAt === "number" && j.result && typeof j.result === "object") {
      return j;
    }
  } catch (_e) {
    /* missing or corrupt */
  }
  return null;
}

function writeDiskCache(userData, checkedAt, result) {
  try {
    const p = path.join(userData, "update-check-cache.json");
    fs.writeFileSync(p, JSON.stringify({ checkedAt, result }), "utf8");
  } catch (e) {
    console.error("app-update-check: cache write failed:", e);
  }
}

/**
 * @param {import('electron').App} app
 * @param {{ force?: boolean }} [opts]
 */
async function checkForAppUpdate(app, opts = {}) {
  const currentVersion = app.getVersion();
  const base = {
    ok: true,
    checked: false,
    currentVersion,
    updateAvailable: false,
  };

  if (!app.isPackaged) {
    return { ...base, skippedReason: "development" };
  }

  const force = opts.force === true;
  const now = Date.now();
  const userData = app.getPath("userData");

  if (!force && memoryCache.result && now - memoryCache.at < CACHE_TTL_MS) {
    return { ...memoryCache.result, currentVersion };
  }

  const disk = !force ? readDiskCache(userData) : null;
  if (disk && now - disk.checkedAt < CACHE_TTL_MS) {
    memoryCache = { at: now, result: disk.result };
    return { ...disk.result, currentVersion };
  }

  try {
    /** @type {{ tag_name?: string, html_url?: string }} */
    const rel = await fetchLatestReleaseOnce();
    const tag = rel.tag_name || "";
    const cmp = isLatestNewerThanCurrent(tag, currentVersion);
    let releasePage = RELEASES_PAGE;
    if (
      typeof rel.html_url === "string" &&
      /^https:\/\/github\.com\/fontana-labs\/cursor-stats/i.test(rel.html_url)
    ) {
      releasePage = rel.html_url;
    }

    const result = {
      ok: true,
      checked: true,
      currentVersion,
      updateAvailable: cmp,
      latestVersion: tag.replace(/^v/i, "") || null,
      latestTag: tag || null,
      releaseUrl: releasePage,
    };

    memoryCache = { at: now, result };
    writeDiskCache(userData, now, result);
    return result;
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    console.warn("app-update-check:", errText);
    const result = {
      ok: false,
      checked: true,
      currentVersion,
      updateAvailable: false,
      error: errText,
    };
    return result;
  }
}

module.exports = {
  checkForAppUpdate,
  compareSemver,
  isLatestNewerThanCurrent,
  RELEASES_PAGE,
};
