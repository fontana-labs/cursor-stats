/**
 * Tray image: centered billing-cycle pie (semi-transparent) under API / Cursor rings + two text lines.
 * Wider bitmap; OS scales to menu-bar height (~22pt on macOS). Very wide images may clip.
 * @see docs/ARCHITECTURE.md
 */

const zlib = require("zlib");
const { nativeImage } = require("electron");

let crcTable;

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (~c) >>> 0;
}

function pngChunk(typeStr, data) {
  const type = Buffer.from(typeStr, "ascii");
  const body = Buffer.concat([type, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePngRgba(rgba, width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
      raw[o++] = rgba[i + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** 5×7 patterns, '1' = pixel */
const GLYPH = {
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "%": ["11001", "11001", "00010", "00100", "01000", "11001", "11001"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "c": ["00000", "00000", "01111", "10000", "10000", "10000", "01111"],
  "e": ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  "l": ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  "o": ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  "p": ["00000", "00000", "11110", "10001", "11110", "10000", "10000"],
  "r": ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  "s": ["00000", "00000", "01111", "10000", "01110", "00001", "11110"],
  "u": ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
};

function drawGlyph(rgba, W, H, x0, y0, ch, rgb, scale) {
  const pat = GLYPH[ch];
  if (!pat) return 0;
  const [r, g, b] = rgb;
  const gw = pat[0].length;
  const gh = pat.length;
  for (let row = 0; row < gh; row++) {
    const line = pat[row];
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== "1") continue;
      const x1 = Math.round(x0 + col * scale);
      const y1 = Math.round(y0 + row * scale);
      const x2 = Math.round(x0 + (col + 1) * scale);
      const y2 = Math.round(y0 + (row + 1) * scale);
      for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = (y * W + x) * 4;
          rgba[i] = r;
          rgba[i + 1] = g;
          rgba[i + 2] = b;
          rgba[i + 3] = 255;
        }
      }
    }
  }
  return Math.round(gw * scale + scale);
}

function drawLabel(rgba, W, H, x0, y0, text, rgb, scale) {
  let x = x0;
  for (const ch of text) {
    const w = drawGlyph(rgba, W, H, x, y0, ch, rgb, scale);
    x += w;
  }
}

function measureLabelWidth(text, scale) {
  let x = 0;
  for (const ch of text) {
    const pat = GLYPH[ch];
    if (!pat) continue;
    const gw = pat[0].length;
    x += Math.round(gw * scale + scale);
  }
  return x;
}

/** Bitmap glyph scale for tray labels (two lines only — room for readable size). */
const TRAY_TEXT_SCALE = 2;

function drawUsageLabel(rgba, W, H, x0, y0, pct, name, rgb) {
  const s = TRAY_TEXT_SCALE;
  const pctText = formatPct(pct);
  const gap = Math.round(2 * s);
  drawLabel(rgba, W, H, x0, y0, pctText, rgb, s);
  const nameX = x0 + measureLabelWidth(pctText, s) + gap;
  drawLabel(rgba, W, H, nameX, y0, name, rgb, s);
}

function blendPixel(rgba, i, r, g, b, a) {
  if (a <= 0) return;
  const da = rgba[i + 3];
  if (da === 0) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
    return;
  }
  const inv = 255 - a;
  rgba[i] = Math.round((r * a + rgba[i] * inv) / 255);
  rgba[i + 1] = Math.round((g * a + rgba[i + 1] * inv) / 255);
  rgba[i + 2] = Math.round((b * a + rgba[i + 2] * inv) / 255);
  rgba[i + 3] = Math.min(255, a + Math.round((da * inv) / 255));
}

function drawAnnulusArcRect(
  rgba,
  W,
  x0,
  y0,
  x1,
  y1,
  cx,
  cy,
  rInner,
  rOuter,
  frac,
  rgb,
  rotation = 0,
  opacity = 255,
) {
  const [r, g, b] = rgb;
  const sweep = clamp01(frac) * 2 * Math.PI;
  if (sweep <= 0) return;
  const a = Math.max(0, Math.min(255, Math.round(opacity)));
  const rot = ((rotation % 1) + 1) % 1 * 2 * Math.PI;
  const ri = rInner * rInner;
  const ro = rOuter * rOuter;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < ri || d2 > ro) continue;
      const ang = Math.atan2(dy, dx);
      const t = (ang + Math.PI / 2 - rot + 2 * Math.PI) % (2 * Math.PI);
      if (t <= sweep + 1e-6) {
        const i = (y * W + x) * 4;
        blendPixel(rgba, i, r, g, b, a);
      }
    }
  }
}

