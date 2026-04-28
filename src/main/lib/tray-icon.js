/**
 * Tray image: dual rings (API outer, Auto inner) + stacked % labels.
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
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = x0 + col * scale + sx;
          const y = y0 + row * scale + sy;
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
  return gw * scale + scale;
}

function drawLabel(rgba, W, H, x0, y0, text, rgb, scale) {
  let x = x0;
  for (const ch of text) {
    const w = drawGlyph(rgba, W, H, x, y0, ch, rgb, scale);
    x += w;
  }
}

function drawAnnulusArcRect(rgba, W, x0, y0, x1, y1, cx, cy, rInner, rOuter, frac, rgb) {
  const [r, g, b] = rgb;
  const sweep = clamp01(frac) * 2 * Math.PI;
  if (sweep <= 0) return;
  const ri = rInner * rInner;
  const ro = rOuter * rOuter;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < ri || d2 > ro) continue;
      const ang = Math.atan2(dy, dx);
      const t = (ang + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
      if (t <= sweep + 1e-6) {
        const i = (y * W + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    }
  }
}

/** Light arcs only — no filled “track” ring (transparent against macOS menu bar). */
function drawRingsInBox(rgba, W, box, stats) {
  const ok = stats && stats.ok !== false;
  const apiFrac =
    ok && stats.apiPercent != null && Number.isFinite(stats.apiPercent)
      ? clamp01(stats.apiPercent / 100)
      : null;
  const autoFrac =
    ok && stats.autoPercent != null && Number.isFinite(stats.autoPercent)
      ? clamp01(stats.autoPercent / 100)
      : null;

  const cx = box / 2;
  const cy = box / 2;
  const x0 = 0;
  const y0 = 0;
  const x1 = box;
  const y1 = box;

  const apiRgb = [147, 197, 253];
  const autoRgb = [196, 181, 253];

  if (apiFrac != null && apiFrac > 0) {
    drawAnnulusArcRect(rgba, W, x0, y0, x1, y1, cx, cy, box * 0.34, box * 0.46, apiFrac, apiRgb);
  }

  if (autoFrac != null && autoFrac > 0) {
    drawAnnulusArcRect(rgba, W, x0, y0, x1, y1, cx, cy, box * 0.19, box * 0.28, autoFrac, autoRgb);
  }
}

function formatPct(n) {
  if (n == null || !Number.isFinite(n)) return "--%";
  const v = Math.round(Math.max(0, Math.min(999, n)));
  return `${v}%`;
}

/**
 * @param {object | null} stats
 */
function trayImageFromStats(stats) {
  const box = 42;
  const textX = box + 6;
  const W = 118;
  const H = 44;
  const rgba = Buffer.alloc(W * H * 4, 0);

  drawRingsInBox(rgba, W, box, stats);

  const autoRgb = [196, 181, 253];
  const apiRgb = [147, 197, 253];
  const scale = 2;
  const line1 = formatPct(stats?.autoPercent);
  const line2 = formatPct(stats?.apiPercent);

  drawLabel(rgba, W, H, textX, 6, line1, autoRgb, scale);
  drawLabel(rgba, W, H, textX, 24, line2, apiRgb, scale);

  const png = encodePngRgba(rgba, W, H);
  const scaleFactor = process.platform === "darwin" ? 2 : 1;
  return nativeImage.createFromBuffer(png, { scaleFactor });
}

module.exports = { trayImageFromStats };
