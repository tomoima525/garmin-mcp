import { describe, expect, it } from "vitest";
import { compact, dig } from "../src/compact";

describe("compact", () => {
  it("drops nulls and empties but keeps zero and false", () => {
    expect(compact({ a: null, b: [], c: {}, d: "", e: 0, f: { g: null }, h: false })).toEqual({ e: 0, h: false });
  });
  it("replaces long lists unless asked to keep them", () => {
    const data = { series: Array.from({ length: 100 }, (_, i) => i), short: [1, 2] };
    const out = compact(data, 50) as any;
    expect(out.short).toEqual([1, 2]);
    expect(out.series).toMatch(/^<100 items omitted/);
    expect((compact(data, null) as any).series).toHaveLength(100);
  });
});

describe("dig", () => {
  it("reads nested values safely", () => {
    const d = { a: { b: [{ c: 1 }] }, n: null };
    expect(dig(d, "a", "b", 0, "c")).toBe(1);
    expect(dig(d, "a", "x")).toBeUndefined();
    expect(dig(d, "n", "anything")).toBeUndefined();
  });
});
