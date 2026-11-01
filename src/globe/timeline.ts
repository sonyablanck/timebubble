import type { Manifest } from "../data";

// globe/ §8: the time slider's logic (ui/ draws it). Pure, so it is unit-tested.

export interface Tick { index: number; age: number; label: string; period: string; epoch: string; afterExtinction: boolean }
export interface Band { period: string; fromIndex: number; toIndex: number; afterExtinction: boolean }

export interface Timeline {
  ticks: Tick[];   // oldest first, as in the manifest
  bands: Band[];   // contiguous runs of ticks in the same period
}

export function buildTimeline(m: Manifest): Timeline {
  const ticks = m.slices.map((s, index) => ({
    index, age: s.age, label: s.label, period: s.period, epoch: s.epoch, afterExtinction: s.age < m.kpg_ma,
  }));
  const bands: Band[] = [];
  for (const t of ticks) {
    const last = bands[bands.length - 1];
    if (last && last.period === t.period) last.toIndex = t.index;
    else bands.push({ period: t.period, fromIndex: t.index, toIndex: t.index, afterExtinction: t.afterExtinction });
  }
  return { ticks, bands };
}

/** Index of the tick nearest to `age` (ties go to the older slice, like DataStore.slice). */
export function nearestIndex(tl: Timeline, age: number): number {
  let best = 0;
  tl.ticks.forEach((t, i) => {
    if (Math.abs(t.age - age) < Math.abs(tl.ticks[best]!.age - age)) best = i;
  });
  return best;
}

/** Step one slice older (−1) or younger (+1); never overshoots the ends. */
export function step(tl: Timeline, index: number, direction: -1 | 1): number {
  return Math.min(tl.ticks.length - 1, Math.max(0, index + direction));
}

/** Text for the ARIA slider: "150 million years ago, Late Jurassic". */
export function ariaText(t: Tick): string {
  return `${t.age} million years ago, ${t.epoch}${t.afterExtinction ? ", after the extinction" : ""}`;
}
