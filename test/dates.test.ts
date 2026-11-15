import { describe, expect, it } from "vitest";
import { addDays, chunkRange, DateError, parseDate, parseRange, todayIn } from "../src/dates";

describe("todayIn", () => {
  // 2026-11-15 07:46 UTC is still Nov 14 in California: the bug the spike found.
  const now = new Date("2026-11-15T07:46:00Z");
  it("uses the user's time zone, not UTC", () => {
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-11-14");
    expect(todayIn("Asia/Tokyo", now)).toBe("2026-11-15");
    expect(todayIn("UTC", now)).toBe("2026-11-15");
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(todayIn("Mars/Olympus", now)).toBe("2026-11-15");
  });
});

describe("parseDate / parseRange", () => {
  it("defaults to today and validates", () => {
    expect(parseDate(undefined, "2026-11-14")).toBe("2026-11-14");
    expect(parseDate("2026-02-28", "x")).toBe("2026-02-28");
    for (const bad of ["13/11/2026", "2026-02-30", "2026-1-1", "yesterday"]) {
      expect(() => parseDate(bad, "x")).toThrow(DateError);
    }
  });
  it("limits ranges", () => {
    expect(parseRange("2026-11-01", undefined, "x", 31)).toEqual(["2026-11-01", "2026-11-01"]);
    expect(parseRange("2026-11-01", "2026-11-30", "x", 31)).toEqual(["2026-11-01", "2026-11-30"]);
    expect(() => parseRange("2026-01-01", "2026-03-01", "x", 31)).toThrow(/max is 31/);
    expect(() => parseRange("2026-11-02", "2026-11-01", "x", 31)).toThrow(/on or after/);
  });
});

describe("chunkRange", () => {
  it("splits a range into consecutive chunks", () => {
    expect(chunkRange("2026-11-01", "2026-11-03", 28)).toEqual([["2026-11-01", "2026-11-03"]]);
    expect(chunkRange("2026-01-01", "2026-02-25", 28)).toEqual([
      ["2026-01-01", "2026-01-28"],
      ["2026-01-29", "2026-02-25"],
    ]);
    expect(chunkRange("2026-01-01", "2026-02-26", 28)).toHaveLength(3);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
