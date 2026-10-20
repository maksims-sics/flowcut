'use strict';
// Builds the app icons from build/icon.svg (48 px and up) and build/icon-small.svg (16-32 px):
//   build/icon.ico                    Windows icon (all sizes, PNG entries): window, taskbar, desktop shortcut
//   src/renderer/assets/icon.png      256 px
// usage: node build/make-icon.js [path to sharp]   (sharp is not a FlowCut dependency; the workspace has it)
const fs = require('node:fs');
const path = require('node:path');

const sharp = require(process.argv[2] || path.join(__dirname, '..', '..', 'node_modules', 'sharp'));
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function main() {
  const big = fs.readFileSync(path.join(__dirname, 'icon.svg'));
  const small = fs.readFileSync(path.join(__dirname, 'icon-small.svg'));
  const pngs = [];
  for (const size of SIZES) {
    const svg = size <= 32 ? small : big;
    pngs.push(await sharp(svg, { density: Math.max(72, (72 * size) / 32) }).resize(size, size).png().toBuffer());
  }
  // ICO: 6-byte header, 16-byte entry per image, then the PNG files
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);
  const entries = [];
  let offset = 6 + 16 * SIZES.length;
  SIZES.forEach((size, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    entries.push(e);
  });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'icon.png'), pngs[SIZES.indexOf(256)]);
  fs.writeFileSync(path.join(__dirname, 'icon-preview-32.png'), pngs[SIZES.indexOf(32)]);
  console.log(`icon.ico: ${SIZES.join(', ')} px`);
}

main().catch((err) => { console.error(err); process.exit(1); });
