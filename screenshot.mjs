/**
 * Screenshot a localhost page into ./temporary screenshots/.
 *
 *   node screenshot.mjs http://localhost:3000
 *   node screenshot.mjs http://localhost:3000 login          -> screenshot-N-login.png
 *   node screenshot.mjs http://localhost:3000 dash --admin   -> signs in as admin first
 *   node screenshot.mjs http://localhost:3000 marks --teacher
 *
 * Flags: --admin, --teacher (sign in first), --width=N, --height=N, --full (default), --viewport
 *
 * Uses puppeteer-core against the system Chrome, so there is no bundled
 * Chromium download.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT_DIR = path.join(process.cwd(), 'temporary screenshots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    console.error('No Chrome or Edge found. Set CHROME_PATH to a browser executable.');
    process.exit(1);
  }
  return found;
}

/** Next free screenshot-N.png, never overwriting an existing file. */
function nextPath(label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const used = fs
    .readdirSync(OUT_DIR)
    .map((f) => /^screenshot-(\d+)/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return path.join(OUT_DIR, `screenshot-${n}${label ? `-${label}` : ''}.png`);
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

const url = positional[0] || 'http://localhost:3000';
const label = positional[1] || '';
const flag = (name, fallback) => {
  const hit = flags.find((f) => f.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const width = flag('width', 1440);
const height = flag('height', 900);
const fullPage = !flags.includes('--viewport');

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });

  const origin = new URL(url).origin;

  // Optional sign-in so protected pages can be captured.
  if (flags.includes('--admin')) {
    await page.goto(`${origin}/login`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.getElementById('mode').value = 'admin';
      document.querySelector('input[name="username"]').value = 'admin';
      document.querySelector('input[name="password"]').value = 'admin123';
      document.getElementById('panel').submit();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
  } else if (flags.includes('--teacher')) {
    await page.goto(`${origin}/login`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      document.getElementById('mode').value = 'teacher';
      document.querySelector('input[name="username"]').value = 'teacher';
      document.querySelector('input[name="password"]').value = 'sfs2026';
      document.getElementById('panel').submit();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    if (page.url().includes('/select-teacher')) {
      await page.evaluate(() => {
        const sel = document.querySelector('select[name="teacher_id"]');
        if (sel && sel.options.length > 1) sel.selectedIndex = 1;
        sel.closest('form').submit();
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }
  }

  await page.goto(url, { waitUntil: 'networkidle2' });
  // Let webfonts settle so text is not captured mid-swap.
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await new Promise((r) => setTimeout(r, 400));

  const file = nextPath(label);
  await page.screenshot({ path: file, fullPage });

  const { w, h } = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
  }));
  const overflow = w > width + 1;

  console.log(`saved  ${path.relative(process.cwd(), file)}`);
  console.log(`url    ${page.url()}`);
  console.log(`page   ${w}x${h} at viewport ${width}x${height}${overflow ? '  ** HORIZONTAL OVERFLOW **' : ''}`);
} finally {
  await browser.close();
}
