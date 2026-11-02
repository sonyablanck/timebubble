// Interface panels (ui §0b) and sea/sky/photo (render §6b, ui §6b) on real data.
// Intro on a first visit only; H for help; settings persist and apply to the walk; About lists the
// data and papers; the terrain card's global-mean line; depth-tinted sea; heat haze; photo mode.
// Usage: node tests/browser/panels_sea_browser.mjs [url] [outDir]   (dev server running, real data in public/data)
import { mkdirSync } from "node:fs";
import pw from "playwright";

const base = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "shots";
mkdirSync(out, { recursive: true });
const browser = await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };
const W = "window.timeBubble.walk", ev = (s) => page.evaluate(s);
const shot = async (name) => { await ev(`${W}.debug.frameMs()`); await page.screenshot({ path: `${out}/${name}.png` }); };

// 1. intro on a first visit to the globe, not after
await page.goto(base);
await page.waitForSelector("body.ready", { timeout: 60000 });
check(await page.locator(".intro").isVisible(), "intro shows on a first visit");
await page.screenshot({ path: `${out}/panels-1-intro.png` });
await page.getByRole("button", { name: "Start" }).click();
await page.reload();
await page.waitForSelector("body.ready", { timeout: 60000 });
check(await page.locator(".intro").count() === 0, "intro does not show again");

// 2. H opens help, Esc closes it
await page.keyboard.press("KeyH");
check(await page.getByRole("dialog", { name: /help/i }).isVisible(), "H opens help");
await page.keyboard.press("Escape");
check(await page.getByRole("dialog").count() === 0, "Esc closes it");

// 3. About lists the datasets, papers and maintainer
await page.getByRole("button", { name: "About & credits" }).click();
await page.waitForTimeout(500);
const about = await page.getByRole("dialog").innerText();
check(/PALEOMAP/.test(about) && /Paleobiology Database/i.test(about), "About lists the datasets");
check(/Judd/.test(about) && /Damuth/.test(about), "About lists the papers");
check(/Sonya Blanck/.test(about), "About names the maintainer");
await page.screenshot({ path: `${out}/panels-2-about.png` });
await page.keyboard.press("Escape");

// 4. settings persist across a reload
await page.getByRole("button", { name: "Settings" }).click();
await page.getByLabel("Detail").selectOption("low");
await page.getByLabel(/Reduced motion/).check();
await page.getByLabel("Text size").selectOption("1.25");
await page.screenshot({ path: `${out}/panels-3-settings.png` });
await page.keyboard.press("Escape");
await page.reload();
await page.waitForSelector("body.ready", { timeout: 60000 });
const saved = await ev(`JSON.parse(localStorage.getItem("tb.settings"))`);
check(saved.detail === "low" && saved.reducedMotion === true && saved.textScale === 1.25, "settings persist in local storage");
check(await ev(`getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim()`) === "1.25", "text size applies after a reload");

// 5. walk at Hell Creek, 70 Ma: settings applied, global-mean line, sea texture, haze
await page.goto(`${base}?age=70&pin=54.9,-80.3`);
await page.waitForSelector(".walk button", { timeout: 60000 });
await page.getByRole("button", { name: "Walk here" }).click();
await page.waitForSelector(".walk-hud", { timeout: 180000 });
await ev(`${W}.debug.idle()`);
await ev(`${W}.debug.pause(true)`);
check(await ev(`${W}.renderer.getPixelRatio()`) === 1, "detail low applies (pixel ratio 1)");
await ev(`${W}.debug.look(0, -30)`);
await page.locator("#walk").focus();
await page.keyboard.press("KeyI");
await page.waitForSelector(".info-card", { timeout: 30000 });
const card = await page.locator(".info-card").innerText();
check(/Global mean/.test(card) && /Judd/.test(card), `terrain card shows the global mean (${(card.match(/Global mean[^\n]*\n?[^\n]*/) ?? [""])[0].replace(/\n/g, " ")})`);
await page.locator(".info-card").getByRole("button", { name: "Close" }).click();   // not Esc: that would leave the walk

// the Western Interior Seaway shore east of the pin (1° globe grid: land at 77.5°W, sea at 76.5°W)
let sea = null;
for (const [lat, lon] of [[54, -77], [54, -77.3], [54, -76.7], [54.3, -77], [53.7, -77]]) {
  await ev(`${W}.debug.teleport(${lat}, ${lon})`);
  await ev(`${W}.debug.idle()`);
  await ev(`${W}.debug.step(0.05)`);
  sea = await ev(`${W}.debug.sea()`);
  if (sea.wetShare > 0.02 && sea.wetShare < 0.98) { console.log(`  coast at ${lat}, ${lon}`); break; }
}
check(sea && sea.min < 0 && sea.max > 0 && sea.wetShare > 0.02, `sea texture spans a shore (floor ${sea?.min.toFixed(0)}..${sea?.max.toFixed(0)} m, ${Math.round((sea?.wetShare ?? 0) * 100)}% wet, ${Math.round((sea?.loadedShare ?? 0) * 100)}% loaded)`);
check(sea && sea.haze >= 0 && sea.haze <= 1, `haze in range (${sea?.haze.toFixed(2)})`);
await page.keyboard.press("KeyF");
await ev(`${W}.debug.press("Space", true)`); await ev(`${W}.debug.step(4)`); await ev(`${W}.debug.press("Space", false)`);
for (const h of [0, 90, 180, 270]) { await ev(`${W}.debug.look(${h}, -25)`); await shot(`sea-${h}`); }

// 6. photo mode: K hides the HUD; Save writes a PNG with the caption strip
await page.locator("#walk").focus();
await page.keyboard.press("KeyK");
check(await page.locator(".photo-bar").isVisible() && await page.locator(".walk-status").count() === 0, "K hides the HUD and shows the photo bar");
check(!(await page.locator(".top-buttons").isVisible()), "top buttons hidden in photo mode");
const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save PNG" }).click()]);
const path = `${out}/${dl.suggestedFilename()}`;
await dl.saveAs(path);
check(/^timebubble_70Ma_.*\.png$/.test(dl.suggestedFilename()), `PNG named ${dl.suggestedFilename()}`);
const dims = await page.evaluate(async () => {
  const c = window.timeBubble.walk.renderer.domElement;
  return { w: c.width, h: c.height };
});
const png = await import("node:fs").then((fs) => fs.readFileSync(path));
const pw2 = png.readUInt32BE(16), ph2 = png.readUInt32BE(20);
check(pw2 === dims.w && ph2 > dims.h, `PNG keeps the view size and adds a caption strip (${pw2}×${ph2} from ${dims.w}×${dims.h})`);
await page.getByRole("button", { name: "Done" }).click();
check(await page.locator(".walk-status").isVisible(), "Done returns the HUD");

console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "no console errors");
await browser.close();
console.log(failures || errors.length ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures || errors.length ? 1 : 0);
