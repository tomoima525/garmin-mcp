// MCP tools: read-only access to the user's Garmin Connect data.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { compact, DEFAULT_MAX_LIST, dig } from "./compact";
import { chunkRange, DateError, parseDate, parseRange, todayIn } from "./dates";
import type { GarminClient, Profile } from "./garmin";

export const MAX_RANGE_DAYS = 31;
export const MAX_TREND_DAYS = 90;
const MAX_ACTIVITIES = 500;
const ACTIVITY_PAGE = 100;

export interface ToolContext {
  garmin: Pick<GarminClient, "get">;
  profile(): Promise<Profile>;
  /** Health of the Garmin login (from stored renewal history; no Garmin call). */
  connectionStatus(): Promise<unknown>;
  /** IANA zone that overrides the Garmin profile's (the TIMEZONE setting). */
  timeZoneOverride?: string;
}

const INSTRUCTIONS =
  "Read-only access to the user's Garmin Connect data: sleep, HRV, Body Battery, stress, " +
  "training readiness/status, daily stats and activities (runs, rides, ...). " +
  "Dates are YYYY-MM-DD in the user's local time zone and default to today. " +
  "Sleep for date D is the night that ended on the morning of D. " +
  "Units: distance in meters, duration in seconds, speed in m/s unless a field says " +
  "otherwise. Long minute-by-minute series are omitted unless include_timeseries=true. " +
  "If a tool reports a login problem, call get_connection_status and relay its message.";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// ----------------------------------------------------------------------------- helpers

const date = z.string().optional().describe("YYYY-MM-DD, user's local date. Default: today.");
const startDate = z.string().describe("YYYY-MM-DD, first day (inclusive).");
const endDate = z.string().optional().describe("YYYY-MM-DD, last day (inclusive). Default: start_date.");
const includeTimeseries = z
  .boolean()
  .optional()
  .describe("Include long minute-by-minute series (large responses). Default false.");

