// Generates the Orison mobile app icons (PNG) into public/m-app/.
// Run: node apps/web/scripts/generate-mobile-icons.mjs
// No dependencies: shapes are drawn with signed distance functions and encoded with zlib.
// The mark: a gold ring with a rising sun on a horizon line (Orison ~ horizon), on deep navy.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "m-app");
mkdirSync(outDir, { recursive: true });

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
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const navyTop = [17, 27, 48];
const navyBottom = [8, 13, 22];
const gold = [224, 179, 64];
const goldLight = [240, 201, 92];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (v) => Math.max(0, Math.min(1, v));

// Distance (in units of the icon size) to the mark; negative inside. `scale` shrinks the mark
// for maskable icons, which need a larger safe zone.
function markCoverage(u, v, px, scale) {
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;
  const aa = (d) => clamp(0.5 - d / (px / scale));
  const r = Math.hypot(x, y);
  const ring = Math.abs(r - 0.3) - 0.045; // ring: radius .3, stroke .09
  const horizonY = 0.085;
  // sun: disc radius .175 centred just above the horizon, clipped above a small gap
  const sunDisc = Math.hypot(x, y - horizonY) - 0.175;
  const sun = Math.max(sunDisc, y - (horizonY - 0.035));
  // horizon line running across the inside of the ring
  const bar = Math.max(Math.abs(x) - 0.27, Math.abs(y - horizonY) - 0.018);
  const barRounded = Math.max(bar, r - 0.3);
  return { ring: aa(ring), sun: aa(sun), bar: aa(barRounded) };
}

function icon(size, { scale = 1, transparentCorners = false, radius = 0 } = {}) {
  const ss = 3; // supersampling for the background corners
  return png(size, (x, y) => {
    const u = (x + 0.5) / size;
    const v = (y + 0.5) / size;
    let bg = mix(navyTop, navyBottom, v);
    // soft warm glow behind the sun
    const glow = Math.exp(-((u - 0.5) ** 2 + (v - 0.56) ** 2) / 0.05) * 0.1;
    bg = mix(bg, gold, glow);
    const { ring, sun, bar } = markCoverage(u, v, 1 / size, scale);
    const fill = mix(gold, goldLight, clamp(0.6 - v));
    let c = mix(bg, fill, Math.max(ring, sun, bar));
    let alpha = 255;
    if (transparentCorners && radius > 0) {
      let inside = 0;
      for (let i = 0; i < ss; i++)
        for (let j = 0; j < ss; j++) {
          const sx = (x + (i + 0.5) / ss) / size - 0.5;
          const sy = (y + (j + 0.5) / ss) / size - 0.5;
          const qx = Math.abs(sx) - (0.5 - radius);
          const qy = Math.abs(sy) - (0.5 - radius);
          const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
          if (d <= 0) inside++;
        }
      alpha = Math.round((inside / (ss * ss)) * 255);
    }
    return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), alpha];
  });
}

const files = {
  "apple-touch-icon.png": icon(180), // iOS masks it itself: full-bleed, opaque
  "icon-192.png": icon(192),
  "icon-512.png": icon(512),
  "icon-maskable-512.png": icon(512, { scale: 0.78 }),
  "favicon-32.png": icon(32, { transparentCorners: true, radius: 0.22 }),
  "favicon-64.png": icon(64, { transparentCorners: true, radius: 0.22 }),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(outDir, name), data);
  console.log(`${name} ${data.length} bytes`);
}
