// One-time upload target for scripts/garmin-setup.mjs. Login happens
// locally on a computer (where MFA prompts work in a real terminal) using
// garmin-connect-sdk; only the resulting session token is sent here.
// Frank's Garmin password never touches this backend.
import { createClient } from "npm:@supabase/supabase-js@2";
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

  let tokens: Record<string, unknown> | undefined;
  try {
    const body = await req.json();
    tokens = body.tokens;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!tokens || typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string") {
    return new Response(
      JSON.stringify({ error: "tokens.accessToken and tokens.refreshToken are required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error } = await supabase
      .from("garmin_tokens")
      .upsert(
        { athlete: ATHLETE, tokens, updated_at: new Date().toISOString() },
        { onConflict: "athlete" },
      );

    if (error) throw error;

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("garmin-token-upload failed:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Could not store tokens." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