const shrink = (data: unknown, includeTimeseries?: boolean) =>
  compact(data, includeTimeseries ? null : DEFAULT_MAX_LIST);

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data ?? null) }] };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// Our errors (bad dates, GarminError, and Errors from the GarminSession Durable Object,
// which arrive over RPC as plain Errors) all carry a message meant for the caller.
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function paceMinPerKm(speedMps: unknown): string | undefined {
  if (typeof speedMps !== "number" || speedMps <= 0) return undefined;
  const secs = Math.round(1000 / speedMps);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export function summarizeActivity(a: any): unknown {
  const type: string | undefined = dig(a, "activityType", "typeKey");
  const summary: Record<string, unknown> = {
    activity_id: a?.activityId,
    name: a?.activityName,
    type,
    start_time_local: a?.startTimeLocal,
    distance_m: a?.distance,
    duration_s: a?.duration,
    moving_duration_s: a?.movingDuration,
    avg_speed_mps: a?.averageSpeed,
    avg_hr: a?.averageHR,
    max_hr: a?.maxHR,
    calories: a?.calories,
    elevation_gain_m: a?.elevationGain,
    avg_cadence_spm: a?.averageRunningCadenceInStepsPerMinute,
    aerobic_training_effect: a?.aerobicTrainingEffect,
    anaerobic_training_effect: a?.anaerobicTrainingEffect,
    training_load: a?.activityTrainingLoad,
    vo2max: a?.vO2MaxValue,
  };
  if (type && /running|walking|hiking/.test(type)) {
    summary.avg_pace_min_per_km = paceMinPerKm(a?.averageSpeed);
  }
  return compact(summary);
}

export function summarizeSleep(day: string, raw: any): unknown {
  const d = raw?.dailySleepDTO ?? {};
  return compact({
    date: day,
    sleep_score: dig(d, "sleepScores", "overall", "value"),
    sleep_score_qualifier: dig(d, "sleepScores", "overall", "qualifierKey"),
    total_sleep_s: d.sleepTimeSeconds,
    deep_s: d.deepSleepSeconds,
    light_s: d.lightSleepSeconds,
    rem_s: d.remSleepSeconds,
    awake_s: d.awakeSleepSeconds,
    sleep_start_local_ms: d.sleepStartTimestampLocal,
    sleep_end_local_ms: d.sleepEndTimestampLocal,
    avg_overnight_hrv: raw?.avgOvernightHrv,
    hrv_status: raw?.hrvStatus,
    resting_hr: raw?.restingHeartRate,
    avg_spo2: d.averageSpO2Value,
    avg_respiration: d.averageRespirationValue,
    avg_sleep_stress: d.avgSleepStress,
    body_battery_change: raw?.bodyBatteryChange,
  });
}

// Read-only API prefixes the escape-hatch tool may call. GET only, so nothing can change.
export const RAW_ALLOWED_PREFIXES = [
  "/activity-service/activity/",
  "/activitylist-service/",
  "/biometric-service/",
  "/device-service/",
  "/fitnessage-service/",
  "/fitnessstats-service/",
  "/hrv-service/",
  "/metrics-service/",
  "/personalrecord-service/",
  "/sleep-service/",
  "/usersummary-service/",
  "/userstats-service/",
  "/weight-service/",
  "/wellness-service/",
];

/** Validate an escape-hatch path: allow-listed prefix, no traversal, no query string. */
export function checkRawPath(path: string): string | null {
  if (!/^\/[A-Za-z0-9\-_./{}]+$/.test(path)) return "Path may only contain letters, digits, - _ . / { }";
  if (path.includes("..") || path.includes("//")) return "Path must not contain '..' or '//'";
  if (!RAW_ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return `Path must start with one of: ${RAW_ALLOWED_PREFIXES.join(", ")}`;
  }
  return null;
}

// ----------------------------------------------------------------------------- server

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "garmin", title: "Garmin Connect", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );

  // Lazily resolved per request: display name (for URLs) and "today" in the user's zone.
  let profilePromise: Promise<Profile> | undefined;
  const profile = () => (profilePromise ??= ctx.profile());
  const displayName = async () => encodeURIComponent((await profile()).displayName);
  const today = async () => {
    const zone = ctx.timeZoneOverride || (await profile()).timeZone || "UTC";
    return todayIn(zone);
  };
  const get = (path: string, params?: Record<string, string | number | undefined>) =>
    ctx.garmin.get(path, params);

  /** Register a tool whose handler returns data (or throws) and gets uniform error handling. */
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      { description, inputSchema, annotations: READ_ONLY },
      // The SDK validates `args` against inputSchema before calling us.
      (async (args: z.infer<z.ZodObject<Shape>>) => {
        try {
          return ok(await handler(args));
        } catch (error) {
          return fail(errorMessage(error));
        }
      }) as any,
    );
  }

  tool(
    "get_daily_summary",
    "Daily overview for one day: steps, calories, resting HR, stress, Body Battery, " +
      "intensity minutes, floors, SpO2 and respiration averages.",
    { date },
    async (a) => {
      const day = parseDate(a.date, await today());
      return shrink(await get(`/usersummary-service/usersummary/daily/${await displayName()}`, { calendarDate: day }));
    },
  );

  tool(
    "get_sleep",
    "Full sleep record for one night: sleep score and sub-scores, stage durations " +
      "(deep/light/REM/awake), overnight HRV, resting HR, SpO2, respiration and sleep " +
      "stress. `date` is the morning the sleep ended.",
    { date, include_timeseries: includeTimeseries },
    async (a) => {
      const day = parseDate(a.date, await today());
      const raw = await get(`/wellness-service/wellness/dailySleepData/${await displayName()}`, {
        date: day,
        nonSleepBufferMinutes: 60,
      });
      return { summary: summarizeSleep(day, raw), details: shrink(raw, a.include_timeseries) };
    },
  );

  tool(
    "get_sleep_trend",
    `Daily sleep statistics (score, duration, stages) for a range of up to ${MAX_TREND_DAYS} ` +
      "days. Use this to spot trends; use get_sleep for one night's detail.",
    { start_date: startDate, end_date: endDate },
    async (a) => {
      const t = await today();
      const [s, e] = parseRange(a.start_date, a.end_date ?? t, t, MAX_TREND_DAYS);
      const chunks = await Promise.all(
        chunkRange(s, e, 28).map(([cs, ce]) => get(`/sleep-service/stats/sleep/daily/${cs}/${ce}`)),
      );
      return compact(chunks.length === 1 ? chunks[0] : { chunks }, null);
    },
  );

  tool(
    "get_hrv",
    "Heart-rate variability for one night: last-night average, weekly average, baseline " +
      "range and HRV status (balanced/unbalanced/low).",
    { date, include_timeseries: includeTimeseries },
    async (a) => {
      const day = parseDate(a.date, await today());
      const data = await get(`/hrv-service/hrv/${day}`);
      return data ? shrink(data, a.include_timeseries) : { message: "No HRV data for this date (watch not worn overnight?)." };
    },
  );

  tool(
    "get_training_readiness",
    "Training readiness score and its contributing factors (sleep, recovery time, HRV, " +
      "acute load, stress history) for one day.",
    { date },
    async (a) => shrink(await get(`/metrics-service/metrics/trainingreadiness/${parseDate(a.date, await today())}`)),
  );

  tool(
    "get_body_battery",
    `Body Battery per day (charged, drained, highest, lowest) for up to ${MAX_RANGE_DAYS} days.`,
    { start_date: date, end_date: endDate, include_timeseries: includeTimeseries },
    async (a) => {
      const [s, e] = parseRange(a.start_date, a.end_date, await today(), MAX_RANGE_DAYS);
      return shrink(
        await get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: s, endDate: e }),
        a.include_timeseries,
      );
    },
  );

  tool(
    "get_stress",
    "All-day stress for one day: average and max stress level, plus time spent at rest / " +
      "low / medium / high stress.",
    { date, include_timeseries: includeTimeseries },
    async (a) =>
      shrink(await get(`/wellness-service/wellness/dailyStress/${parseDate(a.date, await today())}`), a.include_timeseries),
  );

  tool(
    "get_heart_rate",
    "Heart rate for one day: resting, min, max and 7-day average resting HR.",
    { date, include_timeseries: includeTimeseries },
    async (a) => {
      const day = parseDate(a.date, await today());
      return shrink(
        await get(`/wellness-service/wellness/dailyHeartRate/${await displayName()}`, { date: day }),
        a.include_timeseries,
      );
    },
  );

  tool(
    "list_activities",
    "Activities (runs, rides, swims, strength, ...) between two dates, newest first, with " +
      "distance, duration, pace, HR, training effect and load. `activity_type` filters by " +
      'Garmin type key, e.g. "running", "cycling", "swimming", "strength_training".',
    {
      start_date: startDate,
      end_date: z.string().optional().describe("YYYY-MM-DD, last day (inclusive). Default: today."),
      activity_type: z.string().optional().describe('Garmin type key, e.g. "running".'),
    },
    async (a) => {
      const t = await today();
      const s = parseDate(a.start_date, t);
      const e = parseDate(a.end_date, t);
      if (e < s) throw new DateError("end_date must be on or after start_date.");
      const activities: any[] = [];
      for (let start = 0; start < MAX_ACTIVITIES; start += ACTIVITY_PAGE) {
        const page = await get("/activitylist-service/activities/search/activities", {
          startDate: s,
          endDate: e,
          start,
          limit: ACTIVITY_PAGE,
          activityType: a.activity_type,
        });
        if (!Array.isArray(page) || page.length === 0) break;
        activities.push(...page);
        if (page.length < ACTIVITY_PAGE) break;
      }
      return { count: activities.length, activities: activities.map(summarizeActivity) };
    },
  );

  tool(
    "get_activity",
    "Detailed view of one activity (get the id from list_activities): full summary, " +
      "per-km/lap splits and time in each heart-rate zone.",
    {
      activity_id: z.number().int().positive().describe("Garmin activity id."),
      include_splits: z.boolean().optional().describe("Default true."),
      include_hr_zones: z.boolean().optional().describe("Default true."),
    },
    async (a) => {
      const base = `/activity-service/activity/${a.activity_id}`;
      const [activity, splits, zones] = await Promise.all([
        get(base),
        a.include_splits === false ? undefined : get(`${base}/splits`),
        a.include_hr_zones === false ? undefined : get(`${base}/hrTimeInZones`),
      ]);
      return compact({ activity: shrink(activity), splits: shrink(splits), hr_zones: shrink(zones) }, null);
    },
  );

  tool(
    "get_training_status",
    "Training status (productive, maintaining, overreaching, ...), acute/chronic training " +
      "load, load focus and VO2 max for one day.",
    { date },
    async (a) => {
      const day = parseDate(a.date, await today());
      const [status, maxMetrics] = await Promise.all([
        get(`/metrics-service/metrics/trainingstatus/aggregated/${day}`),
        get(`/metrics-service/metrics/maxmet/daily/${day}/${day}`),
      ]);
      return { training_status: shrink(status), max_metrics: shrink(maxMetrics) };
    },
  );

  tool(
    "get_race_predictions",
    "Garmin's current predicted race times for 5K, 10K, half marathon and marathon.",
    {},
    async () => shrink(await get(`/metrics-service/metrics/racepredictions/latest/${await displayName()}`)),
  );

  tool(
    "get_body_composition",
    "Weight and body composition (BMI, body fat %, muscle mass, ...) for a date range " +
      `of up to ${MAX_RANGE_DAYS} days.`,
    { start_date: date, end_date: endDate },
    async (a) => {
      const [s, e] = parseRange(a.start_date, a.end_date, await today(), MAX_RANGE_DAYS);
      return shrink(await get("/weight-service/weight/dateRange", { startDate: s, endDate: e }));
    },
  );

  tool(
    "get_connection_status",
    "Health of the Garmin login: when it was last renewed, when it expires, and whether the " +
      "user needs to log in again on their computer. Doesn't call Garmin, so it works even when " +
      "the login has failed. Use it when another tool reports a login problem, or when the user " +
      "asks whether the connection is OK.",
    {},
    async () => ctx.connectionStatus(),
  );

  tool(
    "garmin_get",
    "Escape hatch for data the other tools don't cover: GET any read-only Garmin Connect API " +
      "path under an allowed service prefix. `{displayName}` in the path is replaced with " +
      "the user's display name. Useful paths: /hrv-service/hrv/daily/{start}/{end}, " +
      "/usersummary-service/stats/steps/daily/{start}/{end}, " +
      "/wellness-service/wellness/daily/spo2/{date}, " +
      "/wellness-service/wellness/daily/respiration/{date}, " +
      "/personalrecord-service/personalrecord/prs/{displayName}, " +
      "/metrics-service/metrics/endurancescore (params: calendarDate), " +
      "/fitnessage-service/fitnessage/{date}, /activity-service/activity/{id}/weather, " +
      "/device-service/deviceregistration/devices.",
    {
      path: z.string().describe("API path, e.g. /hrv-service/hrv/daily/2026-11-01/2026-11-07"),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters, e.g. {\"calendarDate\": \"2026-11-14\"}."),
      include_timeseries: includeTimeseries,
    },
    async (a) => {
      const problem = checkRawPath(a.path);
      if (problem) throw new Error(problem);
      const path = a.path.includes("{displayName}")
        ? a.path.replaceAll("{displayName}", await displayName())
        : a.path;
      const params = Object.fromEntries(
        Object.entries(a.params ?? {}).map(([k, v]) => [k, String(v)]),
      );
      return shrink(await get(path, params), a.include_timeseries);
    },
  );

  return server;
}
