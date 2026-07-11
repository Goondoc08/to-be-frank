// Generates a dynamic 7-day training plan with Claude, shaped to exactly match
// the app's Plan tab session model so the client can drop it straight into
// PLAN_DATA. The client sends Frank's profile settings + a compact summary of
// his recent Garmin activity; the ANTHROPIC_API_KEY never leaves the server.
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";

const MODEL = "claude-sonnet-5";

// JSON schema the model must fill. Matches PLAN_DATA[i].sessions[0] in index.html:
// run days carry `blocks`, strength/mobility days carry `movements`, rest days
// set type:"rest" with empty arrays. Structured outputs guarantee this shape.
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

const weekSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    days: { type: "array", items: daySchema },
  },
  required: ["summary", "days"],
  additionalProperties: false,
};

// Two weeks per call: the live current week and a projected next week that
// progresses from it. The client shows both; next week is regenerated when it
// rolls into the live slot, so it stays a preview rather than a commitment.
const planSchema = {
  type: "object",
  properties: {
    current_week: weekSchema,
    next_week: weekSchema,
  },
  required: ["current_week", "next_week"],
  additionalProperties: false,
};

const SYSTEM = `You are the training-plan engine for "To Be Frank", a multi-sport training app for Frank — a serious recreational runner who also does tennis and bouldering and is newer to strength training. You design a balanced 7-day plan (Monday through Sunday) of runs, strength, and mobility.

Return TWO weeks: current_week (the live week starting this Monday) and next_week (a projected look-ahead). next_week should progress sensibly from current_week per the athlete's approach setting — on "build", nudge volume up ~5–10% and add a touch more quality; on "maintain", hold steady. Keep both weeks internally consistent (same available days, same long-run day). Each week has a one-line "summary" plus its "days".

Rules (apply to BOTH weeks):
- Each week has exactly 7 day objects, in order Mon, Tue, Wed, Thu, Fri, Sat, Sun.
- Only prescribe running, runner-focused strength, and mobility/recovery. NEVER prescribe tennis or bouldering — those are things Frank does on his own; account for their fatigue but don't schedule them.
- Respect the athlete's available training days: put Rest on days not in that list, and place the long run on the requested long-run day.
- Honor the focus, approach (build vs maintain), and strength-focus settings, and adapt around any injuries (lower impact, avoid loading the affected area).
- Scale volume/intensity to the recent-activity summary — don't jump mileage more than ~10% week over week; if readiness is low or recent non-run load (recentOtherLoad: bouldering/tennis/etc.) is high, or history is thin, err easier.
- UPCOMING EVENTS: the request includes upcomingEvents — things on Frank's calendar that are NOT prescribed sessions (a climbing/bouldering trip, a casual race he is not training for, travel, etc.), each with a type, label, startISO, and endISO. Use judgment based on the event's type and length, not a fixed rule: a multi-day climbing trip usually means easing volume/intensity the day before and going light or resting during/right after (he will be fatigued and off his normal schedule); a short casual race or travel day may just mean lighter training that day, or none at all if he is unavailable. Do not schedule prescribed running/strength/mobility sessions that conflict with days the event makes him unavailable — use Rest or a light day instead. These events span BOTH weeks you are generating (current + next) — apply this to whichever days they land on in either week.
- RACE PERIODIZATION: if profile.raceTarget has a date and profile.raceWeeksAway is a number, build toward it. Roughly: many weeks out → base/build (grow easy volume + the long run toward the race distance); mid-cycle → add race-specific quality (tempo/threshold/intervals); final 1–2 weeks → TAPER (cut volume ~30–50%, keep some sharpness, easy long run). If no race is set, just progress per the approach setting.

For each day set fields precisely for the app UI:
- type: "run" | "strength" | "mobility" | "rest".
- name: short card title (e.g. "Easy Run", "Tempo Intervals", "Runner Strength A"). sub: one short line under it. dur: compact like "45m". meta: like "45 min · ~9 km" (runs) or "50 min · Beginner" (strength/mobility). title: the session sheet heading. desc: 1–2 sentence description of the session's purpose.
- RUN days: fill "blocks" (ordered warmup → work → cooldown), leave "movements" empty. Each block: icon, name, sub, dur (e.g. "10 min"). Use emoji icons (🏃) for warmup/steady/cooldown blocks. For repeated intervals, set the interval block's icon to "×N" (e.g. "×3") and immediately follow it with a recovery block whose icon is exactly "REC" — the app folds that pair into a repeat.
- STRENGTH & MOBILITY days: fill "movements" (thumb emoji, name, detail like "3 × 12 reps · moderate load"), leave "blocks" empty.
- REST days: type "rest", name "Rest", empty blocks and movements, brief sub/desc.

PACE TARGETS: if activitySummary has avgPaceSecPerKm and recentRuns, attach concrete pace ranges to run sessions, derived from Frank's OWN data — don't invent numbers he didn't earn. The pace data is in seconds per kilometre; present paces in the athlete's units (profile.settings.units is "mi" or "km" — convert if "mi"). Anchor easy pace to his easier recent runs; make tempo/threshold roughly 45–75 sec/km faster than easy; intervals faster still. Give ranges (e.g. "easy 5:40–6:00/km"), put them in the block "sub" text, and keep the qualitative descriptor too (Zone 2 / conversational / threshold / comfortably hard). If there isn't enough pace data, stay qualitative and omit numbers rather than guessing.`;

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

  let profile: unknown;
  let activitySummary: unknown;
  let upcomingEvents: unknown;
  try {
    const body = await req.json();
    profile = body.profile;
    activitySummary = body.activitySummary;
    upcomingEvents = body.upcomingEvents || [];
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Plan generation is not configured." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userPrompt = `Athlete profile / settings:\n${JSON.stringify(profile, null, 2)}\n\n` +
    `Recent Garmin activity summary (last ~2 weeks):\n${JSON.stringify(activitySummary, null, 2)}\n\n` +
    `Upcoming calendar events (trips, casual races, travel — NOT prescribed sessions, plan around them):\n${JSON.stringify(upcomingEvents, null, 2)}\n\n` +
    `Generate the current week and the projected next week now.`;

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
        max_tokens: 8000,
        system: SYSTEM,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: planSchema },
        },
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Anthropic error:", res.status, JSON.stringify(data));
      return new Response(JSON.stringify({ error: "Plan generation failed upstream." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // With output_config.format the first text block is guaranteed valid JSON.
    const textBlock = (data.content || []).find((b: { type: string }) => b.type === "text");
    if (!textBlock || response_stop_bad(data)) {
      console.error("Unexpected model response:", data.stop_reason, JSON.stringify(data).slice(0, 500));
      return new Response(JSON.stringify({ error: "Plan generation returned no usable output." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const plan = JSON.parse(textBlock.text);
    return new Response(JSON.stringify({ plan }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("generate-plan failed:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Could not generate plan." }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// A refusal or truncation means the JSON may be missing/partial — treat as failure.
// deno-lint-ignore no-explicit-any
function response_stop_bad(data: any): boolean {
  return data.stop_reason === "refusal" || data.stop_reason === "max_tokens";
}
