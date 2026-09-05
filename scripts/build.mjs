import { build, context } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

// Generate small, crisp arrow icons without a raster-image dependency.
function iconPng(size) {
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const nameBytes = Buffer.from(name);
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); nameBytes.copy(out, 4); data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([nameBytes, data])), data.length + 8);
    return out;
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / size, py = (y + .5) / size;
    const arrowRight = Math.abs(py - .36) < .045 && px > .22 && px < .76 ||
      px >= .60 && px <= .80 && Math.abs(py - .36) < (.80 - px);
    const arrowLeft = Math.abs(py - .64) < .045 && px > .24 && px < .78 ||
      px >= .20 && px <= .40 && Math.abs(py - .64) < (px - .20);
    const corner = Math.hypot(Math.max(.18 - px, 0, px - .82), Math.max(.18 - py, 0, py - .82));
    const color = arrowRight || arrowLeft ? [214, 246, 204] : [27, 64, 49];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    raw.set([...color, corner <= .18 ? 255 : 0], offset);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

await mkdir('dist/icons', { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const size of [16, 32, 48, 128]) await writeFile(`dist/icons/${size}.png`, iconPng(size));
const options = {
  entryPoints: { background: 'src/background/index.ts', content: 'src/content/index.ts', popup: 'src/popup/index.ts' },
  bundle: true, outdir: 'dist', target: 'chrome120', format: 'iife', sourcemap: true, logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching TypeScript. Re-run the build after editing public HTML/CSS or the manifest.');
} else await build(options);
