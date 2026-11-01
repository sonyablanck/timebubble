// Headless walk-through of walk mode on real data: globe → Walk here → move, fly, overlay,
// inspect, cross a tile edge, back to the globe. Prints checks and writes screenshots.
// Usage: node tests/browser/walk_browser.mjs [url] [outDir]   (dev server running, real data in public/data)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`${m.type()}: ${m.text()}`);
  if (m.type() === "warning" && !/GPU stall|swiftshader|ReadPixels|software WebGL/i.test(m.text())) errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };

const state = () => page.evaluate(() => window.timeBubble.walk.debug.state());
const step = (s) => page.evaluate((s) => window.timeBubble.walk.debug.step(s), s);
const press = (code, down) => page.evaluate(([c, d]) => window.timeBubble.walk.debug.press(c, d), [code, down]);
const idle = () => page.evaluate(() => window.timeBubble.walk.debug.idle());
// software GL takes ~1 s a frame: draw exactly one, synchronously, before each screenshot
const shot = async (name) => { await page.evaluate(() => window.timeBubble.walk.debug.frameMs()); await page.screenshot({ path: `${out}/${name}.png` }); };

async function enterAt(lat, lon, label) {
  await page.goto(`${base}?age=150&pin=${lat},${lon}`);
  await page.waitForSelector("body.ready", { timeout: 60000 });
  await page.waitForSelector(".walk button", { timeout: 10000 });
  const t0 = Date.now();
  await page.getByRole("button", { name: "Walk here" }).click();
  if (await page.waitForSelector(".loading-screen", { timeout: 10000 }).then(() => true, () => false)) {
    // software GL can take tens of seconds a frame once plants are drawn; the loading shot is optional
    await page.screenshot({ path: `${out}/${label}-0-loading.png`, timeout: 60000 }).catch(() => console.log(`${label}: (loading screenshot skipped: slow software frame)`));
  }
  await page.waitForSelector(".walk-hud", { timeout: 120000 });
  console.log(`${label}: walk mode ready in ${Date.now() - t0} ms (worker: ${await page.evaluate(() => window.timeBubble.terrain.mode)})`);
  await idle();
  if (label !== "lowland") await page.evaluate(() => window.timeBubble.walk.debug.pause(true));
}
const resume = () => page.evaluate(() => window.timeBubble.walk.debug.pause(false));

// ---------------------------------------------------------------- 1. a lowland in Late Jurassic Europe
await enterAt(39.3, 10.2, "lowland");
let s = await state();
check(s.mode === "walk", `starts walking on land (ground ${s.groundM?.toFixed(1)} m, eye ${s.altitudeM.toFixed(1)} m)`);
check(Math.abs(s.altitudeM - s.groundM - 1.7) < 0.01, "eye is 1.7 m above the ground");
check(s.tiles.ready === 9 && s.tiles.current === "full", `3×3 ring loaded, current tile at full resolution (${s.tiles.ready}/9, ${s.tiles.current})`);
await page.evaluate(() => window.timeBubble.walk.debug.look(60, -4));

await page.evaluate(() => window.timeBubble.walk.debug.frameMs());
console.log("frame time (software GL, no GPU):", (await page.evaluate(() => window.timeBubble.walk.debug.frameMs())).toFixed(0), "ms;",
  JSON.stringify(await page.evaluate(() => { const r = window.timeBubble.walk.renderer.info.render; return { drawCalls: r.calls, triangles: r.triangles }; })));
// walk with real key presses for a moment (rAF-driven), then simulated steps
const before = await state();
await page.locator("#walk").focus();
await page.keyboard.down("KeyW");
await page.waitForTimeout(1200);
await page.keyboard.up("KeyW");
s = await state();
const movedM = Math.hypot((s.lat - before.lat) * 111_195, (s.lon - before.lon) * 111_195 * Math.cos(s.lat * Math.PI / 180));
check(movedM > 0.05, `W key moves the walker (${movedM.toFixed(2)} m in ~1.2 s of real time)`);
await page.evaluate(() => window.timeBubble.walk.debug.pause(true));   // drive frames explicitly from here
await page.evaluate(() => window.timeBubble.walk.debug.look(60, -4));
await shot("lowland-1-ground");

await press("ShiftLeft", true); await press("KeyW", true);
let minClear = Infinity;
for (let i = 0; i < 20; i++) {
  await step(1);
  s = await state();
  if (s.groundM !== null) minClear = Math.min(minClear, s.altitudeM - Math.max(0, s.groundM));
}
await press("ShiftLeft", false); await press("KeyW", false);
check(minClear >= 1.69, `INVARIANT: never below the ground while running 80 m (min clearance ${minClear.toFixed(2)} m)`);

// provenance overlay
await page.keyboard.press("KeyP");
await page.waitForTimeout(300);
await shot(`lowland-2-overlay`);
check(await page.locator(".walk-legend").isVisible(), "P shows the provenance overlay legend");
await page.keyboard.press("KeyP");

// inspect the ground under the crosshair
await page.evaluate(() => window.timeBubble.walk.debug.look(60, -25));
await page.keyboard.press("KeyI");
await page.waitForSelector(".info-card", { timeout: 10000 });
const card = await page.locator(".info-card").innerText();
console.log("card:", card.replace(/\n/g, " | ").slice(0, 400));
check(/Source cell/.test(card) && /PaleoDEM/.test(card), "inspect card names the source DEM cell");
check(/Ground cover/.test(card) && /Temperature/.test(card), "inspect card shows ground cover and modelled climate");
await shot(`lowland-3-card`);
await page.getByRole("button", { name: "Close" }).click();

