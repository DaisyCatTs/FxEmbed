/**
 * Generate the PuppyGirl logo as PNGs and an SVG.
 *
 * Written by hand rather than pulled from an image library: the shapes are simple, the output has
 * to be deterministic and committed, and adding a native dependency (sharp/resvg) to a Workers
 * project purely to draw a 64px icon is a bad trade.
 *
 * Run: node tools/make-logo.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(process.cwd(), 'assets', 'logos');
const SIZES = [16, 24, 32, 48, 64, 180];

/* Brand colour from branding.json. */
const BRAND = [0x63, 0x63, 0xff];
const INK = [0xff, 0xff, 0xff];

/* --- PNG encoding ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
};

const encodePng = (size, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  /* Each scanline is prefixed with filter type 0 (none) — the images are tiny, so the bytes saved
     by a smarter filter are not worth the code. */
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
};

/* --- Shape ------------------------------------------------------------------------------- */

/* Coordinates are normalised 0..1 so one definition renders at every size. A puppy face: two
   floppy ears either side of a round head, with eyes and a nose knocked back out in the brand
   colour. Detail is kept minimal because the icon is read at ~16px in a Discord footer, where
   anything finer turns to mush. */
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const inRoundedSquare = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** Returns [r,g,b,a] for a point, or null for transparent. */
const shadeAt = (x, y) => {
  if (!inRoundedSquare(x, y, 0.24)) return null;

  /* Ears sit low and hang past the jaw. Upright ellipses read as a mouse or bear; the droop is
     what makes the silhouette say puppy at a glance. */
  const head = inEllipse(x, y, 0.5, 0.5, 0.275, 0.265);
  const earL = inEllipse(x, y, 0.21, 0.56, 0.115, 0.28);
  const earR = inEllipse(x, y, 0.79, 0.56, 0.115, 0.28);

  if (head || earL || earR) {
    /* Face details punch back through to the brand colour. */
    const eyeL = inEllipse(x, y, 0.405, 0.465, 0.045, 0.058);
    const eyeR = inEllipse(x, y, 0.595, 0.465, 0.045, 0.058);
    const nose = inEllipse(x, y, 0.5, 0.6, 0.072, 0.052);
    if (eyeL || eyeR || nose) return BRAND;
    return INK;
  }

  return BRAND;
};

/* Supersample 4x4 per pixel and average, so edges are antialiased rather than stair-stepped. */
const render = size => {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = shadeAt(x, y);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      /* Un-premultiply so partially covered edge pixels keep full colour. */
      const cover = a / n;
      out[i] = cover > 0 ? Math.round(r / (a / 255)) : 0;
      out[i + 1] = cover > 0 ? Math.round(g / (a / 255)) : 0;
      out[i + 2] = cover > 0 ? Math.round(b / (a / 255)) : 0;
      out[i + 3] = Math.round(cover);
    }
  }
  return out;
};

/* --- SVG --------------------------------------------------------------------------------- */

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="PuppyGirl">
  <rect width="64" height="64" rx="15.4" fill="#6363ff"/>
  <ellipse cx="13.4" cy="35.8" rx="7.4" ry="17.9" fill="#fff"/>
  <ellipse cx="50.6" cy="35.8" rx="7.4" ry="17.9" fill="#fff"/>
  <ellipse cx="32" cy="32" rx="17.6" ry="17" fill="#fff"/>
  <ellipse cx="25.9" cy="29.8" rx="2.9" ry="3.7" fill="#6363ff"/>
  <ellipse cx="38.1" cy="29.8" rx="2.9" ry="3.7" fill="#6363ff"/>
  <ellipse cx="32" cy="38.4" rx="4.6" ry="3.3" fill="#6363ff"/>
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });

const encoded = {};
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  const file = join(OUT_DIR, `puppygirl${size}.png`);
  writeFileSync(file, png);
  encoded[size] = png.toString('base64');
  console.log(`wrote ${file}`);
}
writeFileSync(join(OUT_DIR, 'puppygirl.svg'), svg);
console.log(`wrote ${join(OUT_DIR, 'puppygirl.svg')}`);

/* Emit the same bytes as a TypeScript module so the Worker can serve them without an external
   host. Base64 in a plain .ts file rather than an esbuild asset loader, because that keeps the
   import working identically under vitest, which does not use the worker's esbuild config. The
   whole set is a few KB against a ~940 KB bundle. */
const generatedDir = join(process.cwd(), 'src', 'generated');
mkdirSync(generatedDir, { recursive: true });

const ts = `/* GENERATED by tools/make-logo.mjs — do not edit. Run \`node tools/make-logo.mjs\`. */

/** PNG logos, keyed by pixel size, base64-encoded. */
export const LOGO_PNG_BASE64: Record<string, string> = {
${SIZES.map(s => `  '${s}': '${encoded[s]}'`).join(',\n')}
};

export const LOGO_SVG = ${JSON.stringify(svg)};
`;

const tsPath = join(generatedDir, 'logo-assets.ts');
writeFileSync(tsPath, ts);
console.log(`wrote ${tsPath}`);
