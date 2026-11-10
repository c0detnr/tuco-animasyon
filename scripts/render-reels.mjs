#!/usr/bin/env node
// npm ci && npm run render:reels
// Requires local playwright-core, a system Chromium, ffmpeg and ffprobe.
// --preview-only runs the same deterministic layout checks without encoding.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const previewOnly = process.argv.includes('--preview-only');
const width = 1080, height = 1920, fps = 30;
const output = resolve(root, 'reels.mp4');
const temporary = resolve(root, '.reels-render.mp4');
const previews = resolve(root, 'previews');
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
if (!executablePath) throw new Error('Chromium bulunamadı. CHROMIUM_PATH değişkenini ayarlayın.');
const mime = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser, encoder;
try {
  await mkdir(previews, { recursive: true });
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--font-render-hinting=none'] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
  const externalRequests = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:')) externalRequests.push(request.url()); });
  const address = `http://127.0.0.1:${server.address().port}/reels.html`;
  await page.goto(address + '?render=1', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (errors.length) throw new Error(errors.join('\n'));
  await page.waitForFunction(() => Boolean(window.TucoReels), null, { timeout: 5000 });
  const film = await page.evaluate(() => ({ duration: TucoReels.duration, scenes: TucoReels.scenes, cues: TucoReels.cues }));
  if (film.duration > 90 || film.scenes.length !== 13) throw new Error('Süre/sahne sınırı geçersiz.');
  if (externalRequests.length) throw new Error(`Harici istek: ${externalRequests.join(', ')}`);

  // Check every cue, scene boundary and ending; real rendered glyph bounds,
  // including SVG transforms, must remain within the Instagram safe area.
  const samples = [...new Set([0, 1, ...film.scenes.flatMap(s => [s.start + .04, (s.start + s.end) / 2]), ...film.cues.map(c => (c.start + c.end) / 2), film.duration - .04])];
  const violations = [];
  for (const time of samples) {
    const bad = await page.evaluate(time => {
      TucoReels.renderAt(time);
      const nodes = ['sceneName', 'sceneNote', 'clockText', 'sceneCount', 'bubbleText', 'bubbleText2', 'subtitleName', 'subtitleText', 'typeText', 'endingText', 'endingSon'];
      return nodes.flatMap(id => {
        const n = document.getElementById(id);
        let visible = true;
        for (let p = n; p && p instanceof SVGElement; p = p.parentElement) if (Number(getComputedStyle(p).opacity) === 0) visible = false;
        if (!visible || !n.textContent.trim()) return [];
        const r = n.getBoundingClientRect();
        return r.left < 45 || r.right > 950 || r.top < 250 || r.bottom > 1540 ? [{ id, text: n.textContent, bounds: { x: r.left, y: r.top, right: r.right, bottom: r.bottom } }] : [];
      });
    }, time);
    violations.push(...bad.map(b => ({ time, ...b })));
  }
  if (errors.length || violations.length) throw new Error(JSON.stringify({ errors, violations }, null, 2));

  for (const scene of film.scenes) {
    const time = (scene.start + scene.end) / 2;
    await page.evaluate(t => TucoReels.renderAt(t), time);
    await page.screenshot({ path: resolve(previews, `scene-${String(scene.number).padStart(2, '0')}.png`), type: 'png' });
  }
  for (const [name, time] of [['tuco-double', (()=>{const c=film.scenes[6].cues.find(c=>c.who==='both');return (c.start+c.end)/2;})()], ['stamp', film.scenes[7].start+.6], ['rec', film.scenes[4].end-.15]]) {
    await page.evaluate(t=>TucoReels.renderAt(t),time);
    await page.screenshot({path:resolve(previews,`${name}.png`),type:'png'});
  }
  // A backward seek must reproduce identical SVG state (no wall-clock animation).
  // Chromium raster caches can produce subpixel antialiasing differences.
  await page.evaluate(() => TucoReels.renderAt(12));
  const before = await page.evaluate(() => (() => {const svg=document.getElementById('film').cloneNode(true);svg.querySelectorAll('[opacity="0"]').forEach(n=>n.remove());return svg.outerHTML;})());
  await page.evaluate(() => { TucoReels.renderAt(75); TucoReels.renderAt(12); });
  const after = await page.evaluate(() => (() => {const svg=document.getElementById('film').cloneNode(true);svg.querySelectorAll('[opacity="0"]').forEach(n=>n.remove());return svg.outerHTML;})());
  if (before !== after) { await writeFile(resolve(previews,'seek-before.svg'),before); await writeFile(resolve(previews,'seek-after.svg'),after); throw new Error('Geri sarma deterministik değil.'); }

  const responsive = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {const r=document.getElementById('stage').getBoundingClientRect();return r.width<=innerWidth+.01 && r.height<=innerHeight+.01;});
    const bounds = await page.evaluate(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, scroll: document.documentElement.scrollWidth > innerWidth };
    });
    if (Math.abs(bounds.width / bounds.height - 9 / 16) > .0001 || bounds.x < -.01 || bounds.y < -.01 || bounds.scroll) throw new Error(`Orantılı ölçekleme bozuk: ${JSON.stringify(bounds)}`);
    responsive.push({ viewport, bounds });
  }
  await page.setViewportSize({ width, height });

  // Exercise normal browser playback and controls separately from render mode.
  const normal = await context.newPage();
  await normal.goto(address, { waitUntil: 'networkidle' });
  const moving = await normal.evaluate(async () => {
    const a = document.getElementById('progress').value;
    await new Promise(resolve => setTimeout(resolve, 250));
    const b = document.getElementById('progress').value;
    TucoReels.pause();
    return Number(b) > Number(a);
  });
  if (!moving) throw new Error('Normal oynatma ilerlemiyor.');
  await normal.close();
  console.log('Rendering deterministic soundtrack...');
  const audioBase64 = await page.evaluate(() => TucoReels.renderAudio());
  const audioPath = resolve(root, 'assets/reels-audio.wav');
  await writeFile(audioPath, Buffer.from(audioBase64, 'base64'));
  const report = { width, height, fps, duration: film.duration, sceneCount: film.scenes.length, cueCount: film.cues.length, checkedSamples: samples.length, deterministicBackwardSeek: true, normalPlayback: true, responsive, audio: 'Requested background music (h3DVBhneEWc), seeded character murmurs and scene effects, 48 kHz mono; AAC in MP4.' };
  await writeFile(resolve(previews, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Verified ${film.scenes.length} scenes, ${samples.length} samples and responsive letterboxing.`);
  if (!previewOnly) {
    const frames = Math.round(film.duration * fps);
    // Cache each exact frame before encoding. A browser/encoder interruption is
    // resumable, and renderer contexts are recycled every 300 frames.
    const digest=createHash('sha256').update(await readFile(resolve(root,'reels.html'))).digest('hex').slice(0,16);
    const frameDirectory=resolve(root,'.reels-frames',digest);
    await mkdir(frameDirectory,{recursive:true});
    let capturePage=page,captureContext=context,lastRecycle=-1;
    async function freshPage(relaunch=false){
      await captureContext?.close().catch(()=>{});
      if(relaunch){await browser?.close().catch(()=>{});browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--force-color-profile=srgb','--font-render-hinting=none']});}
      captureContext=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,reducedMotion:'no-preference'});
      capturePage=await captureContext.newPage();
      await capturePage.goto(address+'?render=1',{waitUntil:'networkidle'});
      await capturePage.evaluate(()=>document.fonts.ready);
    }
    for (let frame=0;frame<frames;frame++) {
      const destination=resolve(frameDirectory,`frame-${String(frame).padStart(5,'0')}.jpg`);
      if(existsSync(destination))continue;
      if(frame>0 && Math.floor(frame/300)!==lastRecycle){await freshPage();lastRecycle=Math.floor(frame/300);}
      for(let attempt=0;;attempt++){
        try{
          await capturePage.evaluate(time=>TucoReels.renderAt(time),frame/fps);
          const jpeg=await capturePage.screenshot({type:'jpeg',quality:95,animations:'allow',caret:'hide'});
          const staging=destination+'.tmp';await writeFile(staging,jpeg);await rename(staging,destination);break;
        }catch(error){if(attempt>=2)throw error;console.warn(`Retrying frame ${frame}: ${error.message.split('\n')[0]}`);await freshPage(true);}
      }
      if(frame%150===0)console.log(`Capturing ${frame}/${frames} (${(frame/fps).toFixed(0)}s/${film.duration}s)`);
    }
    await captureContext.close();
    console.log(`Encoding ${frames} cached frames...`);
    encoder = spawn('ffmpeg', ['-hide_banner','-loglevel','warning','-y','-framerate',String(fps),'-start_number','0','-i',resolve(frameDirectory,'frame-%05d.jpg'),'-i',audioPath,'-map','0:v:0','-map','1:a:0','-c:a','aac','-b:a','160k','-c:v','libx264','-preset','medium','-threads','2','-crf','19','-vf','scale=in_range=pc:out_range=tv,format=yuv420p','-color_range','tv','-pix_fmt','yuv420p','-r',String(fps),'-frames:v',String(frames),'-movflags','+faststart',temporary],{stdio:['ignore','inherit','inherit']});
    await new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('exit',code=>code===0?resolve():reject(new Error(`ffmpeg çıkış kodu: ${code}`)));});
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',temporary],{encoding:'utf8'}));
    const video=probe.streams.find(s=>s.codec_type==='video');
    if(video.width!==width||video.height!==height||video.r_frame_rate!=='30/1'||video.codec_name!=='h264'||video.pix_fmt!=='yuv420p'||Number(probe.format.duration)>90)throw new Error(`ffprobe kabul kontrolü başarısız: ${JSON.stringify({width:video.width,height:video.height,fps:video.r_frame_rate,codec:video.codec_name,pixelFormat:video.pix_fmt,duration:probe.format.duration})}`);
    await rename(temporary,output);probe.format.filename=output;
    await writeFile(resolve(previews,'ffprobe.json'),JSON.stringify(probe,null,2)+'\n');
    console.log(`Created ${output}: ${video.width}x${video.height}, ${video.r_frame_rate} fps, ${probe.format.duration}s, H.264 ${video.pix_fmt}`);
  }
} finally {
  if (encoder && encoder.exitCode === null) encoder.kill('SIGTERM');
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await unlink(temporary).catch(() => {});
}
