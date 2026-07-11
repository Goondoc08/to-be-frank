# To Be Frank — Setup Checklist

Status as of 2026-07-09: app is feature-complete for manual use (runs, strength, mobility, warm-up all work with local logging). Garmin sync and AI-generated plans are optional Phase 2 additions — **don't block handing the app to Frank on these**.

---

## 1. Ship to Frank now (no setup required)

- [ ] Confirm Frank can load `https://goondoc08.github.io/to-be-frank/` on his iPhone
- [ ] Walk him through "Add to Home Screen" (Safari share sheet → Add to Home Screen) so it runs as a standalone PWA
- [ ] Show him manual logging, the strength/mobility/warm-up sessions, and where Profile settings live

This is real, working, and doesn't need any of the steps below.

---

## 2. Anthropic API key — DONE (2026-07-09)

- [x] Key created and stored as a Supabase Edge Function secret (`ANTHROPIC_API_KEY`) — never in `index.html` or anywhere that goes to GitHub, since this repo is public
- [x] Available to any Edge Function via `Deno.env.get('ANTHROPIC_API_KEY')`

**Not wired into the app yet** — no `generate-plan` Edge Function exists. Deliberately held off building it until Frank's Garmin account is actually connected (Section 4), since the real feature needs his activity/readiness data, not just profile settings. Building it now would mean a weaker "generic goals only" version now, then redoing it later.

---

## 3. Supabase project — DONE (2026-07-09)

Project `to-be-frank` is live: `https://htnxrfjdsdevfvyrhrdb.supabase.co`, linked, migrated, and both Edge Functions below are deployed and verified booting cleanly.

---

## 4. Garmin sync — one-time local login, no developer approval needed (deployed 2026-07-09)

**Original plan changed mid-build.** The initial idea (Section 4 used to say: app collects Frank's email/password, an Edge Function logs into Garmin directly) turned out to be unworkable for two reasons discovered during setup:

1. The `garmin-connect` npm package doesn't boot inside Supabase's Deno Edge Runtime (`app-root-path` and other Node-specific deps crash on cold start — confirmed via a live `503 BOOT_ERROR`).
2. More fundamentally: **Garmin changed their auth backend.** `garth`, the reference library this design was modeled on, is now archived — its README says outright that new logins no longer work. Actively-maintained forks (`python-garminconnect`, updated June 2026) had to rebuild around a new token service and now treat **MFA as a normal, expected step** of login. That means login isn't reliably a single request/response anymore, and reimplementing it blind inside an Edge Function (with no way to test against Garmin's real servers) risked shipping something that looked deployed but silently failed.

**Revised, deployed design:** login happens once, locally, on a computer — where an MFA prompt works normally in a real terminal — using `garmin-connect-sdk` (actively maintained, TypeScript, only dependency is `zod`, no Node-runtime tricks). Only the resulting session token gets uploaded to Supabase. **Frank's Garmin password never touches the backend or the app at all** — a stronger guarantee than the original plan.

Built and deployed:
- [x] `supabase/functions/garmin-token-upload/index.ts` — accepts `{ tokens }`, stores it in `garmin_tokens` (deployed, verified with a dummy token: `200 OK`)
- [x] `supabase/functions/garmin-data/index.ts` — restores the session via `garmin-connect-sdk`, returns heart rate/Body Battery/HRV/sleep/activities for a date, auto-persists refreshed tokens (deployed, verified booting cleanly: returns `404` "no session on file", not a boot error)
- [x] `supabase/migrations/20260709010000_garmin_tokens_v2.sql` — `garmin_tokens(athlete, tokens jsonb)`, RLS on with zero policies (service_role only)
- [x] Profile tab "Garmin Connect" sheet updated — no password fields; shows live Connected/Not connected status pulled from `garmin-data`, with a "Check connection again" button

