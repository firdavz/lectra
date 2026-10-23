// Renders mv.html frame by frame in headless Chrome and muxes it with music.wav.
//   node render.js video out.mp4            full MV, 30 fps
//   node render.js stills outDir 3,10.5,...  single frames as PNG, for review
// Needs puppeteer-core and ffmpeg on PATH; CHROME can point at another Chrome.
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FPS = 30;

(async () => {
  const [mode, out, times] = process.argv.slice(2);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto('file:///' + path.resolve(__dirname, 'mv.html').replace(/\\/g, '/') + '?render');
  await page.waitForFunction('window.mvReady === true');
  const frame = (t, type, q) => page.evaluate((t, type, q) => { renderFrame(t); return document.getElementById('c').toDataURL(type, q); }, t, type, q);

  if (mode === 'stills') {
    fs.mkdirSync(out, { recursive: true });
    for (const t of times.split(',').map(Number)) {
      const data = await frame(t, 'image/png');
      fs.writeFileSync(path.join(out, `t${String(t).replace('.', '_')}.png`), Buffer.from(data.split(',')[1], 'base64'));
    }
  } else {
    const dur = await page.evaluate(() => window.MV_DURATION);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-i', path.join(__dirname, 'music.wav'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-tune', 'animation',
      '-af', 'loudnorm=I=-14:TP=-1:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const n = Math.round(dur * FPS);
    const started = Date.now();
    for (let i = 0; i < n; i++) {
      const data = await frame(i / FPS, 'image/jpeg', 0.95);
      if (!ff.stdin.write(Buffer.from(data.split(',')[1], 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 150 === 0) console.log(`frame ${i}/${n}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    console.log('done', out);
  }
  await browser.close();
})();
