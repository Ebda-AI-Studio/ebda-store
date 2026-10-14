// Screenshots of the template looks, captured with headless Chrome from public/looks/*.html.
//   node scripts/looks/shots.mjs sheet <outDir>   first screen of all 15 looks (to pick from)
//   node scripts/looks/shots.mjs site             the screen ebda.app uses outside the looks section:
//     public/looks/phone-{600,900}.{avif,webp}   first screen of PHONE (break-out phone, 390x844 @3x ratio)
// Needs Google Chrome + network (Google Fonts).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..', '..');
const pub = path.join(app, 'public');
const PHONE = ['dahab', 'a'];
const W = 390;
const H = 844;
const WIN = 520;

// looks-fonts.ts is prettier-formatted, so read it with a regex rather than as JSON.
const fontsSrc = readFileSync(path.join(app, 'src/lib/looks-fonts.ts'), 'utf8');
const fonts = Object.fromEntries(
  [...fontsSrc.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map(m => [
    m[1],
    [...m[2].matchAll(/["']([^"']+)["']/g)].map(x => x[1]),
  ])
);

function page(tpl, letter, full) {
  const frag = readFileSync(path.join(pub, 'looks', `${tpl}.html`), 'utf8');
  const [css, a, b, c] = frag.split('<!--look-->');
  const body = { a, b, c }[letter]
    .replaceAll('/looks/img/', `file://${pub}/looks/img/`)
    .replaceAll('loading="lazy"', 'loading="eager"');
  const link = `https://fonts.googleapis.com/css2?${fonts[tpl].map(f => `family=${f}`).join('&')}&display=swap`;
  return `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${link}">${css}
<style>html,body{margin:0}#ph-${tpl}-${letter}{width:${W}px!important;height:${full ? 'auto' : H + 'px'}!important;overflow:hidden!important}</style>
${body}<script>document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,300))).then(()=>{document.body.dataset.h=document.documentElement.scrollHeight})</script>`;
}

function chrome(file, args) {
  return execFileSync(
    CHROME,
    [
      '--headless=new',
      '--hide-scrollbars',
      '--disable-gpu',
      '--virtual-time-budget=15000',
      ...args,
      `file://${file}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }
  );
}

// Chrome's headless window is never narrower than ~500px, so shoot 500 wide and crop to the phone.
async function shot(tpl, letter, out, { full, dpr }) {
  const dir = path.join(tmpdir(), 'looks-shot');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tpl}-${letter}.html`);
  writeFileSync(file, page(tpl, letter, full));
  let h = H;
  if (full) {
    const dom = chrome(file, ['--dump-dom', `--window-size=${WIN},${H}`]);
    h = Number(/data-h="(\d+)"/.exec(dom)?.[1]);
    if (!h) throw new Error(`could not measure ${tpl}-${letter}`);
  }
  chrome(file, [
    `--screenshot=${out}`,
    `--window-size=${WIN},${h}`,
    `--force-device-scale-factor=${dpr}`,
  ]);
  rmSync(file);
  const raw = await sharp(out)
    .extract({ left: 0, top: 0, width: Math.round(W * dpr), height: Math.round(h * dpr) })
    .png()
    .toBuffer();
  await sharp(raw).toFile(out);
  return h;
}

async function write(png, name, width) {
  const img = sharp(png).resize({ width }).toColourspace('srgb').withIccProfile('srgb');
  await img
    .clone()
    .avif({ quality: 70, effort: 7, chromaSubsampling: '4:4:4' })
    .toFile(`${name}.avif`);
  await img.clone().webp({ quality: 85, smartSubsample: true }).toFile(`${name}.webp`);
}

const mode = process.argv[2];
if (mode === 'sheet') {
  const out = process.argv[3];
  mkdirSync(out, { recursive: true });
  for (const t of ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'])
    for (const l of ['a', 'b', 'c'])
      await shot(t, l, path.join(out, `${t}-${l}.png`), { full: false, dpr: 1 });
} else if (mode === 'site') {
  const tmp = path.join(tmpdir(), 'looks-shot-out');
  mkdirSync(tmp, { recursive: true });
  await shot(...PHONE, path.join(tmp, 'phone.png'), { full: false, dpr: 900 / W });
  for (const w of [600, 900])
    await write(path.join(tmp, 'phone.png'), path.join(pub, 'looks', `phone-${w}`), w);
  console.log('phone shots written');
} else {
  console.error('usage: shots.mjs sheet <outDir> | site');
  process.exit(1);
}
