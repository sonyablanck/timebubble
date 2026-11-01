// Seeded 3D gradient noise (Perlin's improved noise) and fractal sums. Evaluated in
// global coordinates (metres on the sphere), so the field is the same whichever
// tile asks for it (terrain §4; DESIGN A9: seed = hash(slice), global).

export function hash32(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;                         // FNV-1a over the string form
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + t * (b - a);

function grad(h: number, x: number, y: number, z: number): number {
  const g = h & 15;
  const u = g < 8 ? x : y;
  const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
  return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
}

export class Noise3 {
  private readonly p = new Uint8Array(512);

  constructor(seed: number) {
    const rnd = mulberry32(seed);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255]!;
  }

  /** Gradient noise in roughly [−1, 1]. Inputs may be large (float64 is exact enough). */
  noise(x: number, y: number, z: number): number {
    const p = this.p;
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X]! + Y, AA = p[A]! + Z, AB = p[A + 1]! + Z;
    const B = p[X + 1]! + Y, BA = p[B]! + Z, BB = p[B + 1]! + Z;
    return lerp(
      lerp(lerp(grad(p[AA]!, x, y, z), grad(p[BA]!, x - 1, y, z), u),
        lerp(grad(p[AB]!, x, y - 1, z), grad(p[BB]!, x - 1, y - 1, z), u), v),
      lerp(lerp(grad(p[AA + 1]!, x, y, z - 1), grad(p[BA + 1]!, x - 1, y, z - 1), u),
        lerp(grad(p[AB + 1]!, x, y - 1, z - 1), grad(p[BB + 1]!, x - 1, y - 1, z - 1), u), v),
      w);
  }
}

export interface FractalSpec {
  lambdaMax: number;   // largest wavelength, m
  octaves: number;     // each halves the wavelength
  gain: number;        // amplitude ratio between octaves
}

/**
 * Fractal sums over the same octaves: fBm (smooth, zero-centred) and a ridged
 * multifractal (sharp crests). Both zero-mean, normalised to roughly [−1, 1].
 */
/** Measured mean of the raw ridged sum × 2 (40 000 samples; sd 0.34). */
export const RIDGED_MEAN = 1.2;

export class Fractal {
  private readonly noise: Noise3;
  private readonly offsets: number[];
  private readonly amps: number[];
  private readonly freqs: number[];

  constructor(seed: number, readonly spec: FractalSpec) {
    this.noise = new Noise3(seed);
    const rnd = mulberry32(seed ^ 0x9e3779b9);
    this.offsets = Array.from({ length: spec.octaves * 3 }, () => rnd() * 1000);
    let a = 1, sum = 0;
    this.amps = [];
    this.freqs = [];
    for (let k = 0; k < spec.octaves; k++) {
      this.amps.push(a);
      this.freqs.push(2 ** k / spec.lambdaMax);
      sum += a;
      a *= spec.gain;
    }
    this.amps = this.amps.map((x) => x / sum);
  }

  /** Both sums at once (they share octave lookups' cost structure). `ridged` is skipped when !wantRidged. */
  eval(x: number, y: number, z: number, wantRidged: boolean): { fbm: number; ridged: number } {
    let fbm = 0, ridged = 0, weight = 1;
    for (let k = 0; k < this.freqs.length; k++) {
      const f = this.freqs[k]!;
      const o = 3 * k;
      const n = this.noise.noise(x * f + this.offsets[o]!, y * f + this.offsets[o + 1]!, z * f + this.offsets[o + 2]!);
      fbm += this.amps[k]! * n;
      if (wantRidged) {
        let r = 1 - Math.abs(n);
        r *= r * weight;
        weight = Math.min(1, r * 2);
        ridged += this.amps[k]! * r;
      }
    }
    // both centred on zero: a biased detail would leave the per-cell mean correction to remove it
    // through the bump ψ, stamping the 0.1° cell pattern into the relief (terrain §5)
    return { fbm: fbm * 1.6, ridged: wantRidged ? ridged * 2 - RIDGED_MEAN : 0 };
  }

  /** Single-octave noise at a given wavelength (for domain warping). */
  low(x: number, y: number, z: number, lambda: number, channel: number): number {
    const f = 1 / lambda;
    return this.noise.noise(x * f + 17.3 * channel, y * f - 41.9 * channel, z * f + 7.7 * channel);
  }
}
