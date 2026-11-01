import { DataError } from "./errors";
import type { Fetcher } from "./types";

// data/ §2. Files are raw little-endian int16, usually gzipped. Some hosts serve
// .gz with Content-Encoding: gzip, in which case the browser has already
// decompressed it, so we check the magic bytes rather than the file extension.

const RETRIES = 2;
const BACKOFF_MS = 300;

/** Typed arrays use host byte order; the data are little-endian. */
export const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function assertLittleEndian(): void {
  if (!HOST_IS_LITTLE_ENDIAN) {
    throw new DataError("format", "(host)", "big-endian host: int16 data cannot be read directly");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch with retries on network failures and 5xx; 404 is reported as "missing" at once. */
export async function fetchBytes(fetcher: Fetcher, url: string, init?: RequestInit): Promise<Uint8Array> {
  let lastError = "";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetcher(url, init);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (res.status === 404) throw new DataError("missing", url, "not found (404)");
    if (res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) throw new DataError("network", url, `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  throw new DataError("network", url, `failed after ${RETRIES + 1} attempts: ${lastError}`);
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode an int16 asset and check its length; wrong length is a format error, never garbage. */
export async function decodeInt16(bytes: Uint8Array, expectedLength: number, path: string): Promise<Int16Array> {
  assertLittleEndian();
  let raw = bytes;
  if (isGzip(raw)) {
    try {
      raw = await gunzip(raw);
    } catch (e) {
      throw new DataError("format", path, `bad gzip data: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (raw.byteLength !== expectedLength * 2) {
    throw new DataError("format", path, `${raw.byteLength} bytes, expected ${expectedLength * 2} (${expectedLength} int16 values)`);
  }
  // copy into a fresh, aligned buffer (the decoded view may not start at offset 0)
  const out = new Int16Array(expectedLength);
  new Uint8Array(out.buffer).set(raw);
  return out;
}

export async function fetchInt16(fetcher: Fetcher, url: string, expectedLength: number): Promise<Int16Array> {
  return decodeInt16(await fetchBytes(fetcher, url), expectedLength, url);
}

export async function fetchJson<T>(fetcher: Fetcher, url: string, init?: RequestInit): Promise<T> {
  let bytes = await fetchBytes(fetcher, url, init);
  if (isGzip(bytes)) {
    // large JSON assets (ecology/{age}.json.gz) ship gzipped; servers that already
    // decompressed them (Content-Encoding: gzip) hand us plain JSON, which skips this
    try {
      bytes = await gunzip(bytes);
    } catch (e) {
      throw new DataError("format", url, `bad gzip data: ${e instanceof Error ? e.message : e}`);
    }
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (e) {
    throw new DataError("format", url, `invalid JSON: ${e instanceof Error ? e.message : e}`);
  }
}
