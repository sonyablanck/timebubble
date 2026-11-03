// Accessibility audit (ui §9, §11) on real data, in headless Chromium:
//  - axe-core (WCAG 2.0/2.1/2.2 A and AA, plus best practice) on every screen and panel
//  - dialogs: focus starts inside, Tab and Shift+Tab stay inside, Esc closes, focus returns to the opener
//  - every Tab stop on the globe screen shows a visible focus indicator
//  - a keyboard-only journey: search a place → Walk here → info card → field guide → back to the globe
//  - text at 150% (and a 1280 × 720 window): HUD panels stay on screen and don't overlap
//  - the app works when localStorage throws; prefers-reduced-motion is honoured
// Needs axe-core and Playwright (dev only, not project dependencies):
//   npm install --no-save axe-core playwright
//   node tests/browser/a11y_browser.mjs http://localhost:5173/ shots
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pw from "playwright";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const base = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "shots";
mkdirSync(out, { recursive: true });
const browser = await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };
const errors = [];
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, ...opts });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.route("https://nominatim.openstreetmap.org/**", (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify([{ lat: "47.32", lon: "-106.91", display_name: "Jordan, Garfield County, Montana, United States", name: "Jordan" }]) }));
  return page;
}

async function axe(page, label, include) {
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async (inc) => {
    // the WebGL canvases are not content; everything else is checked
    return window.axe.run(inc ? { include: [inc] } : { exclude: [["#globe"], ["#walk"]] }, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      resultTypes: ["violations"],
    });
  }, include ?? null);
  const v = res.violations;
  check(v.length === 0, `axe: ${label}${v.length ? ` — ${v.length} rule(s)` : ""}`);
  for (const x of v) {
    console.log(`     [${x.impact}] ${x.id}: ${x.help} (${x.nodes.length})`);
    for (const n of x.nodes.slice(0, 4)) console.log(`        ${n.target.join(" ")}  ${(n.failureSummary ?? "").split("\n").slice(1, 2).join(" ").trim()}`);
  }
  return v;
}

/** Tab through a dialog: focus must never leave it. */
async function trapCheck(page, label) {
  const results = [];
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(key);
      results.push(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')));
    }
  }
  check(results.every(Boolean), `${label}: Tab and Shift+Tab stay inside the dialog (${results.filter((x) => !x).length} escapes in 50)`);
}

const focusInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
  const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : el.closest("label")?.textContent;
  const name = el.getAttribute("aria-label")?.slice(0, 30) || label?.trim().slice(0, 30) || el.textContent?.trim().slice(0, 30) || el.getAttribute("placeholder") || el.id || el.tagName;
  el.dataset.a11yId ??= String(Math.random()).slice(2, 10);
  return { tag: el.tagName.toLowerCase(), name, ring, id: el.dataset.a11yId };
});

// ---------------------------------------------------------------- 1. first visit: intro
let page = await newPage();
await page.goto(base);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.waitForSelector(".intro");
check(await page.evaluate(() => !!document.activeElement?.closest(".intro")), "intro: focus starts in the dialog");
await axe(page, "intro");
await trapCheck(page, "intro");
await page.keyboard.press("Escape");
check(await page.locator(".intro").count() === 0, "intro: Esc closes it");

// ---------------------------------------------------------------- 2. globe screen
await page.waitForTimeout(800);
await axe(page, "globe screen");
check(await page.locator("html").getAttribute("lang") !== null, "page declares its language");
const slider = page.getByRole("slider", { name: "Time slice" });
check(/million years ago/.test(await slider.getAttribute("aria-valuetext") ?? ""), `time slider announces "${await slider.getAttribute("aria-valuetext")}"`);

// Tab order on the globe screen, with focus rings
await page.evaluate(() => document.activeElement?.blur());
const stops = [];
for (let i = 0; i < 30; i++) {
  await page.keyboard.press("Tab");
  const f = await focusInfo(page);
  if (!f) continue;
  if (stops.length && stops[0].id === f.id) break;   // wrapped
  stops.push(f);
}
console.log("     tab order:", stops.map((s) => `${s.tag}:${s.name}${s.ring ? "" : " (NO RING)"}`).join(" → "));
check(stops.length >= 8, `globe screen has ${stops.length} tab stops`);
check(stops.every((s) => s.ring), `every tab stop shows a focus ring (${stops.filter((s) => !s.ring).map((s) => s.name).join(", ") || "all do"})`);
check(stops.some((s) => s.tag === "canvas"), "the globe itself is reachable by Tab (arrow keys rotate it, Enter picks)");
// Enter on the focused globe picks the centre of the view
await page.locator("#globe").focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check(await page.locator(".walk").count() === 1, "Enter on the focused globe picks a place");
await page.keyboard.press("Escape");

