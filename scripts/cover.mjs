// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark gradient, an hourly
// bar chart of errors with one red spike, and beside it a list of issues with
// a warning sign. No logo of Sentry (an unofficial integration).
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [22, 16, 36];
const PURPLE = [54, 38, 86];
const WHITE = [236, 240, 246];
const MUTED = [120, 110, 150];
const RED = [232, 72, 85];
const AMBER = [244, 180, 60];
const PANEL = [34, 26, 54];

function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.max(Math.abs(x - cx) - halfW + radius, 0);
  const dy = Math.max(Math.abs(y - cy) - halfH + radius, 0);
  return Math.hypot(dx, dy) - radius;
}

function triangle(x, y, [a, b, c]) {
  const side = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const s1 = side(a, b);
  const s2 = side(b, c);
  const s3 = side(c, a);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

// 18 hourly bars, the last but one a spike.
const BARS = [4, 5, 3, 6, 4, 5, 7, 4, 3, 5, 6, 4, 5, 4, 6, 5, 22, 9];
const CHART = { left: 70, bottom: 420, width: 400, height: 260 };
const WARN = [
  [620, 120],
  [690, 240],
  [550, 240],
];

function pixel(x, y) {
  let color = mix(DARK, PURPLE, (x + y) / (WIDTH + HEIGHT));
  // Chart panel.
  const panel = roundedBox(x, y, 270, 280, 230, 190, 24);
  color = mix(color, PANEL, smooth(0, panel));
  // Baseline.
  if (
    y >= CHART.bottom &&
    y < CHART.bottom + 3 &&
    x > CHART.left - 10 &&
    x < CHART.left + CHART.width + 10
  ) {
    color = MUTED;
  }
  const step = CHART.width / BARS.length;
  const index = Math.floor((x - CHART.left) / step);
  if (index >= 0 && index < BARS.length) {
    const within = x - CHART.left - index * step;
    const h = (BARS[index] / 22) * CHART.height;
    if (within > 4 && within < step - 4 && y < CHART.bottom && y > CHART.bottom - h) {
      color = index === 16 ? RED : mix(MUTED, WHITE, 0.3);
    }
  }
  // Warning sign and its mark.
  if (triangle(x, y, WARN)) color = AMBER;
  if (roundedBox(x, y, 620, 180, 6, 28, 5) < 0 || Math.hypot(x - 620, y - 222) < 7) color = DARK;
  // Issue lines.
  for (let i = 0; i < 4; i += 1) {
    const cy = 300 + i * 46;
    if (Math.hypot(x - 560, y - cy) < 9) color = i === 0 ? RED : MUTED;
    const line = roundedBox(x, y, 660, cy, i === 0 ? 70 : 80 - i * 8, 7, 7);
    if (line < 0) color = i === 0 ? WHITE : mix(MUTED, DARK, 0.2);
  }
  return color;
}
const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
