// Shrink Garmin API responses so they fit comfortably in an LLM context window.
//
// Garmin responses are full of nulls and minute-by-minute series (heart rate, stress,
// sleep movement, ...) that can be hundreds of entries long. Agents rarely need those, so
// by default empty values are dropped and long lists replaced with a short placeholder.
// Tools take `include_timeseries: true` to keep them.

export const DEFAULT_MAX_LIST = 50;

/** Recursively drop null/empty values and replace lists longer than `maxList`. */
export function compact(value: unknown, maxList: number | null = DEFAULT_MAX_LIST): unknown {
  if (Array.isArray(value)) {
    if (maxList !== null && value.length > maxList) {
      return `<${value.length} items omitted; pass include_timeseries=true to get them>`;
    }
    return value.map((item) => compact(item, maxList)).filter((item) => !isEmpty(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = compact(item, maxList);
      if (!isEmpty(cleaned)) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

/** Safely read a nested value: `dig(d, "a", "b", 0)` -> `d.a.b[0]`, or undefined. */
export function dig(obj: unknown, ...path: (string | number)[]): any {
  let cur: any = obj;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur ?? undefined;
}
