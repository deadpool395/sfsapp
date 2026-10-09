/**
 * Produce a small square crest for embedding in Excel and PDF reports.
 *
 * The source logo is ~1 MP, which would add roughly half a megabyte to every
 * exported report. This downscales it once to logo/logo-mark.png.
 *
 * Uses the browser already installed for screenshots, so there is no image
 * library dependency.
 *
 *   node scripts/make-logo-mark.js [size]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SIZE = Number(process.argv[2] || 256);
const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'logo', 'logo.png');
const OUT = path.join(ROOT, 'logo', 'logo-mark.png');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

if (!fs.existsSync(SRC)) {
  console.error(`No logo at ${SRC}`);
  process.exit(1);
}

const dataUri = `data:image/png;base64,${fs.readFileSync(SRC).toString('base64')}`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const out = await page.evaluate(async (uri, size) => {
    const img = new Image();
    img.src = uri;
    await img.decode();

    // Keep the aspect ratio and centre it on a transparent square.
    const scale = Math.min(size / img.width, size / img.height);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL('image/png');
  }, dataUri, SIZE);

  const buf = Buffer.from(out.split(',')[1], 'base64');
  fs.writeFileSync(OUT, buf);

  const before = fs.statSync(SRC).size;
  console.log(`source  ${path.basename(SRC)}  ${(before / 1024).toFixed(0)} KB`);
  console.log(`written ${path.basename(OUT)}  ${(buf.length / 1024).toFixed(0)} KB  (${SIZE}x${SIZE})`);
} finally {
  await browser.close();
}
