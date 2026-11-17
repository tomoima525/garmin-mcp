// Drive the MCP server in-process with a fake Garmin API.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GarminError } from "../src/garmin";
import { buildServer, checkRawPath } from "../src/tools";

const SLEEP = {
  dailySleepDTO: {
    sleepTimeSeconds: 27000,
    deepSleepSeconds: 5400,
    remSleepSeconds: 6000,
    sleepScores: { overall: { value: 82, qualifierKey: "GOOD" } },
    unusedNull: null,
  },
  sleepMovement: Array.from({ length: 500 }, () => ({ activityLevel: 0.1 })),
  avgOvernightHrv: 61,
  restingHeartRate: 48,
};

const RUN = {
  activityId: 123,
  activityName: "Morning Run",
  activityType: { typeKey: "running" },
  distance: 10000,
  duration: 3000,
  averageSpeed: 3.3333,
  averageHR: 150,
};

type Get = (path: string, params?: Record<string, unknown>) => Promise<any>;

async function connect(get: Get, opts: { timeZone?: string; override?: string } = {}) {
  const server = buildServer({
    garmin: { get: vi.fn(get) as any },
    profile: async () => ({ displayName: "runner 1", timeZone: opts.timeZone ?? "America/Los_Angeles" }),
    connectionStatus: async () => ({ status: "ok", message: "healthy" }),
    timeZoneOverride: opts.override,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content[0].text as string;
  return { isError: Boolean(res.isError), text, data: res.isError ? undefined : JSON.parse(text) };
}

afterEach(() => vi.useRealTimers());

describe("tools", () => {
  it("lists every tool as read-only", async () => {
    const client = await connect(async () => null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "get_daily_summary", "get_sleep", "get_sleep_trend", "get_hrv", "get_training_readiness",
      "get_body_battery", "get_stress", "get_heart_rate", "list_activities", "get_activity",
      "get_training_status", "get_race_predictions", "get_body_composition",
      "get_connection_status", "garmin_get",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("get_sleep: summary plus compacted details, URL with display name", async () => {
    const get = vi.fn<Get>(async () => SLEEP);
    const client = await connect(get);
    const { data } = await call(client, "get_sleep", { date: "2026-11-13" });
    expect(data.summary).toMatchObject({ date: "2026-11-13", sleep_score: 82, deep_s: 5400, avg_overnight_hrv: 61 });
    expect(data.details.sleepMovement).toMatch(/500 items omitted/);
    expect(data.details.dailySleepDTO.unusedNull).toBeUndefined();
    expect(get).toHaveBeenCalledWith("/wellness-service/wellness/dailySleepData/runner%201", {
      date: "2026-11-13",
      nonSleepBufferMinutes: 60,
    });
  });

  it('"today" is the user\'s local date, and TIMEZONE overrides the profile', async () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T07:46:00Z"), toFake: ["Date"] });
    const get = vi.fn<Get>(async () => ({}));
    await call(await connect(get), "get_hrv");
    expect(get).toHaveBeenLastCalledWith("/hrv-service/hrv/2026-11-14", undefined);
    await call(await connect(get, { override: "Asia/Tokyo" }), "get_hrv");
    expect(get).toHaveBeenLastCalledWith("/hrv-service/hrv/2026-11-15", undefined);
  });

  it("get_hrv explains a day with no data", async () => {
    const { data } = await call(await connect(async () => null), "get_hrv", { date: "2026-11-01" });
    expect(data.message).toMatch(/No HRV data/);
  });

  it("rejects bad dates and over-long ranges", async () => {
    const client = await connect(async () => ({}));
    expect((await call(client, "get_sleep", { date: "13/11/2026" })).text).toMatch(/YYYY-MM-DD/);
    const long = await call(client, "get_body_battery", { start_date: "2026-01-01", end_date: "2026-03-01" });
    expect(long.isError && long.text).toMatch(/max is 31/);
  });

  it("get_sleep_trend fetches the compact daily stats in 28-day chunks", async () => {
    const get = vi.fn<Get>(async (path) => ({ path }));
    const { data } = await call(await connect(get), "get_sleep_trend", {
      start_date: "2026-09-01",
      end_date: "2026-10-30",
    });
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      "/sleep-service/stats/sleep/daily/2026-09-01/2026-09-28",
      "/sleep-service/stats/sleep/daily/2026-09-29/2026-10-26",
      "/sleep-service/stats/sleep/daily/2026-10-27/2026-10-30",
    ]);
    expect(data.chunks).toHaveLength(3);
  });

  it("list_activities pages through results and adds pace", async () => {
    const pages = [Array(100).fill(RUN), Array(3).fill(RUN)];
    const get = vi.fn<Get>(async () => pages.shift() ?? []);
    const { data } = await call(await connect(get), "list_activities", {
      start_date: "2026-01-01",
      end_date: "2026-11-14",
      activity_type: "running",
    });
    expect(data.count).toBe(103);
    expect(data.activities[0]).toMatchObject({ activity_id: 123, type: "running", avg_pace_min_per_km: "5:00" });
    expect(get.mock.calls[1][1]).toMatchObject({ start: 100, limit: 100, activityType: "running" });
  });

  it("get_activity combines summary, splits and HR zones", async () => {
    const get = vi.fn<Get>(async (path) => ({ path }));
    const { data } = await call(await connect(get), "get_activity", { activity_id: 123, include_hr_zones: false });
    expect(Object.keys(data)).toEqual(["activity", "splits"]);
    expect(data.splits.path).toBe("/activity-service/activity/123/splits");
  });

  it("get_connection_status relays the session's report without calling Garmin", async () => {
    const get = vi.fn<Get>(async () => ({}));
    const { data } = await call(await connect(get), "get_connection_status");
    expect(data).toEqual({ status: "ok", message: "healthy" });
    expect(get).not.toHaveBeenCalled();
  });

  it("surfaces Garmin errors as tool errors", async () => {
    const res = await call(
      await connect(async () => {
        throw new GarminError("auth", "Garmin rejected the login (401). Run garmin-mcp-login");
      }),
      "get_stress",
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/garmin-mcp-login/);
  });

  it("garmin_get: allow-listed GET paths only, with {displayName}", async () => {
    const get = vi.fn<Get>(async () => [{ rhr: 47 }]);
    const client = await connect(get);
    const ok = await call(client, "garmin_get", {
      path: "/personalrecord-service/personalrecord/prs/{displayName}",
      params: { includeHistory: false },
    });
    expect(ok.data).toEqual([{ rhr: 47 }]);
    expect(get).toHaveBeenCalledWith("/personalrecord-service/personalrecord/prs/runner%201", {
      includeHistory: "false",
    });
    const denied = await call(client, "garmin_get", { path: "/userprofile-service/userprofile/settings" });
    expect(denied.isError && denied.text).toMatch(/must start with one of/);
  });
});

describe("checkRawPath", () => {
  it("blocks traversal, queries and unknown services", () => {
    expect(checkRawPath("/hrv-service/hrv/daily/2026-11-01/2026-11-07")).toBeNull();
    expect(checkRawPath("/hrv-service/../userprofile-service/x")).toMatch(/\.\./);
    expect(checkRawPath("/hrv-service//x")).toMatch(/\/\//);
    expect(checkRawPath("/hrv-service/hrv?x=1")).toMatch(/only contain/);
    expect(checkRawPath("https://evil.example/hrv-service/")).toMatch(/only contain/);
    expect(checkRawPath("/gear-service/x")).toMatch(/must start with/);
  });
});
