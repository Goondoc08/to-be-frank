// Restores the Garmin session stored by scripts/garmin-setup.mjs and
// returns heart rate/Body Battery/HRV/sleep/activity data for the app to
// render. The app never talks to Garmin directly or sees the token.
import { createClient } from "npm:@supabase/supabase-js@2";
import { GarminConnectSDK } from "npm:garmin-connect-sdk@1.0.0-alpha.4";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const ATHLETE = "frank";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

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
    const [heartRate, bodyBattery, hrv, sleep, activities] = await Promise.all([
      sdk.health.getHeartRate(date).catch(() => null),
      sdk.health.getBodyBattery(date).catch(() => null),
      sdk.health.getHrvStatus(date).catch(() => null),
      sdk.sleep.getDailySleep(date).catch(() => null),
      sdk.activities.list({ limit: 200, startDate, endDate: date }).catch(() => []),
    ]);

    return new Response(
      JSON.stringify({ date, heartRate, bodyBattery, hrv, sleep, activities }),
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
