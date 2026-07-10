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
- [ ] **Not yet redeployed** — the Edge Function change is only in the repo so far. Deploy it with:
  ```
  cd "To Be Frank"
  npx supabase login   # if not already logged in on this machine
  npx supabase functions deploy garmin-data --project-ref htnxrfjdsdevfvyrhrdb
  ```
  Until this runs, the live function still uses `limit: 10`, so the Progress tab will only have a few days of data to chart (better than mock data, but not the full 8 weeks).

---

## 5. Anthropic plan-generation proxy — not started

Key is stored and ready (Section 2). Once Frank's Garmin account is actually connected (Section 4) and confirmed pulling real data, the next Edge Function (`supabase/functions/generate-plan`) will use `ANTHROPIC_API_KEY` server-side to turn his recent Garmin activity + profile focus chips into a dynamic weekly plan.
