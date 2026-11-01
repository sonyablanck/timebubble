// ecology §6: ambient behaviour, no AI. A small per-animal state machine, deterministic given the
// animal's seed and the clock: IDLE → WANDER → (GRAZE | DRINK | REST) → IDLE. Groups keep within a
// cohesion radius of their centre; no predation, fleeing or collisions beyond simple separation.
// Positions are local metres (x east, z south) in whatever frame the renderer uses.

import { mulberry32 } from "../terrain/noise";
import { PLAN_INFO, type AnimalPlan } from "./roster";

export type State = "idle" | "wander" | "graze" | "drink" | "rest" | "fly";

export interface Agent {
  plan: AnimalPlan;
  x: number; z: number;
  heading: number;           // radians, 0 = north (−z)
  homeX: number; homeZ: number;
  state: State;
  timer: number;             // seconds left in the state
  targetX: number; targetZ: number;
  speed: number;             // m/s while moving
  rnd: () => number;
  group: number;
}

export const HOME_RADIUS_M = 150;
export const COHESION_M = 40;

/** Is a local position usable by this animal (land, shore, sea…)? Supplied by the renderer. */
export type HabitatTest = (plan: AnimalPlan, x: number, z: number) => boolean;

export function makeAgent(plan: AnimalPlan, x: number, z: number, heading: number, seed: number, group: number, lengthM: number): Agent {
  const rnd = mulberry32(seed);
  const flier = PLAN_INFO[plan].realm === "air";
  return {
    plan, x, z, heading, homeX: x, homeZ: z, state: flier ? "fly" : "idle", timer: 1 + 4 * rnd(),
    targetX: x, targetZ: z, speed: flier ? 8 + 6 * rnd() : Math.max(0.3, Math.min(2.5, 0.35 * Math.sqrt(lengthM))), rnd, group,
  };
}

const HERBIVORE: ReadonlySet<AnimalPlan> = new Set(["sauropod", "prosauropod", "ornithopod", "ceratopsian", "ankylosaur", "stegosaur"]);

function nextState(a: Agent): State {
  const r = a.rnd();
  if (HERBIVORE.has(a.plan)) return r < 0.4 ? "wander" : r < 0.75 ? "graze" : r < 0.85 ? "drink" : "rest";
  return r < 0.5 ? "wander" : r < 0.65 ? "drink" : "rest";
}

/** Advance one agent by dt seconds. groupCentre keeps herds together. */
export function step(a: Agent, dt: number, ok: HabitatTest, groupCentre?: { x: number; z: number }): void {
  if (a.state === "fly") {
    // smooth loops over home; fliers ignore the ground test
    const t = a.timer += dt;
    const r = 60 + 40 * Math.sin(t * 0.05 + a.homeX);
    const w = a.speed / r;
    a.x = a.homeX + r * Math.cos(t * w);
    a.z = a.homeZ + r * Math.sin(t * w);
    a.heading = Math.atan2(-Math.sin(t * w), -Math.cos(t * w)) + Math.PI / 2;
    return;
  }
  a.timer -= dt;
  if (a.state === "wander" || a.state === "drink") {
    const dx = a.targetX - a.x, dz = a.targetZ - a.z, d = Math.hypot(dx, dz);
    if (d < 0.5) { a.state = a.state === "drink" ? "rest" : "idle"; a.timer = 2 + 6 * a.rnd(); return; }
    const s = Math.min(d, a.speed * dt);
    const nx = a.x + (dx / d) * s, nz = a.z + (dz / d) * s;
    if (!ok(a.plan, nx, nz)) { a.state = "idle"; a.timer = 1 + 2 * a.rnd(); return; }   // stop at the shore
    a.x = nx; a.z = nz;
    a.heading = Math.atan2(dx, -dz);
    if (a.timer <= 0) { a.state = "idle"; a.timer = 2 + 4 * a.rnd(); }
    return;
  }
  if (a.timer > 0) return;
  const next = nextState(a);
  a.state = next;
  a.timer = next === "rest" ? 8 + 20 * a.rnd() : next === "graze" ? 5 + 10 * a.rnd() : 10 + 20 * a.rnd();
  if (next === "wander" || next === "drink") {
    // a habitat-valid target within the home radius, pulled toward the group centre
    const cx = groupCentre ? (a.homeX + groupCentre.x) / 2 : a.homeX, cz = groupCentre ? (a.homeZ + groupCentre.z) / 2 : a.homeZ;
    for (let k = 0; k < 6; k++) {
      const r = (groupCentre ? COHESION_M : HOME_RADIUS_M) * Math.sqrt(a.rnd()), ang = a.rnd() * Math.PI * 2;
      const tx = cx + r * Math.cos(ang), tz = cz + r * Math.sin(ang);
      if (Math.hypot(tx - a.homeX, tz - a.homeZ) <= HOME_RADIUS_M && ok(a.plan, tx, tz)) { a.targetX = tx; a.targetZ = tz; return; }
    }
    a.state = "idle";
  }
}

/** Simple separation inside a group so members don't stand inside each other. */
export function separate(agents: Agent[], minDist: (a: Agent) => number, ok: HabitatTest): void {
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i]!, b = agents[j]!;
      if (a.state === "fly" || b.state === "fly") continue;
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), m = Math.max(minDist(a), minDist(b));
      if (d >= m || d === 0) continue;
      const push = (m - d) / 2, ux = dx / d, uz = dz / d;
      if (ok(a.plan, a.x - ux * push, a.z - uz * push)) { a.x -= ux * push; a.z -= uz * push; }
      if (ok(b.plan, b.x + ux * push, b.z + uz * push)) { b.x += ux * push; b.z += uz * push; }
    }
  }
}
