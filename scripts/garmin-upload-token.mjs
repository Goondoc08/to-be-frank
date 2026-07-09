// One-time setup step, run locally (never deployed). Reads the session
// token produced by the garmin-connect-sdk CLI login and uploads it to the
// garmin-token-upload Edge Function. Your Garmin password never leaves this
// machine — only the resulting token is sent.
//
// Usage:
//   npm install
//   GARMIN_TOKEN_PATH=./.garmin-tokens npx garmin-connect-sdk@alpha profile
//   node garmin-upload-token.mjs
import { FileTokenStorage } from "garmin-connect-sdk";

const SUPABASE_URL = "https://htnxrfjdsdevfvyrhrdb.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0bnhyZmpkc2RldmZ2eXJocmRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MDkzNjAsImV4cCI6MjA5OTE4NTM2MH0.dA7qxh9Hn44nGclpI7xiyLez8q_IQMgSMUhir_FDdq4";
const TOKEN_PATH = process.env.GARMIN_TOKEN_PATH || "./.garmin-tokens";

const storage = new FileTokenStorage(TOKEN_PATH);
const tokens = await storage.load();

if (!tokens) {
  console.error(`No tokens found at ${TOKEN_PATH}. Run the login step first:`);
  console.error(`  GARMIN_TOKEN_PATH=${TOKEN_PATH} npx garmin-connect-sdk@alpha profile`);
  process.exit(1);
}

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

if (!res.ok) {
  console.error("Upload failed:", json.error || res.status);
  process.exit(1);
}

console.log("Garmin session uploaded. The app will start showing live data automatically.");
