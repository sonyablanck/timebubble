// Provenance end to end (provenance §3–§5) on real data at Hell Creek, 70 Ma: the overlay's three
// modes and in-view shares, the link that reopens the walk view, "cite this view", the JSON and
// CSV reports, and reopening the link straight into walk mode.
// Usage: node tests/browser/provenance_browser.mjs [url] [outDir]   (dev server running, real data in public/data)
import { mkdirSync, readFileSync } from "node:fs";
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
const state = () => ev(`${W}.debug.state()`);
const shot = async (name) => { await ev(`${W}.debug.frameMs()`); await page.screenshot({ path: `${out}/${name}.png` }); };

await page.goto(`${base}?age=70&pin=54.9,-80.3`);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.waitForSelector(".walk button");
await page.getByRole("button", { name: "Walk here" }).click();
await page.waitForSelector(".walk-hud", { timeout: 180000 });
await ev(`${W}.debug.idle()`);
await ev(`${W}.debug.pause(true)`);
await ev(`${W}.debug.look(250, -4)`);
await page.locator("#walk").focus();

// 1. overlay: P → source with in-view shares
await page.keyboard.press("KeyP");
await ev(`${W}.debug.shares()`); await ev(`${W}.debug.step(0.05)`);
let s = await state();
check(s.overlayMode === "source", "P turns the overlay on in source mode");
const sum = s.shares ? s.shares.data + s.shares.inferred + s.shares.generated : 0;
check(s.shares && Math.abs(sum - 1) < 0.005, `INVARIANT: in-view shares sum to 100% (${s.shares && Object.entries(s.shares).map(([k, v]) => `${k} ${k === "samples" ? v : Math.round(v * 100) + "%"}`).join(", ")})`);
await page.waitForSelector(".walk-legend .shares");
check(/In view: \d+% data · \d+% inferred · \d+% generated/.test(await page.locator(".walk-legend .shares").innerText()), "legend shows the in-view shares");
await shot("prov-1-source");

// 2. Shift+P → focus; pick a flag
await page.keyboard.press("Shift+KeyP");
s = await state();
check(s.overlayMode === "focus", "Shift+P moves to focus mode");
await page.locator(".walk-legend select").selectOption("TAXON_FROM_DATA");
await ev(`${W}.debug.step(0.05)`);
s = await state();
check(s.focusFlag === "TAXON_FROM_DATA", "the legend's picker sets the focused flag");
check(/fossil occurrence within 150 km/.test(await page.locator(".walk-legend").innerText()), "and explains it");
await shot("prov-2-focus");

// 3. Shift+P → evidence, with the nearest fossil site
await page.keyboard.press("Shift+KeyP");
await ev(`${W}.debug.step(0.05)`);
s = await state();
check(s.overlayMode === "evidence" && s.nearestSiteKm !== null, `Shift+P moves to evidence mode (nearest site ${s.nearestSiteKm?.toFixed(1)} km)`);
await shot("prov-3-evidence");

// 4. the URL follows the walk view
await ev(`${W}.debug.step(1.2)`);
await page.waitForFunction(() => /[?&]walk=/.test(location.search) && /ov=evidence/.test(location.search), null, { timeout: 5000 });
const link = await ev("location.href");
check(/look=250,-4/.test(link), `the link records the view (${link.replace(/^.*\?/, "?")})`);

// 5. R → cite this view, with JSON and CSV reports
await page.keyboard.press("KeyR");
await page.waitForSelector(".cite-dialog textarea", { timeout: 20000 });
const cite = await page.locator(".cite-dialog textarea").inputValue();
check(/^Time Bubble v\d+\.\d+\.\d+ \(data [0-9a-f]+\), 70 Ma, 54\.9\d°N 80\.3\d°W/.test(cite), "the citation names the version, data, slice and place");
check(cite.includes("walk=") && /Scotese et al\., 2024/.test(cite) && /Paleobiology Database \(accessed/.test(cite), "and the sources and the link");
await shot("prov-4-cite");
const [dj] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download report (JSON)" }).click()]);
const report = JSON.parse(readFileSync(await dj.path(), "utf8"));
check(report.taxa.length > 50 && report.taxa.every((t) => t.occurrence_ids.length > 0), `JSON report lists ${report.taxa.length} taxa, each with occurrence IDs`);
check(report.references.length >= 8 && report.references.every((r) => !/missing/.test(r.text)), `and ${report.references.length} resolved references`);
check(report.climate?.temperature?.source_age_ma === 70 && report.view.overlay.mode === "evidence", "with the climate sources and the overlay mode");
check(Math.abs(report.levels.in_view.data + report.levels.in_view.inferred + report.levels.in_view.generated - 1) < 0.001, "and the in-view shares");
const [dc] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Taxa (CSV)" }).click()]);
const csv = readFileSync(await dc.path(), "utf8").trim().split("\n");
check(csv.length === report.taxa.length + 2 && csv[1].startsWith("name,rank,body_plan,level"), `CSV has a header and ${csv.length - 2} taxon rows`);
await page.getByRole("button", { name: "Close" }).last().click();

// 6. the link reopens straight into walk mode with the same view
const page2 = await ctx.newPage();
page2.on("pageerror", (e) => errors.push(`pageerror (reopened): ${e.message}`));
await page2.goto(link);
await page2.waitForSelector(".walk-hud", { timeout: 180000 });
await page2.evaluate(() => window.timeBubble.walk.debug.idle());
await page2.evaluate(() => window.timeBubble.walk.debug.pause(true));
const s2 = await page2.evaluate(() => window.timeBubble.walk.debug.state());
check(Math.abs(s2.lat - s.lat) < 1e-3 && Math.abs(s2.lon - s.lon) < 1e-3, "the link reopens at the same place");
check(Math.abs(((s2.headingDeg - 250 + 540) % 360) - 180) < 1 && s2.overlayMode === "evidence", "facing the same way, in the same overlay mode");

console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "no console errors");
if (errors.length) failures++;
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);
