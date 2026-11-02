// ui/ §4: preferences, kept in localStorage (wrapped in try/catch so the app works without it).
// The URL carries the view; storage carries preferences only.

export type Detail = "low" | "medium" | "high";

export interface Settings {
  detail: Detail;               // pixel ratio and plant draw distance
  shadows: boolean;
  representativeFauna: boolean;
  mouseSensitivity: number;     // 0.25–3, 1 = default
  invertY: boolean;
  textScale: number;            // 1, 1.25 or 1.5
  reducedMotion: boolean;       // no wind sway, no globe auto-rotation
}

const KEY = "tb.settings";

export function defaultSettings(): Settings {
  let reduced = false;
  try { reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { /* no matchMedia */ }
  let shadows = true;
  try { shadows = localStorage.getItem("tb.shadows") !== "0"; } catch { /* storage unavailable */ }
  return { detail: "high", shadows, representativeFauna: true, mouseSensitivity: 1, invertY: false, textScale: 1, reducedMotion: reduced };
}

/** Stored settings merged over the defaults; anything malformed falls back to the default. */
export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      detail: s.detail === "low" || s.detail === "medium" || s.detail === "high" ? s.detail : d.detail,
      shadows: typeof s.shadows === "boolean" ? s.shadows : d.shadows,
      representativeFauna: typeof s.representativeFauna === "boolean" ? s.representativeFauna : d.representativeFauna,
      mouseSensitivity: typeof s.mouseSensitivity === "number" && s.mouseSensitivity >= 0.25 && s.mouseSensitivity <= 3 ? s.mouseSensitivity : d.mouseSensitivity,
      invertY: typeof s.invertY === "boolean" ? s.invertY : d.invertY,
      textScale: [1, 1.25, 1.5].includes(s.textScale as number) ? s.textScale as number : d.textScale,
      reducedMotion: typeof s.reducedMotion === "boolean" ? s.reducedMotion : d.reducedMotion,
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: settings last for this visit */ }
}

/** Text size: scales the HTML interface (the 3D view is unaffected). */
export function applyTextScale(scale: number): void {
  document.documentElement.style.setProperty("--ui-scale", String(scale));
}

export function seenIntro(): boolean {
  try { return localStorage.getItem("tb.introSeen") === "1"; } catch { return true; }
}

export function markIntroSeen(): void {
  try { localStorage.setItem("tb.introSeen", "1"); } catch { /* storage unavailable */ }
}
