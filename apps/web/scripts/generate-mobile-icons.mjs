// Generates the Orison phone app icons and in-app brand mark (PNG) into public/m-app/.
// Run: node apps/web/scripts/generate-mobile-icons.mjs
//
// Source: apps/web/assets/orison-logo.png, the company logo as supplied (black line-art windmill
// on the left, the ORISON wordmark on the right, transparent background). Only the windmill is
// used: it is found automatically (the ink left of the first wide empty gap), cropped tightly,
// recoloured gold and placed on the app's navy. The mark itself is never redrawn: every output
// pixel is an area-average of the source artwork's coverage.
//
// No dependencies (PNG decode/encode with node:zlib), so it runs anywhere Node runs. The PNGs it
// writes are committed; nothing here runs at build time.
//
// Optional: ORISON_ICON_PREVIEW_DIR=/some/dir also writes the Home Screen icon downscaled to the
// sizes iOS shows it at (60 and 120 px), for checking that the sail detail survives.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "..", "assets", "orison-logo.png");
const outDir = path.join(here, "..", "public", "m-app");
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------
// PNG encode / decode (8-bit RGBA / RGB / grey, non-interlaced: enough for the supplied logo)

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error(`Unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  // Ink coverage 0..1: opaque dark pixels are ink. Transparent pixels and (should the artwork
  // ever arrive on a white ground) light pixels are not.
  const coverage = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const grey = channels >= 3 ? (pixels[p] * 0.2126 + pixels[p + 1] * 0.7152 + pixels[p + 2] * 0.0722) / 255 : pixels[p] / 255;
    const alpha = channels === 4 ? pixels[p + 3] / 255 : channels === 2 ? pixels[p + 1] / 255 : 1;
    coverage[i] = alpha * (1 - grey);
  }
  return { width, height, coverage };
}

// ---------------------------------------------------------------------------------------------
// Find the windmill: the ink left of the first wide empty column gap (the wordmark is right of it).

function findWindmill(src) {
  const { width, height, coverage } = src;
  const inkThreshold = 0.08;
  const columnHasInk = (x) => {
    for (let y = 0; y < height; y++) if (coverage[y * width + x] > inkThreshold) return true;
    return false;
  };
  let x0 = 0;
  while (x0 < width && !columnHasInk(x0)) x0++;
  const minGap = Math.max(12, Math.round(width * 0.015));
  let x1 = x0;
  let empty = 0;
  for (let x = x0; x < width; x++) {
    if (columnHasInk(x)) {
      x1 = x;
      empty = 0;
    } else if (++empty >= minGap) {
      break;
    }
  }
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = x0; x <= x1; x++) {
      if (coverage[y * width + x] > inkThreshold) {
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        break;
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) throw new Error("Could not find the windmill in the logo");
  // Bounding box in source pixel edges.
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Bilinear coverage at a continuous source position (pixel centres at +0.5), 0 outside the box.
function sampler(src, box) {
  const { width, coverage } = src;
  const at = (x, y) =>
    x < box.x || y < box.y || x >= box.x + box.w || y >= box.y + box.h ? 0 : coverage[y * width + x];
  return (sx, sy) => {
    const fx = sx - 0.5;
    const fy = sy - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    return (
      at(ix, iy) * (1 - tx) * (1 - ty) +
      at(ix + 1, iy) * tx * (1 - ty) +
      at(ix, iy + 1) * (1 - tx) * ty +
      at(ix + 1, iy + 1) * tx * ty
    );
  };
}

/**
 * Render the windmill's coverage into a width x height grid. `markHeight` is the windmill's
 * height in output pixels; it is centred on (cx, cy). Each output pixel averages n x n bilinear
 * taps over its footprint (an area average when shrinking, smooth when enlarging).
 */
function renderCoverage(src, box, width, height, { markHeight, cx = width / 2, cy = height / 2 }) {
  const sample = sampler(src, box);
  const scale = markHeight / box.h;
  const left = cx - (box.w * scale) / 2;
  const top = cy - (box.h * scale) / 2;
  const n = Math.min(24, Math.max(3, Math.ceil(2 / scale)));
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const sy = box.y + (y + (j + 0.5) / n - top) / scale;
        if (sy < box.y - 1 || sy > box.y + box.h + 1) continue;
        for (let i = 0; i < n; i++) {
          sum += sample(box.x + (x + (i + 0.5) / n - left) / scale, sy);
        }
      }
      out[y * width + x] = Math.min(1, sum / (n * n));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Colours (the phone app's palette, src/app/m/mobile.css)

// A touch lighter than the app's page background, so the icon's edge still shows on a dark
// wallpaper (checked on light and dark wallpapers at Home Screen size).
const navyTop = [32, 47, 78];
const navyBottom = [14, 22, 38];
const gold = [232, 183, 62]; // --m-gold
const goldHi = [243, 201, 90]; // --m-gold-hi
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Square icon: navy ground (opaque, so iOS never composites it onto black), gold windmill.
 * `markHeight` is the windmill's height as a fraction of the icon.
 */
function icon(src, box, size, { markHeight, cornerRadius = 0 }) {
  const coverage = renderCoverage(src, box, size, size, { markHeight: markHeight * size, cy: size * 0.5 });
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (y + 0.5) / size;
      const bg = mix(navyTop, navyBottom, v);
      const ink = mix(goldHi, gold, v);
      const c = mix(bg, ink, coverage[y * size + x]);
      let alpha = 1;
      if (cornerRadius > 0) {
        let inside = 0;
        for (let i = 0; i < ss; i++)
          for (let j = 0; j < ss; j++) {
            const sx = (x + (i + 0.5) / ss) / size - 0.5;
            const sy = (y + (j + 0.5) / ss) / size - 0.5;
            const qx = Math.abs(sx) - (0.5 - cornerRadius);
            const qy = Math.abs(sy) - (0.5 - cornerRadius);
            if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= cornerRadius) inside++;
          }
        alpha = inside / (ss * ss);
      }
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(c[0]);
      rgba[o + 1] = Math.round(c[1]);
      rgba[o + 2] = Math.round(c[2]);
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return { png: encodePng(size, size, rgba), coverage };
}

/** The windmill alone, gold on transparent, tightly cropped (for the app's header and sign-in). */
function markImage(src, box, height, color) {
  const width = Math.round((box.w / box.h) * height);
  const coverage = renderCoverage(src, box, width, height, { markHeight: height });
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = color[0];
    rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = Math.round(clamp01(coverage[i]) * 255);
  }
  return { png: encodePng(width, height, rgba), width, height };
}

/** Largest distance of any ink from the icon centre, as a fraction of the icon size. */
function inkRadius(coverage, size) {
  let max = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (coverage[y * size + x] > 0.02) {
        max = Math.max(max, Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5));
      }
  return max;
}

// ---------------------------------------------------------------------------------------------

const src = decodePng(sourcePath);
const box = findWindmill(src);
console.log(`windmill: ${box.w}x${box.h} at ${box.x},${box.y} in a ${src.width}x${src.height} logo`);

// The windmill is tall (about 0.73 wide per 1 high) and its sails carry a fine lattice, so it is
// drawn as large as the frame allows: 88% of the height for the Home Screen icons (checked at
// 60 and 120 px: smaller, the lattice turns to mush; the sail tips still clear iOS's rounded
// corners), 92% for the tiny favicons.
const HOME_MARK = 0.88;
const MASKABLE_MARK = 0.68; // keeps every bit of ink inside the 40%-radius maskable safe circle

const outputs = {
  "apple-touch-icon.png": icon(src, box, 180, { markHeight: HOME_MARK }), // iOS masks it itself: full-bleed, opaque
  "icon-192.png": icon(src, box, 192, { markHeight: HOME_MARK }),
  "icon-512.png": icon(src, box, 512, { markHeight: HOME_MARK }),
  "icon-maskable-512.png": icon(src, box, 512, { markHeight: MASKABLE_MARK }),
  "favicon-32.png": icon(src, box, 32, { markHeight: 0.92, cornerRadius: 0.2 }),
  "favicon-64.png": icon(src, box, 64, { markHeight: 0.9, cornerRadius: 0.2 }),
};

const maskableRadius = inkRadius(outputs["icon-maskable-512.png"].coverage, 512);
if (maskableRadius > 0.4) {
  throw new Error(`Maskable icon ink reaches ${maskableRadius.toFixed(3)} of the size from the centre (safe zone 0.4)`);
}
console.log(`maskable icon: ink within ${(maskableRadius * 100).toFixed(1)}% of the centre (safe zone 40%)`);

for (const [name, { png }] of Object.entries(outputs)) {
  writeFileSync(path.join(outDir, name), png);
  console.log(`${name} ${png.length} bytes`);
}

// In-app mark: gold windmill on transparent, rendered at 288px high so it stays sharp at the
// largest size the app shows it (84 CSS px on the sign-in screen) on 3x screens.
const mark = markImage(src, box, 288, gold);
writeFileSync(path.join(outDir, "windmill-gold.png"), mark.png);
console.log(`windmill-gold.png ${mark.width}x${mark.height} ${mark.png.length} bytes`);

const previewDir = process.env.ORISON_ICON_PREVIEW_DIR;
if (previewDir) {
  mkdirSync(previewDir, { recursive: true });
  for (const size of [60, 120]) {
    const preview = icon(src, box, size, { markHeight: HOME_MARK });
    writeFileSync(path.join(previewDir, `home-icon-${size}.png`), preview.png);
  }
  console.log(`previews written to ${previewDir}`);
}