// fly up and look at the horizon (far ring from the DEM)
await page.keyboard.press("KeyF");
await press("Space", true); await step(8); await press("Space", false);
await page.evaluate(() => window.timeBubble.walk.debug.look(20, -8));
s = await state();
check(s.mode === "fly" && s.altitudeM - s.groundM > 100, `F flies; ${Math.round(s.altitudeM - s.groundM)} m up after 8 s of Space`);
await shot(`lowland-4-flying`);

// cross tile edges: fly 6 km north and check the origin rebased without a jump
const o1 = await page.evaluate(() => window.timeBubble.walk.debug.origin());
const p1 = await state();
await press("KeyW", true); await press("ShiftLeft", true);   // 50 m/s
await page.evaluate(() => window.timeBubble.walk.debug.look(0, 0));
let jumps = 0, prev = await state();
for (let i = 0; i < 100; i++) {
  await step(1);
  const cur = await state();
  const d = Math.hypot((cur.lat - prev.lat) * 111_195, (cur.lon - prev.lon) * 111_195 * Math.cos(cur.lat * Math.PI / 180));
  if (d > 50 * 1.05 + 0.5) jumps++;
  prev = cur;
}
await press("KeyW", false); await press("ShiftLeft", false);
await idle();
const o2 = await page.evaluate(() => window.timeBubble.walk.debug.origin());
s = await state();
check(o1.lat0 !== o2.lat0, `origin rebased after ${(((s.lat - p1.lat) * 111_195) / 1000).toFixed(1)} km north`);
check(jumps === 0, "INVARIANT: no position jump when crossing tile edges");
check(Math.hypot(o2.x, o2.z) < 3000, `player stays within 3 km of the origin (${Math.hypot(o2.x, o2.z).toFixed(0)} m)`);
check(s.tiles.ready === 9, `ring refilled after the crossing (${s.tiles.ready}/9)`);

// land again and go back to the globe
await page.keyboard.press("KeyF");
s = await state();
console.log("after F:", s.mode, s.groundM?.toFixed(1));
await shot(`lowland-5-landed`);
await page.getByRole("button", { name: "Back to globe" }).click();
await page.waitForSelector(".timeline", { timeout: 10000 });
check(await page.locator("#globe").isVisible(), "Back to globe returns to the globe");

// ---------------------------------------------------------------- 2. the 150 Ma highest mountains
await enterAt(-14.1, -41.2, "mountain");
s = await state();
console.log("mountain start:", s.mode, s.groundM?.toFixed(0), "m");
await page.evaluate(() => window.timeBubble.walk.debug.look(200, 0));
await page.keyboard.press("KeyF");
await press("Space", true); await step(6); await press("Space", false);
await page.evaluate(() => window.timeBubble.walk.debug.look(200, -10));
await shot(`mountain-1-view`);
await page.keyboard.press("KeyP");
await shot(`mountain-2-overlay`);
await page.keyboard.press("KeyP");
await page.keyboard.press("BracketLeft"); for (let i = 0; i < 6; i++) await page.keyboard.press("BracketLeft");
await shot(`mountain-3-morning`);

// ---------------------------------------------------------------- 3. a sea point: starts in flight
await enterAt(30.2, 10.4, "sea");
s = await state();
check(s.mode === "fly", `a sea point starts in flight (ground ${s.groundM?.toFixed(0)} m)`);
await page.keyboard.press("KeyF");
s = await state();
check(s.mode === "fly", "F refuses to land on the sea");
await shot(`sea-1`);

// ---------------------------------------------------------------- 4. Aftermath (65 Ma): Impact Winter, then Fern Spike
for (const [phase, label] of [["impactWinter", "Impact Winter"], ["fernSpike", "Fern Spike"]]) {
  await page.goto(`${base}?age=65&pin=5,20`);
  await page.waitForSelector("body.ready", { timeout: 60000 });
  await page.getByLabel("Aftermath of the impact").check();
  await page.getByLabel(label).check();
  await page.getByRole("button", { name: "Walk here" }).click();
  await page.waitForSelector(".walk-hud", { timeout: 120000 });
  await idle();
  await page.evaluate(() => window.timeBubble.walk.debug.pause(true));
  s = await state();
  check(s.aftermath?.phase === phase, `${label}: walk mode carries the Aftermath phase`);
  check(/Aftermath/.test(await page.locator(".walk-status").innerText()), `${label}: HUD shows the Aftermath badge`);
  await page.keyboard.press("KeyF");
  await press("Space", true); await step(5); await press("Space", false);
  await page.evaluate(() => window.timeBubble.walk.debug.look(90, -12));
  await page.keyboard.press("KeyI");
  await page.waitForSelector(".info-card", { timeout: 20000 });
  const c = await page.locator(".info-card").innerText();
  // the crosshair may land on a plant (dead or alive) rather than the ground: both cards must name the Aftermath
  const isPlant = /Body plan|What it is/.test(c);
  check(/Aftermath/.test(c) && (isPlant || /Ground cover/.test(c)), `${label}: ${isPlant ? "plant" : "ground"} card shows the Aftermath source`);
  await shot(`aftermath-${phase}`);
}

console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "no console errors");
if (errors.length) failures++;
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