const MAIN_RING_BOX = 42;
const TEXT_GAP = 6;
/** Billing cycle wedge opacity (more transparent ≈ lower value). */
const CYCLE_PIE_OPACITY = 88;

/** Cycle pie centered in chart, then API / Cursor rings on top (opaque). */
function drawUsageChart(rgba, W, offX, box, stats, rotation = 0) {
  const ok = stats && stats.ok !== false;
  const apiFrac =
    ok && stats.apiPercent != null && Number.isFinite(stats.apiPercent)
      ? clamp01(stats.apiPercent / 100)
      : null;
  const autoFrac =
    ok && stats.autoPercent != null && Number.isFinite(stats.autoPercent)
      ? clamp01(stats.autoPercent / 100)
      : null;
  const cycleFrac =
    ok && stats.cyclePercent != null && Number.isFinite(stats.cyclePercent)
      ? clamp01(stats.cyclePercent / 100)
      : null;
  const isRefreshing = rotation > 0;

  const cx = offX + box / 2;
  const cy = box / 2;
  const x0 = offX;
  const y0 = 0;
  const x1 = offX + box;
  const y1 = box;

  const apiRgb = [147, 197, 253];
  const autoRgb = [196, 181, 253];
  const cycleRgb = [156, 163, 175];

  if (cycleFrac != null && cycleFrac > 0) {
    /* Outer edge = inscribed circle of the chart square (same extent as the chart). */
    const cycleOuterR = box / 2;
    drawAnnulusArcRect(
      rgba,
      W,
      x0,
      y0,
      x1,
      y1,
      cx,
      cy,
      0,
      cycleOuterR,
      cycleFrac,
      cycleRgb,
      rotation,
      CYCLE_PIE_OPACITY,
    );
  }

  if (apiFrac != null && apiFrac > 0) {
    drawAnnulusArcRect(rgba, W, x0, y0, x1, y1, cx, cy, box * 0.34, box * 0.46, apiFrac, apiRgb, rotation);
  } else if (isRefreshing) {
    drawAnnulusArcRect(rgba, W, x0, y0, x1, y1, cx, cy, box * 0.34, box * 0.46, 0.18, cycleRgb, rotation);
  }

  if (autoFrac != null && autoFrac > 0) {
    drawAnnulusArcRect(rgba, W, x0, y0, x1, y1, cx, cy, box * 0.19, box * 0.28, autoFrac, autoRgb, rotation);
  }
}

function formatPct(n) {
  if (n == null || !Number.isFinite(n)) return "--%";
  const v = Math.round(Math.max(0, Math.min(999, n)));
  return `${v}%`;
}

/**
 * @param {object | null} stats
 * @param {{ rotation?: number }} [opts]
 */
function trayImageFromStats(stats, opts = {}) {
  const chartW = MAIN_RING_BOX;
  const textX = chartW + TEXT_GAP;
  const lineH = Math.round(7 * TRAY_TEXT_SCALE);
  const lineGap = 4;
  const textBlockH = lineH * 2 + lineGap;
  const H = Math.max(MAIN_RING_BOX, textBlockH);
  const textY0 = Math.max(0, Math.floor((H - textBlockH) / 2));

  const maxLabel = "100% Cursor";
  const W = Math.min(230, textX + measureLabelWidth(maxLabel, TRAY_TEXT_SCALE) + 8);

  const rgba = Buffer.alloc(W * H * 4, 0);
  const rotation = Number.isFinite(opts.rotation) ? opts.rotation : 0;

  drawUsageChart(rgba, W, 0, MAIN_RING_BOX, stats, rotation);

  const autoRgb = [196, 181, 253];
  const apiRgb = [147, 197, 253];

  drawUsageLabel(rgba, W, H, textX, textY0, stats?.autoPercent, "Cursor", autoRgb);
  drawUsageLabel(rgba, W, H, textX, textY0 + lineH + lineGap, stats?.apiPercent, "API", apiRgb);

  const png = encodePngRgba(rgba, W, H);
  const scaleFactor = process.platform === "darwin" ? 2 : 1;
  return nativeImage.createFromBuffer(png, { scaleFactor });
}

module.exports = { trayImageFromStats };
