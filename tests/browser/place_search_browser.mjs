// Headless check of "Where was my town?" (places/ §2–3) on real data. Nominatim is stubbed, so the
// check never touches the real service: search, choose, pin follows the plate across slices, crust
// that hadn't formed, typed coordinates, the link round trip, and the console.
//   node tests/browser/place_search_browser.mjs http://localhost:5173/ shots
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5173/";
const out = process.argv[3] ?? "shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const requests = [];
await page.route("https://nominatim.openstreetmap.org/**", async (route) => {
  requests.push(route.request().url());
  await route.fulfill({ contentType: "application/json", body: JSON.stringify([
    { lat: "50.8543", lon: "0.5735", display_name: "Hastings, East Sussex, England, United Kingdom", name: "Hastings" },
    { lat: "40.5871", lon: "-98.3887", display_name: "Hastings, Adams County, Nebraska, United States", name: "Hastings" },
  ]) });
});

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

await page.goto(`${url}?age=150`);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.evaluate(() => document.querySelector(".modal-backdrop button")?.click());   // dismiss the intro
await page.keyboard.press("Escape");
await page.waitForTimeout(800);

// "/" focuses the box; Enter searches
await page.keyboard.press("/");
check(await page.evaluate(() => document.activeElement?.id === "place-q"), '"/" focuses the search box');
await page.keyboard.type("Hastings");
await page.keyboard.press("Enter");
await page.waitForSelector(".place-results li");
check((await page.locator(".place-results li").count()) === 2, "two results listed");
check((await page.locator(".place-search").innerText()).includes("OpenStreetMap contributors"), "OSM attribution shown");
check(requests.length === 1 && requests[0].includes("format=jsonv2"), `one Nominatim request (${requests.length})`);
await page.screenshot({ path: `${out}/place-1-results.png` });

await page.locator(".place-results button").first().click();
await page.waitForSelector(".place-name");
await page.waitForTimeout(1500);
const panel150 = await page.locator(".walk").innerText();
console.log("150 Ma:", panel150.replace(/\n/g, " | "));
check(/Hastings/.test(panel150) && /inferred/.test(panel150), "pin panel names the place, tagged inferred");
const pin150 = await page.evaluate(() => window.timeBubble.globe.getPin());
check(pin150 && Math.abs(pin150.lat - 42.45) < 0.2 && Math.abs(pin150.lon - 9.57) < 0.2, `pin at pyGPlates' 150 Ma position (${pin150?.lat?.toFixed(2)}, ${pin150?.lon?.toFixed(2)})`);
check(new URL(page.url()).searchParams.get("pn")?.startsWith("Hastings"), "link carries the place");
await page.screenshot({ path: `${out}/place-2-hastings-150.png` });

// the pin follows the plate to 250 Ma
await page.evaluate(() => window.timeBubble.globe.setSlice(250));
await page.waitForTimeout(1500);
const pin250 = await page.evaluate(() => window.timeBubble.globe.getPin());
check(pin250 && Math.abs(pin250.lat - 14.41) < 0.2 && Math.abs(pin250.lon - 15.10) < 0.2, `pin moved with Eurasia to 250 Ma (${pin250?.lat?.toFixed(2)}, ${pin250?.lon?.toFixed(2)})`);
check((await page.locator(".walk").innerText()).includes("250 Ma"), "panel text follows the slice");
await page.screenshot({ path: `${out}/place-3-hastings-250.png` });

// typed coordinates: Reykjavik, no network request, crust not formed at 65 Ma
await page.evaluate(() => window.timeBubble.globe.setSlice(65));
await page.waitForTimeout(1200);
await page.locator("#place-q").fill("64.146, -21.942");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
const iceland = await page.locator(".walk").innerText();
console.log("Iceland:", iceland.replace(/\n/g, " | "));
check(/Not on the map at 65 Ma/.test(iceland) && /15 Ma/.test(iceland) && /younger than every slice/.test(iceland), "Iceland: crust not formed yet at 65 Ma, and no slice will show it");
check(requests.length === 1, "coordinates searched without a network request");
check(!(await page.evaluate(() => window.timeBubble.globe.getPin())), "no pin for crust that hadn't formed");
await page.screenshot({ path: `${out}/place-4-iceland-65.png` });

// a click on the globe replaces the searched place
const box = await page.locator("#globe").boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1200);   // the link is rewritten after a 500 ms debounce
check(!(await page.locator(".place-name").count()) && !new URL(page.url()).searchParams.get("place"), "clicking the globe clears the searched place");

// link round trip
await page.goto(`${url}?age=100&place=50.8543,0.5735&pn=Hastings`);
await page.waitForSelector("body.ready", { timeout: 60000 });
await page.waitForSelector(".place-name", { timeout: 20000 });
check((await page.locator(".place-name").innerText()).includes("100 Ma"), "a link with a place reopens it");

console.log("console:", errors.length ? errors : "clean");
check(errors.length === 0, "no console errors or warnings");
await browser.close();
process.exit(failures ? 1 : 0);
