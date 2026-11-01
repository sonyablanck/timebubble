import { describe, expect, it } from "vitest";
import { DataError } from "./errors";
import { decodeInt16, fetchBytes, fetchInt16, HOST_IS_LITTLE_ENDIAN } from "./fetch";
import { int16Bytes, mockFetcher } from "./testing";

const VALUES = [0, 1, -1, 32767, -32768, 1234, -4321];

describe("binary decoding (data §2)", () => {
  it("runs on a little-endian host", () => {
    expect(HOST_IS_LITTLE_ENDIAN).toBe(true);
  });

  it("INVARIANT: gzipped and plain inputs decode to identical arrays", async () => {
    const a = await decodeInt16(int16Bytes(VALUES, true), VALUES.length, "a");
    const b = await decodeInt16(int16Bytes(VALUES, false), VALUES.length, "b");
    expect([...a]).toEqual(VALUES);
    expect([...b]).toEqual(VALUES);
  });

  it("INVARIANT: wrong length is a typed error naming the file", async () => {
    const err = await decodeInt16(int16Bytes(VALUES), VALUES.length + 1, "globe/150.i16.gz").catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.kind).toBe("format");
    expect(err.path).toBe("globe/150.i16.gz");
  });

  it("decodes from an unaligned view", async () => {
    const plain = int16Bytes(VALUES, false);
    const padded = new Uint8Array(plain.length + 1);
    padded.set(plain, 1);
    const view = padded.subarray(1);
    expect([...(await decodeInt16(view, VALUES.length, "x"))]).toEqual(VALUES);
  });

  it("reports 404 as missing without retrying", async () => {
    const f = mockFetcher(new Map());
    const err = await fetchBytes(f, "/data/nope.bin").catch((e) => e);
    expect(err.kind).toBe("missing");
    expect(f.calls).toHaveLength(1);
  });

  it("retries 5xx and network failures, then succeeds", async () => {
    const f = mockFetcher(new Map([["x.i16.gz", int16Bytes(VALUES)]]));
    f.failNext(2, 503);
    expect([...(await fetchInt16(f, "/data/x.i16.gz", VALUES.length))]).toEqual(VALUES);
    expect(f.calls).toHaveLength(3);
  });

  it("gives up after three attempts with a network error", async () => {
    const f = mockFetcher(new Map([["x", "y"]]));
    f.failNext(5, 0);
    const err = await fetchBytes(f, "/data/x").catch((e) => e);
    expect(err.kind).toBe("network");
    expect(f.calls).toHaveLength(3);
  });
});

import { gzipSync } from "node:zlib";
import { fetchJson as fetchJson2 } from "./fetch";
import { it as it2, expect as expect2 } from "vitest";
it2("fetchJson reads gzipped JSON (ecology/{age}.json.gz) and plain JSON alike", async () => {
  const body = { a: [1, 2, 3] };
  const gz = new Uint8Array(gzipSync(JSON.stringify(body)));
  expect2(await fetchJson2(async () => new Response(gz), "x.json.gz")).toEqual(body);
  expect2(await fetchJson2(async () => new Response(JSON.stringify(body)), "x.json")).toEqual(body);
});
