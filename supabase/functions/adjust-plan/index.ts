// Daily adaptive layer — a cheap, conservative once-a-day pass on Haiku.
// Where generate-plan (Sonnet, weekly) builds the week, this function only
// EASES the immediate future: it may modify today and the next two days when
// readiness is low, recent non-run load is high, or the athlete's settings
// (injury, focus, approach) changed since the week was generated. It never
// rewrites the whole week and never touches pinned or completed days — the
// client also enforces both of those rules before applying anything.
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";

const MODEL = "claude-haiku-4-5";

// Same day shape as generate-plan so an adjusted day drops straight into the
// client's plan state.
const blockSchema = {
  type: "object",
  properties: {
    icon: { type: "string" },
    name: { type: "string" },
    sub: { type: "string" },
    dur: { type: "string" },
  },
  required: ["icon", "name", "sub", "dur"],
  additionalProperties: false,
};

const movementSchema = {
  type: "object",
  properties: {
    thumb: { type: "string" },
    name: { type: "string" },
    detail: { type: "string" },
  },
  required: ["thumb", "name", "detail"],
  additionalProperties: false,
};

const daySchema = {
  type: "object",
  properties: {
    day: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
    type: { type: "string", enum: ["run", "strength", "mobility", "rest"] },
    name: { type: "string" },
    sub: { type: "string" },
    dur: { type: "string" },
    meta: { type: "string" },
    title: { type: "string" },
    desc: { type: "string" },
    blocks: { type: "array", items: blockSchema },
    movements: { type: "array", items: movementSchema },
  },
  required: ["day", "type", "name", "sub", "dur", "meta", "title", "desc", "blocks", "movements"],
  additionalProperties: false,
};

const adjustmentSchema = {
  type: "object",
  properties: {
    no_change: { type: "boolean" },
    reason: { type: "string" },
    adjustments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          idx: { type: "integer" },
          day: daySchema,
        },
        required: ["idx", "day"],
        additionalProperties: false,
      },
    },
  },
  required: ["no_change", "reason", "adjustments"],
  additionalProperties: false,
};

const SYSTEM = `You are the DAILY adjustment layer for "To Be Frank", a training app for Frank — a serious recreational runner who also does tennis and bouldering. A weekly plan already exists. Your only job is a light-touch daily check: ease or swap the next day or two when the data says he needs it. You are NOT the plan generator — most days the right answer is NO CHANGE.

The request gives you: the current week's days (each with its index 0=Mon … 6=Sun, plus "pinned" and "completed" flags), todayIdx, the athlete's current settings (these may have CHANGED since the week was generated — e.g. a new injury, a different focus or approach), his recent activity summary (readiness score, recentOtherLoad = bouldering/tennis/strength minutes in the last 5 days, recent runs), and upcoming calendar events.

Rules — strict:
- You may only replace days with idx >= todayIdx AND idx <= todayIdx + 2. Never a past day.
- NEVER touch a day whose pinned or completed flag is true.
- Adjust at most 2 days. Prefer 0 or 1. Only adjust when there is a concrete signal:
  * readiness score is low (< 40) → ease today (shorter/easier run, or swap a hard run for mobility/rest).
  * heavy recentOtherLoad (a long bouldering or tennis session yesterday) → soften today's intensity.
  * settings.injured is true or injuryParts is non-empty and the upcoming day would load that area → swap to something safe (lower impact, avoid the affected area).
  * settings focus/approach clearly conflicts with an upcoming day (e.g. approach switched to "maintain" but tomorrow is a big volume jump) → moderate it.
  * an upcoming calendar event makes a day unavailable → rest or light day.
- If none of those apply, return no_change: true with an empty adjustments array and a short reason like "No adjustment needed".
- Never make a day HARDER. This layer only eases, protects, and accommodates.
- Keep each replaced day in exactly the app's shape: run days fill "blocks" (warmup → work → cooldown; interval blocks use icon "×N" immediately followed by a recovery block with icon exactly "REC"), strength/mobility days fill "movements", rest days have type "rest", name "Rest", empty blocks and movements. Set day to the correct weekday name for its index (0=Mon … 6=Sun). Only prescribe running, runner-focused strength, or mobility — never tennis or bouldering.
- "reason" is ONE short sentence Frank will see in the app, e.g. "Eased tomorrow's run — low Body Battery and a hard bouldering session yesterday." Write it about the change you made; if no change, keep it neutral.`;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Plan adjustment is not configured." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userPrompt =
    `Current week (idx 0=Mon … 6=Sun; days may carry pinned/completed flags):\n${JSON.stringify(body.week, null, 2)}\n\n` +
    `todayIdx: ${JSON.stringify(body.todayIdx)}\n\n` +
    `Athlete settings (may have changed since the week was generated):\n${JSON.stringify({ settings: body.settings, focusDetail: body.focusDetail, raceTarget: body.raceTarget, raceWeeksAway: body.raceWeeksAway }, null, 2)}\n\n` +
    `Recent activity summary:\n${JSON.stringify(body.activitySummary, null, 2)}\n\n` +
    `Upcoming calendar events (next 7 days):\n${JSON.stringify(body.upcomingEvents, null, 2)}\n\n` +
    `Decide whether any of the next 1–3 days (today included) need easing. Most days: no change.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        // Haiku 4.5 does not support output_config.effort — format only.
        output_config: {
          format: { type: "json_schema", schema: adjustmentSchema },
        },
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Anthropic error:", res.status, JSON.stringify(data));
      return new Response(JSON.stringify({ error: "Adjustment failed upstream." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const textBlock = (data.content || []).find((b: { type: string }) => b.type === "text");
    if (!textBlock || data.stop_reason === "refusal" || data.stop_reason === "max_tokens") {
      console.error("Unexpected model response:", data.stop_reason, JSON.stringify(data).slice(0, 500));
      return new Response(JSON.stringify({ error: "Adjustment returned no usable output." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = JSON.parse(textBlock.text);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("adjust-plan failed:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Could not adjust plan." }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
