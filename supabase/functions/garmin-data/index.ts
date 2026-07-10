// Restores the Garmin session stored by scripts/garmin-setup.mjs and
// returns heart rate/Body Battery/HRV/sleep/activity data for the app to
// render. The app never talks to Garmin directly or sees the token.
import { createClient } from "npm:@supabase/supabase-js@2";
import { GarminConnectSDK } from "npm:garmin-connect-sdk@1.0.0-alpha.4";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";

const ATHLETE = "frank";

// Distils raw Garmin health payloads into a small readiness summary for the
// Today dial. Core score is the most recent non-null Body Battery reading
// (Garmin's own energy metric) across the fetched range; HRV status and sleep
// are attached as context when present. Returns null when nothing is available
// yet, so the client can show an honest empty state instead of a fake number.
// deno-lint-ignore no-explicit-any
function computeReadiness(bodyBattery: any, hrv: any, sleep: any) {
  const days = Array.isArray(bodyBattery) ? bodyBattery : (bodyBattery ? [bodyBattery] : []);
  let latestTs = 0;
  let latestVal: number | null = null;
  for (const d of days) {
    const arr = d?.bodyBatteryValuesArray || [];
    for (const pair of arr) {
      const ts = pair?.[0];
      const val = pair?.[1];
      if (typeof val === "number" && typeof ts === "number" && ts > latestTs) {
        latestTs = ts;
        latestVal = val;
      }
    }
  }
  if (latestVal === null) return null;

  const hrvStatus = (hrv?.hrvSummary?.status as string | undefined) || null;
  const sleepSec = sleep?.dailySleepDTO?.sleepTimeSeconds ?? null;
  const asOfHoursAgo = latestTs ? Math.max(0, Math.round((Date.now() - latestTs) / 3600000)) : null;

  return {
    score: Math.round(latestVal),
    asOfHoursAgo,
    hrvStatus,
    sleepHours: typeof sleepSec === "number" ? +(sleepSec / 3600).toFixed(1) : null,
  };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  // Only a signed-in user may read Frank's Garmin data (not the public anon key).
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Bridges garmin-connect-sdk's TokenStorage interface to the garmin_tokens
  // row. save() is called by the SDK whenever it rotates the access token,
  // so refreshed tokens are persisted automatically.
  const storage = {
    async load() {
      const { data, error } = await supabase
        .from("garmin_tokens")
        .select("tokens")
        .eq("athlete", ATHLETE)
        .maybeSingle();
      if (error) throw error;
      return data?.tokens ?? null;
    },
    async save(tokens: unknown) {
      const { error } = await supabase
        .from("garmin_tokens")
        .upsert(
          { athlete: ATHLETE, tokens, updated_at: new Date().toISOString() },
          { onConflict: "athlete" },
        );
      if (error) throw error;
    },
    async clear() {
      await supabase.from("garmin_tokens").delete().eq("athlete", ATHLETE);
    },
  };

  try {
    const sdk = new GarminConnectSDK({ storage });
    const restored = await sdk.restoreSession();
    if (!restored) {
      return new Response(
        JSON.stringify({ error: "No Garmin session on file. Run scripts/garmin-setup.mjs first." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 70-day window covers the Progress tab's 8-week charts plus this-month/last-month
    // comparisons, with a little slack. limit is generous since strength/mobility
    // sessions share the window with runs and shouldn't crowd them out.
    const startDate = new Date(Date.now() - 70 * 86400000);
    // Body Battery is fetched over a short range (not just `date`) so the
    // readiness dial can fall back to the most recent reading — today's values
    // are null until the watch syncs, which is usually exactly when Frank checks.
    const bbStart = new Date(new Date(date).getTime() - 3 * 86400000).toISOString().slice(0, 10);
    const [heartRate, bodyBattery, hrv, sleep, activities] = await Promise.all([
      sdk.health.getHeartRate(date).catch(() => null),
      sdk.health.getBodyBattery({ start: bbStart, end: date }).catch(() => null),
      sdk.health.getHrvStatus(date).catch(() => null),
      sdk.sleep.getDailySleep(date).catch(() => null),
      sdk.activities.list({ limit: 200, startDate, endDate: date }).catch(() => []),
    ]);

    const readiness = computeReadiness(bodyBattery, hrv, sleep);

    return new Response(
      JSON.stringify({ date, readiness, heartRate, bodyBattery, hrv, sleep, activities }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("garmin-data failed:", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: "Could not load Garmin data. Session may need to be re-created." }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
