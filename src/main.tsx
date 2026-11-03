import { render } from "preact";
import { DataError, DataStore } from "./data";
import { DEFAULT_EXAGGERATION, DEFAULT_LAYERS, DEFAULT_VIEW, Globe } from "./globe";
import { WalkRenderer } from "./render/walk";
import { TerrainClient } from "./terrain/client";
import { App } from "./ui/App";
import { viewFromUrl } from "./ui/url";
import { loadSettings } from "./ui/settings";
import "./styles.css";

// Entry point: the globe screen, and walk mode (terrain/ + render/) created on first use.

async function start(): Promise<void> {
  const root = document.getElementById("app")!;
  const canvas = document.getElementById("globe") as HTMLCanvasElement;

  if (!Globe.supported()) {
    document.body.classList.add("no-webgl");
    root.innerHTML = `<div class="fallback"><h1>Time Bubble needs WebGL2</h1>
      <p>Please use a recent desktop browser (Chrome, Edge, Firefox or Safari 15+) with hardware acceleration on.</p></div>`;
    return;
  }

  const url = viewFromUrl(location.search);
  const reducedMotion = loadSettings().reducedMotion;   // ui §4: stored preference, defaulting to the OS setting
  const store = new DataStore();
  const globe = new Globe();
  const debug: Record<string, unknown> = { globe, store };
  (window as unknown as { timeBubble?: unknown }).timeBubble = debug;   // for debugging and tests
  let walk: WalkRenderer | null = null;
  const getWalk = () => {
    if (!walk) {
      const terrain = new TerrainClient({ baseUrl: store.baseUrl });
      walk = new WalkRenderer(document.getElementById("walk") as HTMLCanvasElement, terrain);
      debug.walk = walk;
      debug.terrain = terrain;
    }
    return walk;
  };

  try {
    await globe.mount(canvas, store, {
      reducedMotion,
      initialAge: url.age ?? 150,
      initialView: url.camera ?? DEFAULT_VIEW,
      initialLayers: url.layers ?? DEFAULT_LAYERS,
      initialExaggeration: url.exaggeration ?? DEFAULT_EXAGGERATION,
    });
  } catch (e) {
    const msg = e instanceof DataError
      ? (e.kind === "missing" && e.path.endsWith("manifest.json")
        ? "No data found. Run the pipeline first (see README → Quick start) so public/data/manifest.json exists."
        : e.message)
      : String(e);
    root.innerHTML = `<div class="fallback"><h1>Couldn't load the data</h1><p></p>
      <button type="button" onclick="location.reload()">Retry</button></div>`;
    root.querySelector("p")!.textContent = msg;
    console.error(e);
    return;
  }
  if (url.pin && !url.place) globe.pin(url.pin.lat, url.pin.lon);
  root.textContent = "";                       // clear the loading message
  render(<App globe={globe} store={store} getWalk={getWalk} initialWalk={url.walk} initialPlace={url.place} />, root);
  document.body.classList.add("ready");
}

void start();
