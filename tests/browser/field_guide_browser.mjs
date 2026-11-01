// Field guide (G) at Hell Creek, 70 Ma, on real data: roster, links, representative-fauna toggle.
// Usage: node tests/browser/field_guide_browser.mjs [url]   (dev server running, data with ecology/)
import pw from "playwright";
const base = process.argv[2] ?? "http://localhost:5173/";
const b = await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await b.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${base}?age=70&pin=54.9,-80.3`);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.getByRole("button", { name: "Walk here" }).click();
await page.waitForSelector(".walk-hud", { timeout: 120000 });
await page.evaluate(() => window.timeBubble.walk.debug.idle());
await page.evaluate(() => { const d = window.timeBubble.walk.debug; d.pause(true); d.look(90, -10); d.frameMs(); });
await page.keyboard.press("KeyG");
await page.waitForSelector(".field-guide li", { timeout: 20000 });
const intro = await page.locator(".field-guide .legend-note").first().innerText();
console.log("intro:", intro.replace(/\n/g, " "));
console.log("first rows:", (await page.locator(".field-guide li").first().innerText()).replace(/\n/g, " | "));
await page.screenshot({ path: "/tmp/guide-on.png" });
await page.getByLabel(/Representative fauna/).uncheck();
await page.evaluate(() => window.timeBubble.walk.debug.idle());
await page.waitForTimeout(500);
console.log("after off:", (await page.locator(".field-guide .legend-note").first().innerText()).match(/\d+ animals placed/)?.[0]);
const boosted = await page.locator(".field-guide .badge", { hasText: "density boosted" }).count();
console.log("boosted badges after off:", boosted);
console.log(errors.length ? "ERRORS " + errors.join(" ; ") : "no console errors");
await b.close();
