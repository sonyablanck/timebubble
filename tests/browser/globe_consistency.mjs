// Does what you see match what the readout says? Samples canvas pixels, classifies
// them as land or sea by colour, and compares with the data the picker returns.

import { chromium } from "playwright";
const url = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

for (const [age, view] of [[150, "lat=20&lon=0&d=3"], [65, "lat=-10&lon=120&d=2.2"], [250, "lat=40&lon=-150&d=2.6"]]) {
  await page.goto(`${url}?age=${age}&${view}&layers=relief&ex=40`);
  await page.waitForSelector("body.ready", { timeout: 60000 });
  await page.waitForTimeout(800);
  const res = await page.evaluate(async () => {
    const { globe } = window.timeBubble;
    globe.render();
    const canvas = document.getElementById("globe");
    const gl = canvas.getContext("webgl2");
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const rect = canvas.getBoundingClientRect();
    let agree = 0, total = 0, coast = 0;
    const misses = [];
    for (let i = 0; i < 4000; i++) {
      const x = Math.random() * rect.width, y = Math.random() * rect.height;
      const ll = globe.pick(rect.left + x, rect.top + y);
      if (!ll) continue;
      const info = globe.hoverInfo(ll.lat, ll.lon);
      // skip near-coast points: 1° nearest-node vs interpolated rendering can differ there
      if (Math.abs(info.coastDistKm) < 150) { coast++; continue; }
      const bx = Math.floor((x / rect.width) * w), by = Math.floor((1 - y / rect.height) * h);
      const k = (by * w + bx) * 4;
      const [r, g, b] = [px[k], px[k + 1], px[k + 2]];
      const looksSea = b > r + 10;
      total++;
      if (looksSea === !info.isLand) agree++; else if (misses.length < 5) misses.push({ ll, elev: info.elevationM, rgb: [r, g, b] });
    }
    return { agree, total, coast, misses };
  });
  console.log(`${age} Ma: land/sea colour agrees with picked data at ${(100 * res.agree / res.total).toFixed(1)}% of ${res.total} points (skipped ${res.coast} near coasts)`, res.misses.length ? JSON.stringify(res.misses) : "");
}

// round trip: project a point to the screen, pick it back
await page.goto(`${url}?age=150&lat=20&lon=0&d=3`);
await page.waitForSelector("body.ready");
const rt = await page.evaluate(() => {
  const { globe } = window.timeBubble;
  const rect = document.getElementById("globe").getBoundingClientRect();
  let worst = 0;
  for (const [lat, lon] of [[30, 60], [20, 0], [-10, -30], [45, 20], [0, 40], [60, -20]]) {
    const p = globe.project(lat, lon);
    if (!p.visible) continue;
    const ll = globe.pick(rect.left + p.x, rect.top + p.y);
    worst = Math.max(worst, Math.abs(ll.lat - lat), Math.abs(((ll.lon - lon + 540) % 360) - 180));
  }
  return worst;
});
console.log(`INVARIANT pick(project(lat, lon)) == (lat, lon): worst error ${rt.toFixed(4)}°`);
await browser.close();
