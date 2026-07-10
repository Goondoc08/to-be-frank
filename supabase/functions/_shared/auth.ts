import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "./cors.ts";

function deny(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Validates that the caller is a real signed-in user, not the public anon key.
// The anon key is embedded in the app and committed to a public repo, so it
// must never be accepted as proof of identity — otherwise anyone who reads the
// repo can pull Frank's Garmin health data. Returns the authenticated user, or
// a Response the caller should return immediately.
export async function requireUser(
  req: Request,
): Promise<{ user: { id: string; email?: string } } | Response> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!token || token === anonKey) {
    return deny(401, "Sign-in required.");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return deny(401, "Sign-in required.");

  // Optional single-athlete lock: if ALLOWED_USER_ID is set as a secret, only
  // that user gets through — defense in depth in case signup is ever left open.
  const allowed = Deno.env.get("ALLOWED_USER_ID");
  if (allowed && data.user.id !== allowed) return deny(403, "Not authorized.");

  return { user: data.user };
}
