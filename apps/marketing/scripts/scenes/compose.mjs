// Composites the REAL storefront captures (public/devices/*) into photographed rooms
// (scene-photos.json: CC0 stock) and writes public/scenes/<id>-{800,1200}.{avif,webp} plus
// public/scenes/CREDITS.md. Rendered by Chromium so the screen sits in the photo with a real
// CSS 3D transform: a matrix3d homography onto a laptop screen that is in the photo, or a
// CSS-drawn phone lying on the photographed surface (rotateX/Y/Z), with a contact shadow,
// the screen's light on the surface and a glass reflection.
//   node scripts/scenes/compose.mjs      (run from the repo root; needs @playwright/test + sharp)
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(path.join(process.cwd(), 'noop.js'));
const { chromium } = req('@playwright/test');
const sharp = req('sharp');
const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(app, 'public', 'scenes');
mkdirSync(out, { recursive: true });
const photos = JSON.parse(readFileSync(path.join(app, 'scene-photos.json'), 'utf8'));

/** Solve the 3x3 homography taking the w x h rectangle onto quad [[x,y] x4] (TL, TR, BR, BL). */
function matrix3d(w, h, quad) {
  const src = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = quad[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  // Gaussian elimination
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h8 = b.map((v, i) => v / A[i][i]);
  const [a, bb, c, d, e, f, g, hh] = h8;
  return `matrix3d(${[a, d, 0, g, bb, e, 0, hh, 0, 0, 1, 0, c, f, 0, 1].map(n => +n.toFixed(8)).join(',')})`;
}

/**
 * Per scene: either `screenQuad` (a device screen already in the photo, corners in photo px)
 * or `phone` (a CSS phone placed on the surface: centre in photo px, width, 3D rotation).
 */
const SCENES = {
  souq: {
    device: 'laptop',
    aspect: 16 / 9,
    screenQuad: [
      [85, 119],
      [264, 129],
      [305, 339],
      [128, 347],
    ],
  },
  lamma: {
    device: 'phone',
    light: 0.82,
    tint: 'rgba(80,50,20,.18)',
    phone: { cx: 340, cy: 468, w: 122, rx: 54, ry: 0, rz: 22 },
  },
  dahab: {
    device: 'phone',
    light: 0.8,
    tint: 'rgba(70,35,15,.2)',
    phone: { cx: 280, cy: 450, w: 132, rx: 48, ry: 0, rz: -24 },
  },
  qamar: {
    device: 'phone',
    light: 0.95,
    tint: 'rgba(120,90,50,.1)',
    phone: { cx: 700, cy: 345, w: 108, rx: 10, ry: -16, rz: -2 },
  },
  jasmine: {
    device: 'phone',
    light: 0.97,
    tint: 'rgba(200,170,190,.12)',
    phone: { cx: 730, cy: 455, w: 132, rx: 50, ry: 0, rz: 16 },
  },
};

const PHONE_CSS = `
.ph{position:absolute;aspect-ratio:9/19.3;border-radius:16.5%/7.7%;padding:2.3%;
 background:linear-gradient(150deg,#9a9ea2,#3a3d40 14%,#16181a 50%,#3a3d40 86%,#a2a6aa);
 box-shadow:inset 0 0 0 1px rgba(255,255,255,.35),inset 0 0 0 2px #050506;transform-style:preserve-3d}
.tint{position:absolute;inset:0;border-radius:inherit;mix-blend-mode:multiply;pointer-events:none}
.ph::after{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(150deg,#55595c,#202224 50%,#55595c);transform:translateZ(-4px)}
.ph .scr{position:relative;transform:translateZ(1px);height:100%;border-radius:13.5%/6.3%;overflow:hidden;background:#000}
.ph .scr img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.ph .isl{position:absolute;top:2.4%;left:50%;translate:-50% 0;width:31%;height:3.6%;border-radius:999px;background:#000;z-index:2}
.glass{position:absolute;inset:0;border-radius:inherit;pointer-events:none;
 background:linear-gradient(118deg,rgba(255,255,255,.2),rgba(255,255,255,.05) 24%,transparent 25%)}
.shadow{position:absolute;border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.6),transparent);filter:blur(10px)}
.spill{position:absolute;border-radius:50%;background:radial-gradient(closest-side,rgba(255,240,215,.35),transparent);filter:blur(14px);mix-blend-mode:screen}
`;

function sceneHtml(id, photoDataUrl, W, H, shot) {
  const s = SCENES[id];
  const cap = `data:image/webp;base64,${readFileSync(shot).toString('base64')}`;
  let overlay = '';
  if (s.screenQuad) {
    const sw = 1440;
    const sh = 900;
    const m = matrix3d(sw, sh, s.screenQuad);
    overlay = `<div style="position:absolute;left:0;top:0;width:${sw}px;height:${sh}px;transform-origin:0 0;transform:${m}">
      <img src="${cap}" style="display:block;width:100%;height:100%;object-fit:cover;object-position:top;filter:brightness(.92) saturate(1.05)">
      <div class="glass" style="background:linear-gradient(115deg,rgba(255,255,255,.18),rgba(255,255,255,.04) 30%,transparent 31%)"></div></div>`;
    const [tl, , br, bl] = s.screenQuad;
    overlay += `<div class="spill" style="left:${bl[0] - 40}px;top:${bl[1] - 10}px;width:${br[0] - bl[0] + 160}px;height:90px"></div>`;
    void tl;
  } else {
    const p = s.phone;
    const h = p.w * 2.144;
    const t = `perspective(1400px) rotateZ(${p.rz}deg) rotateX(${p.rx}deg) rotateY(${p.ry}deg)`;
    overlay = `<div class="shadow" style="left:${p.cx - p.w * 0.75}px;top:${p.cy - h * 0.22}px;width:${p.w * 1.5}px;height:${h * 0.5}px;transform:rotateZ(${p.rz}deg)"></div>
      <div class="spill" style="left:${p.cx - p.w}px;top:${p.cy - h * 0.25}px;width:${p.w * 2}px;height:${h * 0.55}px"></div>
      <div class="ph" style="left:${p.cx - p.w / 2}px;top:${p.cy - h / 2}px;width:${p.w}px;transform:${t}">
        <div class="scr"><span class="isl"></span><img src="${cap}" style="filter:brightness(${s.light ?? 0.9}) contrast(1.02)"><div class="glass"></div></div><div class="tint" style="background:${s.tint ?? 'transparent'}"></div></div>`;
  }
  return `<!doctype html><html><head><style>html,body{margin:0;background:#000}${PHONE_CSS}</style></head><body>
    <div id="stage" style="position:relative;width:${W}px;height:${H}px;overflow:hidden;background:url(${photoDataUrl}) center/cover">${overlay}</div></body></html>`;
}

const b = await chromium.launch();
const credits = [];
for (const ph of photos) {
  const res = await fetch(ph.url, {
    headers: { 'User-Agent': 'ebda-marketing/1.0 (ahlan@ebda.app)' },
  });
  if (!res.ok) throw new Error(`${ph.id}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  const W = meta.width;
  const H = meta.height;
  const s = SCENES[ph.id];
  const shot = path.join(
    app,
    'public',
    'devices',
    `${ph.id}-${s.device}-${s.device === 'laptop' ? 1280 : 600}.webp`
  );
  const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5 });
  await page.setContent(
    sceneHtml(ph.id, `data:image/jpeg;base64,${buf.toString('base64')}`, W, H, shot),
    { waitUntil: 'load' }
  );
  const png = await page.locator('#stage').screenshot();
  await page.close();
  // 4:3 (or the scene's aspect) crop around the composite, then the two published widths.
  const ar = s.aspect ?? 4 / 3;
  const full = sharp(png);
  const fm = await full.metadata();
  const cw = Math.min(fm.width, Math.round(fm.height * ar));
  const ch = Math.min(fm.height, Math.round(cw / ar));
  const cx = s.screenQuad
    ? Math.max(
        0,
        Math.min(
          fm.width - cw,
          Math.round(((s.screenQuad[0][0] + s.screenQuad[2][0]) / 2) * 1.5 - cw / 2)
        )
      )
    : Math.max(0, Math.min(fm.width - cw, Math.round(s.phone.cx * 1.5 - cw / 2)));
  const crop = await sharp(png)
    .extract({ left: cx, top: Math.round((fm.height - ch) * 0.35), width: cw, height: ch })
    .toBuffer();
  for (const w of [800, 1200]) {
    const img = sharp(crop).resize({ width: w, height: Math.round(w / ar), fit: 'cover' });
    await img
      .clone()
      .avif({ quality: 52, effort: 6 })
      .toFile(path.join(out, `${ph.id}-${w}.avif`));
    await img
      .clone()
      .webp({ quality: 74 })
      .toFile(path.join(out, `${ph.id}-${w}.webp`));
  }
  credits.push(
    `| ${ph.id} | [${ph.title || 'photo'}](${ph.page}) | ${ph.creator ? (ph.creatorUrl ? `[${ph.creator}](${ph.creatorUrl})` : ph.creator) : 'unknown (public domain)'} | ${ph.source} | [${ph.license}](${ph.licenseUrl}) |`
  );
  console.log('scene', ph.id);
}
await b.close();
writeFileSync(
  path.join(out, 'CREDITS.md'),
  `# Scene photo credits\n\nRoom photos behind the device composites on ebda.app. Openly licensed stock (found via Openverse), cropped, colour-graded on the page, with a real Ebda storefront capture composited in.\n\n| Scene | Photo | Author | Source | License |\n|---|---|---|---|---|\n${credits.join('\n')}\n`
);
