// Photo mode (ui §6b): the current view as a PNG with the "cite this view" text burnt into a strip
// along the bottom, so a shared image carries its own provenance.

/** Greedy word wrap for a 2D canvas context. Exported for tests (with a fake measure). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next) > maxWidth) { out.push(line); line = w; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** File name: timebubble_70Ma_47.12N_101.30W.png */
export function photoFileName(sliceMa: number, lat: number, lon: number): string {
  const f = (v: number, p: string, n: string) => `${Math.abs(v).toFixed(2)}${v >= 0 ? p : n}`;
  return `timebubble_${sliceMa}Ma_${f(lat, "N", "S")}_${f(lon, "E", "W")}.png`;
}

/** Copy the WebGL canvas and add the caption strip. The canvas must have preserveDrawingBuffer. */
export function composePhoto(src: HTMLCanvasElement, caption: string): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const scale = Math.max(1, w / 1600);
  const font = Math.round(14 * scale), pad = Math.round(12 * scale), lh = Math.round(font * 1.35);
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `${font}px system-ui, sans-serif`;
  const lines = wrapLines(caption, w - 2 * pad, (s) => ctx.measureText(s).width);
  const strip = lines.length * lh + 2 * pad;
  c.width = w;
  c.height = h + strip;
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = "#14181c";
  ctx.fillRect(0, h, w, strip);
  ctx.fillStyle = "#e8e4da";
  ctx.font = `${font}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, pad, h + pad + i * lh));
  return c;
}

export function downloadCanvas(c: HTMLCanvasElement, name: string): Promise<void> {
  return new Promise((resolve) => c.toBlob((blob) => {
    if (blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    resolve();
  }, "image/png"));
}
