// Field guide "Locate" (ui/ §3) on real data at Hell Creek, 70 Ma: open the guide, locate a drawn
// dinosaur, check the HUD arrow and distance, walk towards it and see the distance fall, locate a
// plant type, check a taxon that isn't drawn nearby reports so, and Stop clears it.
// Usage: node tests/browser/locate_browser.mjs [url] [outDir]   (dev server running, real data in public/data)
import { mkdirSync } from "node:fs";
import pw from "playwright";

const base = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "shots";
mkdirSync(out, { recursive: true });
const browser = await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };
const W = "window.timeBubble.walk", ev = (s) => page.evaluate(s);
const state = () => ev(`${W}.debug.state()`);
const shot = async (name) => { await ev(`${W}.debug.frameMs()`); await page.screenshot({ path: `${out}/${name}.png` }); };

await page.goto(`${base}?age=70&pin=54.9,-80.3`);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.waitForSelector(".walk button");
await page.getByRole("button", { name: "Walk here" }).click();
await page.waitForSelector(".walk-hud", { timeout: 180000 });
await ev(`${W}.debug.idle()`);
await ev(`${W}.debug.pause(true)`);
await ev(`${W}.debug.step(0.2)`);

// 1. the guide lists Locate buttons for drawn taxa and for plant types
await page.getByRole("button", { name: "Field guide" }).click();
await page.waitForSelector(".field-guide");
const nAnimal = await page.locator(".field-guide .locate-btn").count();
const nPlant = await page.locator(".field-guide .plant-list button").count();
check(nAnimal > 10, `field guide offers Locate for drawn taxa (${nAnimal} buttons)`);
check(nPlant >= 3, `and for plant types (${nPlant})`);
await shot("locate-1-guide");

// 2. locate a large dinosaur: pick the first taxon whose plan is a ceratopsian, ornithopod or theropod
const target = await ev(`(() => {
  const e = ${W}.currentEcology().ecology;
  const r = e.roster.find((t) => ["ceratopsian", "ornithopod", "large_theropod"].includes(t.bodyPlan) && e.animals.some((a) => e.roster[a.taxon].key === t.key));
  return r ? { key: r.key, name: r.name } : null;
})()`);
check(!!target, `a large dinosaur is drawn on this tile (${target?.name})`);
await page.getByRole("button", { name: `Locate the nearest ${target.name}` }).click();
await page.waitForSelector(".locate-chip", { timeout: 10000 });
let s = await state();
check(s.locate?.found === true && s.locate.name === target.name, `HUD chip shows ${target.name}`);
check(!(await page.locator(".field-guide").count()), "the guide closes so the view is clear");
const d0 = s.locate.distanceM;
console.log(`  ${target.name}: ${Math.round(d0)} m, bearing ${Math.round(s.locate.bearingDeg)}°`);
check(/\d+(\.\d)? k?m/.test(await page.locator(".locate-chip").innerText()), "chip shows the distance");
await ev(`${W}.debug.look(${s.locate.bearingDeg}, 2)`);
await ev(`${W}.debug.step(0.05)`);
s = await state();
check(Math.abs(((s.locate.bearingDeg - s.headingDeg + 540) % 360) - 180) < 3, "facing the bearing puts it dead ahead");
check(/ahead|here/.test(await page.locator(".locate-chip").innerText()), "chip says it's ahead");
await shot("locate-2-beam");

// 3. walk (run) towards it: the distance falls
await ev(`${W}.debug.press("ShiftLeft", true)`); await ev(`${W}.debug.press("KeyW", true)`);
for (let i = 0; i < 6; i++) {
  await ev(`${W}.debug.step(2)`);
  s = await state();
  if (s.locate?.found) await ev(`${W}.debug.look(${s.locate.bearingDeg}, 2)`);
}
await ev(`${W}.debug.press("KeyW", false)`); await ev(`${W}.debug.press("ShiftLeft", false)`);
s = await state();
check(s.locate?.found && s.locate.distanceM < d0 - 20, `distance falls as you walk (${Math.round(d0)} → ${Math.round(s.locate?.distanceM)} m)`);
await shot("locate-3-closer");

// 3b. "Take me there" puts you a few body lengths away, facing it
await page.getByRole("button", { name: "Take me there" }).click();
await ev(`${W}.debug.idle()`);
await ev(`${W}.debug.step(0.1)`);
s = await state();
check(s.locate?.found && s.locate.distanceM < 40, `Take me there: ${Math.round(s.locate?.distanceM)} m away`);
check(Math.abs(((s.locate.bearingDeg - s.headingDeg + 540) % 360) - 180) < 20, "and facing it");
check(s.mode === "walk" && Math.abs(s.altitudeM - s.groundM - 1.7) < 0.05, "standing on the ground");
await shot("locate-4-there");
const card = await ev(`${W}.inspect(0, -0.05).then((c) => c.kind + ": " + c.title)`);
console.log("  crosshair card:", card);

// 4. Stop clears it
await page.getByRole("button", { name: "Stop" }).click();
s = await state();
check(s.locate === null && !(await page.locator(".locate-chip").count()), "Stop clears the marker and the chip");

// 5. a plant type
await page.getByRole("button", { name: "Field guide" }).click();
await page.locator(".field-guide .plant-list button").first().click();
await page.waitForSelector(".locate-chip");
s = await state();
check(s.locate?.found === true && s.locate.distanceM < 1800, `plant Locate finds one within draw distance (${s.locate?.name}, ${Math.round(s.locate?.distanceM)} m)`);
await page.getByRole("button", { name: "Stop" }).click();

// 6. a taxon that is not drawn nearby says so
const r = await ev(`${W}.debug.locate({ kind: "animal", key: "no-such-taxon", name: "Nonexistentosaurus" })`);
check(r && r.found === false, "a taxon with nothing drawn reports not found");
await page.waitForSelector(".walk-notice", { timeout: 5000 });
check(/none is drawn/.test(await page.locator(".walk-notice").innerText()), "and explains why");
check((await state()).locate === null, "no marker is left behind");

console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "no console errors");
if (errors.length) failures++;
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);