**Not connected yet — two failed attempts on 2026-07-09, both connected Nicholas's own Garmin account instead of Frank's.** His machine has `GARMIN_EMAIL`/`GARMIN_PASSWORD` set as persistent environment variables (from his separate NAM Fitness Garmin integration). The SDK's bundled CLI (`npx garmin-connect profile`) does `process.env.GARMIN_EMAIL ?? (prompt)`, so any time those env vars are present in the terminal — including a fresh window opened after waiting out a rate limit — it silently reuses his account with no prompt shown. Manually clearing the vars each time (`set GARMIN_EMAIL=` / `set GARMIN_PASSWORD=`) worked once but was missed on a retry. Both wrong tokens were deleted from Supabase and the local machine.

**Fixed and connected — confirmed by Nicholas as Frank's real account.** `scripts/garmin-connect-frank.mjs` replaced the SDK's bundled CLI entirely for this purpose. It never reads `GARMIN_EMAIL`/`GARMIN_PASSWORD` — always prompts fresh — so it can't repeat the wrong-account mistake regardless of what's in the environment. It also skips local file storage (the source of an earlier trailing-space bug from `cmd.exe`'s `set X=Y && cmd` — see git history) and uploads the resulting token to Supabase directly in the same run. The app shows "Connected" and real activity data (Houston-based marathon training block — structured W3/W4 tempo/long-run workouts) is flowing through.

**To reconnect (e.g. if the session ever expires), run this once from a computer with Node 24+:**
```
cd "To Be Frank/scripts"
npm install
node garmin-connect-frank.mjs
```
This prompts for Frank's email, password, and an MFA code if Garmin asks for one, then uploads straight to Supabase. The app picks it up automatically — no separate app-side step, no local token file to manage. `node_modules` is gitignored.

(The earlier two-step approach — a separate login via the SDK's bundled CLI, then `garmin-upload-token.mjs` to read and upload the file — has been removed from the repo. It relied on `GARMIN_EMAIL`/`GARMIN_PASSWORD` staying cleared for the whole session, which is exactly what caused both wrong-account mixups.)

**Third-order bug found and fixed 2026-07-09: the service worker was serving stale Garmin data indefinitely.** Even after the account got reconnected to Frank correctly (above), Nicholas found the app still showing *his own* activities ("Pearland Walking", "Pool Swim", "Recovery Row BB High", "Yoga" — none of which are in Frank's real Garmin history) in Recent Activity and Detected This Week. Root cause: `sw.js`'s fetch handler only special-cased URLs containing `/api/` for network-first — a string this app never actually uses. Both real fetches (`garmin-data`, `garmin-push-workout`) instead fell through to the generic "cache-first" static-asset branch, so whichever response got cached first (from whenever Nicholas's own account was still connected) was served on every load after, forever, regardless of the account fix. This isn't just a staleness bug — it means the wrong person's health data could sit cached in a browser indefinitely. Fixed by making any cross-origin request (i.e. every Supabase call) always go straight to the network, never cached; `CACHE_NAME` was also bumped (`tbf-v3` → `tbf-v4`) so existing caches — which may still hold a stale/wrong-account response — get purged on next load. **If Frank's phone was ever opened while this bug was live, confirm on his device that Recent Activity now shows his own runs, not stale data** — a cache purge only happens once the new service worker activates, which needs at least one fresh load.

**Tradeoff to know about:** still unofficial — Garmin could change their auth again without notice. `garmin-connect-sdk` is pre-1.0 (`alpha`), so its API may shift. Lower risk than the original plan though, since login itself now runs through actively-maintained, tested code rather than something hand-rolled and unverifiable.

**Push side (deployed 2026-07-09):** the Train tab's "Push to Garmin & Start" button on run sessions was previously a placeholder (just kept the screen awake). It's now wired to `supabase/functions/garmin-push-workout/index.ts`, which builds a structured Garmin workout (warmup/interval/recovery/cooldown steps, with `×3`-style blocks folded into a repeat group) from whatever's currently shown in the Run panel's session structure, creates it via `garmin-connect-sdk`'s `WorkoutsEndpoint`, and schedules it on Garmin's calendar for today — from there it syncs to the watch over Bluetooth next time Garmin Connect's app is open, same as before.

- [x] Deployed and verified booting cleanly (`404` "no session on file", not a boot error)
- [x] Verified in the browser preview: builds the correct step structure from the DOM and POSTs it
- [ ] **Not yet verified against a real connected Garmin account** — now that Garmin is connected (above), this is the next thing to test. `WorkoutsEndpoint` is marked experimental by the SDK's own maintainer ("unstable until v1 release candidate"), so treat the first real push as a test, not a guarantee. If it fails, the button falls back gracefully ("Push failed — starting anyway") and Frank can still start the session locally
- Deliberately **doesn't** set HR-zone or pace targets on the pushed steps (only durations + descriptions) — the app doesn't have Frank's actual zone/pace numbers, and fabricating them would put wrong guidance on his watch

**Progress tab — de-mocked 2026-07-09.** The Progress tab (weekly volume/pace/load sparklines, "This Month" stat pills) previously always showed hardcoded 8-week sample data with a "Sample data" banner, regardless of Garmin connection status — a UI-testing placeholder that was never wired up. Now that Garmin is connected and pulling real activity history (above), it's wired to real data:
- [x] `index.html` — `initProgress()` now aggregates real activities into weekly buckets (Mon–Sun, last 8 weeks) and calendar-month buckets, computed client-side from whatever `refreshGarminData()` fetches. Volume/pace use running-type activities only; training load uses total minutes across all activity types. Trend arrows only render when there's a real prior-period baseline to compare against (no fabricated percentages). When there's no run history yet (not connected, or connected but nothing logged), the banner and stat pills show an honest empty state instead of numbers.
- [x] `supabase/functions/garmin-data/index.ts` — widened the activities fetch from `limit: 10` (barely covered "recent activity") to a 70-day `startDate`/`endDate` window at `limit: 200`, enough to cover the 8-week charts plus this-month/last-month comparisons.
- [x] Deployed 2026-07-09 (`supabase functions deploy garmin-data`) and verified live — the endpoint now returns Frank's full history back to 2026-05-11 (22 activities) instead of just the last 10.

---

## 5. Anthropic plan-generation proxy — built (two-week model), needs deploy (2026-07-09)

The `generate-plan` Edge Function uses `ANTHROPIC_API_KEY` server-side (never in the client) to turn Frank's recent Garmin activity + profile settings into a dynamic plan.

- `supabase/functions/generate-plan/index.ts` — auth-gated (`requireUser`). Claude Messages API (`claude-opus-4-8`) over raw HTTPS with **structured outputs** (`output_config.format` + JSON schema). **Now returns TWO weeks** — `current_week` (live) and `next_week` (projected), each matching the Plan tab session shape (run → `blocks`, strength/mobility → `movements`, rest → empty). next_week progresses from current per the Build/Maintain setting. Effort `medium`, non-streaming, `max_tokens` 8000.
- `index.html` — a real **two-week plan-state model** (`_planWeeks {A,B}`, `_viewWeek`). "Generate Week" button (live once Garmin connects) stores both weeks into `localStorage` (`planState`). The Plan tab's **◀ ▶ week arrows now work** (toggle live ↔ "Next Week · Projected"). **Weekly rollover:** on the first open of a new week, the projected week auto-becomes the live week (`loadPlanStateFromStorage`). The **Today tab hero and week-strip dots now render from the live week** (wired off the hardcoded demo). Generated run blocks use `×N`/`REC`, so **Push-to-Garmin works on AI sessions**.

**Design decisions (Nicholas, 2026-07-09):** progression is **settings-driven week-to-week** (Build/Maintain, strength focus, injury lay-offs, optional race target) — no rigid periodization. Projected week is a **preview** (regenerated when it rolls over), so a bad/great week still reshapes it. Manually-moved or completed sessions will be **pinned** and protected from AI changes (editing UI is the next increment).

**Verified in preview** (synthetic two-week plan): week A renders, A/B toggle + "Projected" label + next-week dates work, Today hero shows today's live session, strip dots reflect the plan, rollover logic correct, detected-activities section survives re-render. **Not yet hit the live Anthropic API** — needs the deploy.

**Deploy:** `supabase functions deploy generate-plan` (after the §6 auth rollout). Note: `output_config` sends both `effort` + `format`; if the first live call 502s with an upstream error in logs, drop the `effort` key.

### Generation lifecycle overhaul (2026-07-09, session 2) — needs `generate-plan` redeploy + client push
Per Nicholas's direction, the weekly plan is now **seamless + auto**, on **Sonnet**:
- **Model:** `generate-plan` switched Opus → **`claude-sonnet-5`** (weekly). (Daily adjust will be Haiku — still to build.) **Redeploy `generate-plan` for the model + prompt changes.**
- **Auto-generation:** `maybeAutoGenerate()` runs on Garmin connect — generates the **first plan** automatically, and a **fresh, data-adapted plan at each weekly rollover** (stored `weekStartISO !== this Monday`). No-ops when a current-week plan already exists or Garmin isn't connected, so it never spams the API. Rollover regenerates *fresh* (matches the agreed "projected week is a preview, regenerated when it goes live"). `loadPlanStateFromStorage` simplified to just show the stored plan; the old B→A shift was removed.
- **Manual regenerate moved off the Plan tab → bottom of Profile** ("Regenerate this week"), **capped at one per week** (`data.lastManualRegenISO === thisMonday` → disabled "Regenerated this week ✓"). Auto-gens don't count against the cap. The Plan tab's dashed CTA card is gone, replaced by a slim `#plan-autostatus` line that shows "Updating your plan…" during generation.
- **Race target wired (was a dead shell):** `saveRace()` persists `{distance, date, goal}`; `initRace()` prefills + `updateRaceCards()` shows it on the two race cards + the Profile row. `generatePlan` passes `raceWeeksAway` (from `weeksUntil`) and the prompt now **periodizes** (base/build → quality → taper) toward the race, growing the long run to race distance. Setting a race triggers a silent regenerate.
- **Pace targets derived from his data:** the prompt now attaches concrete pace ranges to run sessions, computed from his own `avgPaceSecPerKm` + `recentRuns` (easy anchored to his easier runs; threshold ~45–75 s/km faster), presented in his mi/km units — and stays qualitative if there isn't enough data.
- `generateWeek` → `generatePlan(opts)` (unified auto + manual path, pin-preservation only when rebuilding the *same* week). `sw.js` bumped v7→v8.

**Verified in preview:** race save + display + `weeksUntil`(=13 for a race 13wk out), the 1/week regenerate cap (enabled → "Regenerated this week ✓" disabled), and `maybeAutoGenerate` correctly no-ops with a current plan / when disconnected and would fire on a stale week. **The live Sonnet call (periodization + paces) is untested — needs the redeploy.**

**Deploy:** `supabase functions deploy generate-plan`, then commit + push `index.html` + `sw.js`. Order isn't lockout-critical (old function still returns a valid two-week plan), but redeploy first to get Sonnet + periodization + paces.

### Planned calendar events (2026-07-09, session 2) — needs `generate-plan` redeploy + client push
Per Nicholas: Frank should be able to pre-log known future commitments (a climbing trip, a casual 5K not part of formal training) so the plan accounts for them *ahead of time* instead of him fixing it after the fact.

- **New Plan-tab section "Upcoming"** (above the day list) — pills for each future event, "+ Add" opens a sheet. Types: 🧗 Climbing/Bouldering Trip, 🏅 Casual Race, ✈️ Travel, 📌 Other. **Multi-day supported** (start + optional end date) — a weekend trip is one entry, not one per day.
- Stored in `data.plannedEvents` (`index.html`); `pruneOldEvents()` drops entries >60 days past their end so storage doesn't grow forever.
- Day rows in the Plan tab show a small emoji badge (`eventOnDate()`) when that date falls inside an event's range — a lightweight visual so Frank sees the trip is already on the plan.
- **Fed into `generate-plan`** as `upcomingEvents` (events overlapping the next 21 days, i.e. covering both generated weeks) alongside profile + activity summary. Saving/deleting an event triggers a silent regenerate (does not count against the 1/week manual cap — see above).
- **AI decides how to plan around them** (per Nicholas — no hard "always force Rest" rule in code): the prompt tells the model these are NOT prescribed sessions and to use judgment on the event's type/length — e.g. ease before/during a multi-day trip, avoid scheduling conflicting sessions on days he's unavailable, lighter touch for a one-day casual race.

**Verified in preview:** add/edit/delete round-trips through `data.plannedEvents`, pills render + sort by date, day badges appear only on dates the event actually covers (confirmed a same-week event badges correctly and a next-week trip correctly does *not* badge the current view), `upcomingEventsForPlan(21)` returns the right shape for the backend. **The live model's judgment on how to plan around an event is untested** — needs the redeploy.

**Deploy:** `supabase functions deploy generate-plan` (same redeploy as the Sonnet/periodization/pace changes above — batch these together), then commit + push `index.html` + `sw.js` (bumped v8→v9).

### Log + Upcoming merged into one Activity screen (2026-07-09, session 2) — client-only, no deploy needed
Per Nicholas: the manual "Log Activity" screen and the "Upcoming" planned-events feature were really the same concept (an activity with a type, on a date) at different points in time, and should be one form/store, not two.

- **One store, one shape.** `data.logs` now holds everything Frank enters by hand — past performance AND future plans — as `{id, category, subtype, label, startISO, endISO, durationMin, distanceKm, effort, note, source}`. `data.plannedEvents` is gone.
- **Whether an entry is "history" or "a plan" is computed live from its date, never frozen at creation.** `isEntryPastOrToday(e)` (start ≤ today) → counts toward Recent Activity/Progress/`activitySummary`. `isEntryUpcoming(e)` → counts toward the Plan tab's Upcoming pills and `upcomingEventsForPlan`. An entry spanning today (e.g. day 2 of a 3-day trip) satisfies both — shows as history-so-far *and* still-relevant-to-planning.
- **Category list** (same for past and future): 🏃 Run, 🏋️ Strength, 🧘 Mobility, 🧗 Climbing/Bouldering, 🎾 Racquet Sports, 🚴 Cycling, 🏊 Swim, ✈️ Travel, 🏅 Other. **Subtype chips** (Run: Easy/Tempo/Intervals/Long Run/Race/Recovery; Climbing: Bouldering/Route-Sport/Trad/Gym Session; Strength: Full Body/Upper/Lower/Core; Racquet: Match/Practice; Cycling: Road/Indoor/Mountain; Swim: Pool/Open Water) **only appear once the picked date is today or earlier** — a future plan doesn't have a "kind of session" yet. The free-text Label field is always available for anything a chip doesn't capture.
- **One form for both directions.** `updateLogFormMode()` toggles subtype chips + performance fields (duration/distance/effort) live as the Start Date crosses from future to today-or-earlier. Train's "Log Manually Instead" opens it defaulting to today (`openLogScreen({returnView:'train'})`); Plan's "+ Add" opens it defaulting to tomorrow with performance fields hidden (`openLogScreen({future:true, returnView:'plan'})`).
- **Post-hoc editing, no duplicates.** Tapping an existing entry (an Upcoming pill, or a manual item in Recent Activity) reopens the *same* entry via `openLogScreen({id})`. Field visibility recomputes from the entry's *current* date-vs-today relationship, not how it was created — so a future trip whose date has now passed automatically reveals subtype chips + performance fields to fill in, in place. Saving calls `updateLogEntry`, never creates a second record.
- **Discoverability without notifications.** A manual entry whose date has passed but still has no duration renders in Recent Activity with an **"Add details ›"** affordance instead of a blank stat, and the row is tappable (all manual-sourced rows are, not just pending ones) — in-app auto-logged rows stay non-tappable since they're already accurate.
- **Silent regenerate only when it matters.** Saving/deleting only triggers `generatePlan({silent:true})` when the entry is `isEntryUpcoming` (affects forward planning) — routine retrospective logging (e.g. backfilling a run from 3 days ago) does not trigger an extra Sonnet call.
- `pruneOldLogs()` replaces `pruneOldEvents()`: entries with real recorded data (duration/distance) are kept forever as genuine history; only *unfilled* stale plans get dropped, after 90 days.

**Bug found and fixed during this rebuild — worth knowing for future date-math in this file:** `.toISOString().slice(0, 10)` is UTC, not local. At 9:41 PM Central (UTC‑5) it already returns *tomorrow's* date, which silently broke `upcomingEventsForPlan`'s horizon, `pushRunToGarmin`'s scheduled date (**could have pushed a workout to the wrong day on Garmin**), `savePlanState`'s `generatedAtISO`, and `mondayISO`'s week-rollover key (only for timezones ahead of UTC, but still). Fixed by adding one shared `localISO(date)` helper (local Y-M-D components, no UTC conversion) and routing every date-only computation through it — `todayISO`, `tomorrowISO`, `mondayISO`, and all four sites above. **Any new date-only logic in this file must use `localISO()`, never `.toISOString()`.**

**Verified in preview:** past-log with subtype + mi→km conversion; future multi-day trip creation; the initial bug where a same-day *completed* run leaked into "Upcoming" (fixed by refining `isEntryUpcoming` to treat a same-day entry as historical once it has real duration/distance recorded); aging a future entry into the past and confirming it drops out of Upcoming, surfaces as "Add details ›" in Recent Activity, and — critically — editing it in place (subtype + performance fields unlock, save updates the same record, log count unchanged) rather than creating a duplicate.

### Daily adaptive layer — BUILT + DEPLOYED (2026-07-11)
- **`supabase/functions/adjust-plan/index.ts` (claude-haiku-4-5)** — deployed and verified (anon key → 401, clean boot). Structured outputs (`output_config.format` only — **Haiku does not support the `effort` key**, sending it errors). Returns `{no_change, reason, adjustments:[{idx, day}]}` with the same day schema as generate-plan.
- **Client trigger `maybeDailyAdjust()`** (in `refreshGarminData`, after `maybeAutoGenerate`): fires at most once/day (`data.lastAdjustISO`), skipped on the day a plan was generated, on stale weeks, or while generating. Applies only days `todayIdx()..6`, never pinned/completed (enforced client-side too). Shows `"Adjusted: <reason>"` in `#plan-autostatus`.
- **Design decision (Nicholas, 2026-07-11): settings changes do NOT trigger a weekly regen.** Injury/focus/approach changes are picked up by the next daily adjust pass instead — keeps API usage light. Race target save still triggers a full regen (rare, plan-defining). The prompt tells Haiku the settings "may have changed since the week was generated" for exactly this purpose.

### Comprehensive review fixes (2026-07-11, deployed + pushed, v12)
- **Train tab Run panel now renders from the live plan** (`renderRunPanel()`, called via `renderTodayHero()`): today's run, else the next run this week, else an honest empty state. `#panel-run.dataset.dateISO` carries the run's real calendar date and **`pushRunToGarmin` schedules on that date** (previously the panel was a hardcoded Tempo Intervals mockup and push always sent that, dated today).
- **Skip / unpin**: session sheets (Plan tab + Today hero) now include "Skip — make it a rest day" (day becomes pinned Rest) and "Unpin 📌" when pinned.
- **Completed days**: finishing a guided strength or mobility session marks the matching plan day `completed:true` (✓ badge); completed days survive same-week regeneration and are off-limits to adjust-plan.
- **Mobility is a guided session** (`startMobility()` → same overlay as warm-up, timed holds parsed from the catalog rx) and auto-logs on completion.
- **Week Summary pills (Today) + Personal Bests (Progress) are live** from merged activity history (were hardcoded zeros / dead "Add time" placeholders). PBs = fastest avg pace per distance band (5K/10K/Half/Marathon).
- **Dead UI removed**: sheet-swap ("Session Options" — all rows were no-ops), Weekly Run Target row, static demo Today hero, hardcoded demo `PLAN_DATA` week, demo week-strip dots. Pre-generation the app now shows an honest empty week + "Your first week builds automatically once Garmin connects."
- **Focus chips now send their full description** (`FOCUS_DETAILS` map → `profile.focusDetail`) to generate-plan and adjust-plan — the model previously only saw slugs like "cadence". No generate-plan redeploy needed (it rides in the profile JSON).
- Small: race-date `min` uses `localISO` (was `.toISOString()` — the documented UTC bug class); injury toggles re-render an open strength overview; deleted dead `toggleUnits()`/`#pref-units` code and unused `plan:{}` data field. `sw.js` v11→v12, `APP_VERSION` v12 + What's New entries.

---

## 9. Editable calendar (drag-to-move) — built, client-only, needs push (2026-07-09)

Frank can rearrange his plan by dragging sessions between days.

- Each session card in the Plan tab has a **grip handle** (`.psc-grip`, six-dot icon). Dragging the grip picks the session up (a floating clone follows the pointer), the target day highlights, and dropping **swaps** the two days. Implemented with **Pointer Events** (`initPlanDrag`) so it works with touch on iOS — the grip has `touch-action:none`; the rest of the card scrolls normally and a tap still opens the session sheet (the grip has `onclick=event.stopPropagation()`).
- A moved session is **pinned** (`day.pinned=true`, shown as 📌). `mapWeekToData` carries the flag; `moveSession(from,to)` swaps + pins + persists + re-renders (plan view, Today hero, week strip).
- **Regeneration respects pins:** `generateWeek` keeps any pinned day in the live week when it rebuilds from the API, so Frank's manual arrangement isn't clobbered. The future `adjust-plan` daily pass must do the same (skip `pinned` days).
- Works on both the live and projected week (operates on `_planWeeks[_viewWeek]`).

**Verified in preview:** grips render (one per session), a real simulated pointer drag (down→move→up) moves a session to the target day and pins it, the drop-target highlights mid-drag, Today hero updates when the moved day is today, tapping the card body still opens the sheet, and tapping the grip does not.

**⚠️ Build gotcha for next time:** a pinned-badge `title` attribute originally used `won\\'t` inside a single-quoted string in a template literal — the `\\'` terminated the string early and broke the *entire* `<script>` (every function became undefined, no console error surfaced in the preview tool). Fixed by avoiding the apostrophe. When embedding text in these inline strings, avoid apostrophes or escape with a single `\'`.

**No deploy** — purely client. Commit + push `index.html` + `sw.js` (bumped v6→v7).

---

## 8. Unified activity log — built, client-only, needs push (2026-07-09)

Everything Frank does now flows through one merged history that shows in Recent Activity / Progress **and** feeds the plan generator. Three sources:
1. **Garmin** syncs (already there).
2. **In-app completed** — finishing a guided strength session auto-logs it (`endSession(true)` → `addLog({source:'inapp', type:'strength', ...})`; the early-exit ✕ button does **not** log).
3. **Manual** — the previously-dead "Log Manually Instead" button now opens a real **Log Activity** screen (`#view-log`): type chips (run/strength/mobility/tennis/bouldering/cycling/swim/other), date, duration, optional distance (respects mi/km setting), effort, note → saves to `data.logs`.

Implementation (`index.html`, all client-side — **no Supabase deploy needed**, just commit + push; `sw.js` bumped v5→v6):
- `logToActivity()` normalizes each local log into the Garmin activity shape, so the existing renderers + aggregators just work. `getMergedActivities()` = local logs + Garmin, date-sorted. `refreshActivityViews()` re-renders Recent + Detected + Progress from the merge; called after every Garmin fetch **and** every `addLog`.
- Recent Activity tags each item's source ("Logged" / "In-app"; Garmin untagged).
- `buildActivitySummary()` now runs off the merged list (manual runs count toward volume/pace) and adds **`recentOtherLoad`** (non-running activity in the last 5 days: type + minutes) — this is what lets the plan/adjust ease off after a big bouldering or tennis day. `generateWeek` feeds it `getMergedActivities()`.

**Verified in preview:** logged a manual bouldering (→ Recent Activity "Bouldering · 90 min · Logged", `recentOtherLoad`), a manual run with distance (→ volume/pace in the summary), and a simulated in-app strength completion (→ "In-app" tagged, auto-logged). All three sources merge, sort, and feed the plan summary.

**No deploy** — purely client. Commit + push `index.html` + `sw.js` to reach Frank's phone.

---

## 7. Readiness dial — fixed, needs `garmin-data` redeploy (2026-07-09)

The Today tab's Readiness dial was a dead feature — `garmin-data` fetched Body Battery / HRV / sleep and the client threw them all away, so the dial sat at "—" even while the card said "Synced from Garmin".

- `supabase/functions/garmin-data/index.ts` — now fetches Body Battery over a **3-day range** (today's values are null until the watch syncs overnight, which is exactly when Frank checks) and computes a `readiness` summary server-side: most-recent non-null Body Battery as the score, plus HRV status and sleep hours as context. Returns `null` (honest empty state) when nothing has synced yet.
- `index.html` — `renderReadiness()` fills the dial from `data.readiness`, adds the green `.live` styling, and shows "Body Battery · Nh ago · HRV balanced". Honest empty state ("Body Battery syncs from your watch overnight") when there's no reading.

**Verified in preview** (all three states render correctly; live endpoint confirmed returning Body Battery for Frank). **Deploy:** `supabase functions deploy garmin-data`.

---

## 6. Login / privacy gate — code done, needs deploy (2026-07-09)

**Problem it fixes:** the repo is public and the anon key is embedded in `index.html`, so `garmin-data` was readable by anyone who found the repo — Frank's Body Battery, sleep, HRV, and activity history (incl. location) were effectively public. The only real fix for a static public PWA is authentication (a client can't hold a secret an attacker with the live URL can't also read).

**What was built (client + server, verified in preview):**
- `index.html` — a Supabase-auth module (`tbfAuth`, raw fetch to GoTrue, no new deps), a full-screen login overlay gating the app, `authedFetch()` that attaches Frank's access token to every Edge Function call, 401/403 handling that re-shows the login gate, and a Sign Out row in Profile. Manual features (logging/plan/settings) render underneath; the overlay covers them until first sign-in. Session persists + auto-refreshes, so it's a one-time login.
- `supabase/functions/_shared/auth.ts` — `requireUser(req)`: rejects the anon key, validates the bearer token via `supabase.auth.getUser()`, and (if `ALLOWED_USER_ID` secret is set) locks access to Frank's user id only.
- `garmin-data` + `garmin-push-workout` — now call `requireUser` first; anon key → 401.
- `sw.js` — `CACHE_NAME` bumped `tbf-v4` → `tbf-v5`.

**Deploy steps (do in this order — client is pushed LAST so nobody gets locked out before auth exists):**
1. **Create Frank's account:** Supabase Dashboard → Authentication → Users → Add user → his email + a password, tick auto-confirm. Give Frank those creds (can be any email — not tied to Garmin).
2. **Disable public signup:** Dashboard → Authentication → Sign In / Providers → Email → turn off "Allow new users to sign up". Stops anyone else creating an account.
3. **(Recommended) Lock to Frank's id:** copy his user id from the Users list, then `supabase secrets set ALLOWED_USER_ID=<uid>`. Defense in depth if signup is ever re-enabled.
4. **Redeploy the two functions:** `supabase functions deploy garmin-data` and `supabase functions deploy garmin-push-workout`.
5. **Commit + push** `index.html` + `sw.js` so GitHub Pages serves the gated client.

**Still open (write path — next increment):** `garmin-token-upload` and the local `scripts/garmin-connect-frank.mjs` still use the anon key, so an attacker could POST a token to overwrite Frank's stored session (data-integrity/DoS, not a read exposure). Options: gate it behind a `UPLOAD_SECRET` header the script supplies from env, or require a Supabase session in the script. Deferred so the one-shot Garmin login stays simple.
