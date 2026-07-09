// Pushes a structured run workout (warmup/interval/recovery/cooldown steps)
// to Garmin Connect and schedules it for a date, so it syncs to the watch
// next time Garmin Connect's app is open. WorkoutsEndpoint is marked
// experimental by garmin-connect-sdk's own maintainer — treat failures here
// as expected until it's exercised against a real connected account.
import { createClient } from "npm:@supabase/supabase-js@2";
import { GarminConnectSDK } from "npm:garmin-connect-sdk@1.0.0-alpha.4";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const ATHLETE = "frank";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let workout: Record<string, unknown> | undefined;
  let date: string | undefined;
  try {
    const body = await req.json();
    workout = body.workout;
    date = body.date;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!workout || !date) {
    return new Response(JSON.stringify({ error: "workout and date are required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

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

    const created = await sdk.workouts.create(workout as never);
    const schedule = await sdk.workouts.schedule({ workoutId: created.workoutId, date });

    return new Response(
      JSON.stringify({ ok: true, workoutId: created.workoutId, schedule }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("garmin-push-workout failed:", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: "Could not push workout to Garmin." }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