// each panel: axe, focus trap, Esc, focus returns to its button
for (const name of ["Help", "Settings", "About & credits"]) {
  const btn = page.getByRole("button", { name, exact: true });
  await btn.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(400);
  await axe(page, `${name} dialog`);
  await trapCheck(page, `${name} dialog`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const back = await page.evaluate(() => document.activeElement?.textContent?.trim());
  check(back === name, `${name}: Esc closes and returns focus to its button (focus on "${back ?? "body"}")`);
}

// ---------------------------------------------------------------- 3. keyboard journey
await page.keyboard.press("/");
await page.keyboard.type("Jordan, Montana");
await page.keyboard.press("Enter");
await page.waitForSelector(".place-results button");
await axe(page, "search results");
let onResult = false;
for (let i = 0; i < 3 && !onResult; i++) {
  await page.keyboard.press("Tab");
  onResult = await page.evaluate(() => !!document.activeElement?.closest(".place-results"));
}
check(onResult, "Tab from the search box reaches the first result (after the Search button)");
await page.keyboard.press("Enter");
await page.waitForSelector(".place-name", { timeout: 20000 });
await page.waitForTimeout(1200);
await axe(page, "place panel");
const f1 = await focusInfo(page);
check(f1 !== null && f1.tag !== "body", `after choosing a result, focus is somewhere useful (${f1?.name ?? "body"})`);
// reach Walk here by keyboard
let reached = false;
for (let i = 0; i < 25 && !reached; i++) {
  reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === "Walk here");
  if (!reached) await page.keyboard.press("Tab");
}
check(reached, "Walk here is reachable by Tab");
await page.screenshot({ path: `${out}/a11y-1-place.png` });
await page.keyboard.press("Enter");
await page.waitForSelector(".walk-hud", { timeout: 180000 });
await page.evaluate(() => window.timeBubble.walk.debug.idle());
await page.evaluate(() => window.timeBubble.walk.debug.pause(true));
check(await page.evaluate(() => document.activeElement?.id === "walk"), "entering walk mode focuses the view");
await axe(page, "walk HUD");
await page.keyboard.press("KeyI");
await page.waitForSelector(".info-card", { timeout: 30000 });
await axe(page, "info card");
await page.locator(".info-card").getByRole("button", { name: "Close" }).click();
await page.locator("#walk").focus();
await page.keyboard.press("KeyG");
await page.waitForSelector(".field-guide", { timeout: 30000 });
await page.waitForTimeout(500);
await axe(page, "field guide");
const fgFocus = await page.evaluate(() => !!document.activeElement?.closest(".field-guide"));
check(fgFocus, "field guide: focus moves into it");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check(await page.locator(".field-guide").count() === 0, "Esc closes the field guide");
await page.locator("#walk").focus();
await page.keyboard.press("KeyR");
await page.waitForSelector(".cite-dialog", { timeout: 30000 });
await page.waitForTimeout(500);
await axe(page, "cite dialog");
check(await page.evaluate(() => !!document.activeElement?.closest(".cite-dialog")), "cite dialog: focus moves into it");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check(await page.locator(".cite-dialog").count() === 0, "Esc closes the cite dialog");
await page.locator("#walk").focus();
await page.keyboard.press("Escape");
await page.waitForSelector(".slider", { timeout: 20000 });
check(true, "Esc from the walk view returns to the globe");
await page.waitForTimeout(500);
check(await page.evaluate(() => document.activeElement && document.activeElement !== document.body), `back on the globe, focus is not lost (${(await focusInfo(page))?.name ?? "body"})`);

await page.context().close();   // the walk keeps a software-GL loop busy: free the CPU first

// ---------------------------------------------------------------- 4. text at 150%
for (const vp of [{ width: 1400, height: 860 }, { width: 1280, height: 720 }]) {
  const p = await newPage({ viewport: vp });
  await p.addInitScript(() => { try { localStorage.setItem("tb.settings", JSON.stringify({ textScale: 1.5 })); localStorage.setItem("tb.introSeen", "1"); } catch { /* */ } });
  await p.goto(`${base}?age=150&place=50.8543,0.5735&pn=Hastings`, { timeout: 90000 });
  await p.waitForSelector("body.ready", { timeout: 60000 });
  await p.evaluate(() => document.querySelector(".intro button")?.click());
  await p.waitForSelector(".place-name", { timeout: 20000 });
  await p.waitForTimeout(800);
  const boxes = await p.evaluate(() => {
    const sel = [".layers", ".place-search", ".readout", ".walk", ".timeline", ".top-buttons", ".hud-top .slice-label"];
    return sel.map((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { s, l: r.left, t: r.top, r: r.right, b: r.bottom } : null; }).filter(Boolean);
  });
  const W = vp.width, H = vp.height;
  const off = boxes.filter((b) => b.l < -1 || b.t < -1 || b.r > W + 1 || b.b > H + 1).map((b) => b.s);
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) overlaps.push(`${a.s}×${b.s}`);
  }
  await p.screenshot({ path: `${out}/a11y-3-text150-${vp.width}.png` });
  check(off.length === 0, `150% text at ${W}×${H}: panels on screen${off.length ? ` (off: ${off.join(", ")})` : ""}`);
  check(overlaps.length === 0, `150% text at ${W}×${H}: panels don't overlap${overlaps.length ? ` (${overlaps.join(", ")})` : ""}`);
  await p.context().close();
}

// ---------------------------------------------------------------- 5. storage throwing; reduced motion
{
  const p = await newPage({ reducedMotion: "reduce" });
  await p.addInitScript(() => {
    for (const m of ["getItem", "setItem", "removeItem"]) Storage.prototype[m] = () => { throw new DOMException("denied", "SecurityError"); };
  });
  await p.goto(base, { timeout: 90000 });
  await p.waitForSelector("body.ready", { timeout: 60000 });
  check(true, "app loads with localStorage throwing");
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Settings", exact: true }).click();
  check(await p.getByLabel(/Reduced motion/).isChecked(), "prefers-reduced-motion turns on Reduced motion by default");
  await p.context().close();
}

console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "no console errors");
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
