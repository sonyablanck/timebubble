// Headless check of the globe against real data: loads, renders, interacts, screenshots.
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "shots";
import { mkdirSync } from "node:fs";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const t0 = Date.now();
await page.goto(url);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.evaluate(() => document.querySelector(".intro button")?.click());   // the first-visit intro (added after this script)
await page.waitForTimeout(1500);
console.log("ready in", Date.now() - t0, "ms");
const label = () => page.locator(".slice-label").innerText();
console.log("label:", await label());
await page.screenshot({ path: `${out}/1-start.png` });

// hover over the centre of the globe
const box = await page.locator("#globe").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.waitForTimeout(300);
console.log("readout:", (await page.locator(".readout").innerText()).replace(/\n/g, " | "));

// click to pick
await page.mouse.click(cx + 40, cy - 30);
await page.waitForTimeout(300);
console.log("walk panel:", (await page.locator(".walk").innerText()).replace(/\n/g, " | "));

// step slices with the keyboard: two older
await page.locator("#globe").focus();
await page.keyboard.press("Escape");
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press("[");
await page.waitForTimeout(700);
await page.keyboard.press("[");
await page.waitForTimeout(900);
console.log("after [ [:", await label(), "| url:", new URL(page.url()).search);
await page.screenshot({ path: `${out}/2-older.png` });

// temperature layer
await page.getByLabel("Temperature", { exact: true }).check();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/3-temperature.png` });
console.log("legend:", (await page.locator(".layers .legend").nth(1).innerText()).replace(/\n/g, " | "));

// jump to 65 Ma with the slider, precipitation + provenance
const slider = page.getByRole("slider", { name: "Time slice" });
await slider.focus();
await page.keyboard.press("End");
await page.waitForTimeout(900);
console.log("slider end:", await label(), "| aria:", await slider.getAttribute("aria-valuetext"));
await page.getByLabel("Precipitation", { exact: true }).check();
await page.waitForTimeout(500);
console.log("temp still on?", await page.getByLabel("Temperature", { exact: true }).isChecked());
await page.screenshot({ path: `${out}/4-65ma-precip.png` });

// rotate to the other side and zoom
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx - 300, cy + 60, { steps: 10 });
await page.mouse.up();
await page.mouse.wheel(0, -600);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/5-rotated-zoomed.png` });

// reload from the URL: same view
const saved = page.url();
await page.waitForTimeout(700);
const saved2 = page.url();
await page.goto(saved2);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.waitForTimeout(1200);
console.log("reloaded label:", await label(), "| url restored:", page.url() === saved2, saved === saved2 ? "" : "(url settled)");
await page.screenshot({ path: `${out}/6-reloaded.png` });

console.log("console errors/warnings:", errors.length ? errors : "none");
await browser.close();
