// Renders the lantern scroll-turn ad video (1080x1350 + 1080x1920, H.264, seamless loop, no audio)
// and the 1200x630 poster / OG frame from the brass lantern model on the brand night ground.
//   node apps/marketing/scripts/3d/render-lantern.mjs        (from the repo root; needs ffmpeg + Playwright Chromium)
// Output: apps/marketing/public/ads/lantern-{1080x1350,1080x1920}.mp4 + lantern-poster.png/.webp, lantern-og.png
import { readFileSync } from 'node:fs';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { openHarness } from './render-3d.mjs';

const SECONDS = 8, FPS = 30;
const NIGHT = '#0A0B0C';
const lockup = readFileSync(new URL('../../../../brand/logo/svg/04a-product-store.svg', import.meta.url), 'utf8').replaceAll('#0A0B0C', '#FAF8F3');
const lockupUri = 'data:image/svg+xml;base64,' + Buffer.from(lockup).toString('base64');

// Night ground: a warm brass glow behind the lantern, falling off to the brand night.
const stage = ({ w, h, lockupH, headline }) => `
  html,body{background:radial-gradient(ellipse 70% 55% at 50% 46%, #2a2012 0%, #14110c 45%, ${NIGHT} 80%)!important}
  #fx{position:fixed;inset:0;pointer-events:none;font-family:'Cairo',sans-serif}
  #fx img{position:absolute;left:50%;transform:translateX(-50%);bottom:${Math.round(h * 0.055)}px;height:${lockupH}px}
  #fx .rule{position:absolute;left:50%;transform:translateX(-50%);bottom:${Math.round(h * 0.055) + lockupH + 18}px;width:72px;height:3px;background:#B08D57}
  #fx .hl{position:absolute;left:0;right:0;top:${Math.round(h * 0.07)}px;text-align:center;direction:rtl;color:#FAF8F3;font-weight:700;font-size:${Math.round(w * 0.052)}px;line-height:1.5;padding:0 ${Math.round(w * 0.1)}px;text-wrap:balance}`;

async function render({ w, h, headline, outName }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lantern-'));
  const hx = await openHarness({ url: '/apps/marketing/public/3d/brass-diya-lantern.glb', w, h, exposure: 1.1, warmGlow: 0.5 });
  const lockupH = Math.round(h * 0.1);
  await hx.page.addStyleTag({ content: stage({ w, h, lockupH }) });
  await hx.page.evaluate(([u, hl]) => {
    const d = document.createElement('div'); d.id = 'fx';
    d.innerHTML = `<div class="hl">${hl}</div><div class="rule"></div><img src="${u}" alt="">`;
    document.body.appendChild(d);
    return document.fonts.load('700 40px Cairo');
  }, [lockupUri, headline || '']).catch(() => {});
  const frames = SECONDS * FPS;
  const fit = w < h ? 0.56 : 0.8;
  const draw = async i => {
    const u = i / frames;
    // Monotone and periodic (a < 1): a steady turn with a soft ease each quarter, so the loop has no seam.
    const az = 2 * Math.PI * u + 0.55 * Math.sin(2 * Math.PI * u);
    await hx.page.evaluate(a => window.draw(a), { az, el: 0.16 + 0.03 * Math.sin(2 * Math.PI * u), fit });
  };
  for (let i = 0; i < frames; i++) {
    await draw(i);
    await hx.page.screenshot({ path: path.join(dir, `f${String(i).padStart(4, '0')}.png`) });
  }
  await hx.close();
  const out = path.join(hx.root, `apps/marketing/public/ads/lantern-${outName}.mp4`);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png'), '-vf', 'noise=alls=2:allf=t,format=yuv420p', '-c:v', 'libx264', '-profile:v', 'high', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', '-an', out], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  await rm(dir, { recursive: true, force: true });
  console.log('wrote', out);
}

await mkdir(new URL('../../public/ads/', import.meta.url), { recursive: true });
// 1200x630 poster = the OG image for the video: lantern left, the line and the lockup right (reads right-to-left).
async function poster() {
  const w = 1200, h = 630;
  const hx = await openHarness({ url: '/apps/marketing/public/3d/brass-diya-lantern.glb', w, h, exposure: 1.1, warmGlow: 0.5 });
  await hx.page.addStyleTag({ content: stage({ w, h, lockupH: 84 }) + `
  #fx .hl{left:auto;right:70px;top:150px;width:520px;text-align:right;font-size:50px;padding:0}
  #fx .rule{left:auto;right:70px;transform:none;bottom:auto;top:118px}
  #fx img{left:auto;right:56px;transform:none;bottom:60px}` });
  await hx.page.evaluate(([u, hl]) => {
    const d = document.createElement('div'); d.id = 'fx';
    d.innerHTML = '<div class="hl">' + hl + '</div><div class="rule"></div><img src="' + u + '" alt="">';
    document.body.appendChild(d);
    return document.fonts.load('700 40px Cairo');
  }, [lockupUri, HL]);
  await hx.page.evaluate(a => window.draw(a), { az: 0.62, el: 0.16, fit: 0.64, shiftX: -0.2 });
  const png = await hx.page.screenshot();
  const base = path.join(hx.root, 'apps/marketing/public/ads/lantern-poster');
  await hx.sharp(png).png({ palette: true, quality: 90, effort: 10, colours: 160, dither: 0.6 }).toFile(base + '.png');
  await hx.sharp(png).webp({ quality: 80 }).toFile(base + '.webp');
  await hx.close();
  console.log('wrote', base + '.png');
}

const HL = 'شوف منتجك من كل زاوية قبل ما يشتريه.';
await poster();
if (!process.env.POSTER_ONLY) await render({ w: 1080, h: 1350, headline: HL, outName: '1080x1350' });
if (!process.env.POSTER_ONLY) await render({ w: 1080, h: 1920, headline: HL, outName: '1080x1920' });
