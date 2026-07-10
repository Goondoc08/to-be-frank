// Purpose-built login script for Frank's Garmin account. Deliberately does
// NOT read GARMIN_EMAIL / GARMIN_PASSWORD from the environment — always
// prompts fresh — because on Nicholas's machine those env vars point at his
// own Garmin account (from a separate integration) and were silently reused
// by garmin-connect-sdk's bundled CLI twice, connecting the wrong account.
//
// Also skips local file storage entirely (no .garmin-tokens folder, no
// trailing-space path bugs) — the resulting token is uploaded straight to
// Supabase in the same run.
//
// Usage: node garmin-connect-frank.mjs
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { GarminConnectSDK, GarminMfaRequiredError } from "garmin-connect-sdk";

const SUPABASE_URL = "https://htnxrfjdsdevfvyrhrdb.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0bnhyZmpkc2RldmZ2eXJocmRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MDkzNjAsImV4cCI6MjA5OTE4NTM2MH0.dA7qxh9Hn44nGclpI7xiyLez8q_IQMgSMUhir_FDdq4";

async function uploadTokens(tokens) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/garmin-token-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ tokens }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Upload failed (${res.status})`);
}

// No load() — every run is a fresh login, never a silent restore. save()
// uploads immediately instead of writing to disk.
const uploadOnlyStorage = {
  async load() {
    return null;
  },
  async save(tokens) {
    await uploadTokens(tokens);
  },
  async clear() {},
};

const rl = createInterface({ input, output });

console.log("This always asks fresh — it will NOT reuse any Garmin account already logged into on this machine.");
console.log("Your password will be visible as you type in this terminal (normal for a script like this).\n");

const email = await rl.question("Frank's Garmin email: ");
const password = await rl.question("Frank's Garmin password: ");

const garmin = new GarminConnectSDK({ storage: uploadOnlyStorage });

try {
  try {
    await garmin.login({ email, password });
  } catch (err) {
    if (!(err instanceof GarminMfaRequiredError)) throw err;
    const mfaCode = await rl.question("Garmin MFA code (check Frank's phone/email/authenticator): ");
    await garmin.login({ email, password, mfaCode });
  }
  console.log("\nConnected and uploaded. The app will start showing Frank's real Garmin data automatically.");
} finally {
  rl.close();
}
