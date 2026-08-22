// Template for screenshotting the email-client React UI headlessly, without a display and
// without a real Tauri backend. Copy this to a scratch directory, edit the fixture data and
// the click/screenshot steps at the bottom for whatever you're trying to show, then:
//
//   1. cd /opt/Personal/EmailClient/email-client && \
//        nohup npm run dev -- --port 1420 --strictPort > /tmp/vite-dev.log 2>&1 &
//   2. wait for it to be ready: curl -s -o /dev/null -w "%{http_code}" http://localhost:1420
//   3. node <your-copy-of-this-file>.mjs   (needs `playwright` resolvable - `npm install
//      playwright` in the same scratch dir if it isn't already, then
//      `npx playwright install chromium` once to fetch the browser binary)
//   4. pkill -f "vite --port 1420"  when done
//
// The core trick: @tauri-apps/api's invoke()/listen() call into window.__TAURI_INTERNALS__,
// which doesn't exist in a plain browser. page.addInitScript() injects a fake one before the
// app's JS runs, so every Tauri command call resolves with fixture data instead of erroring.
// This proves the UI renders/behaves correctly - it is NOT real model output or a real inbox.
// Always say so when sharing screenshots taken this way.

import { chromium } from "playwright";

const OUT = "."; // change to wherever you want the PNGs written

const accounts = [
  { id: 1, email_address: "example@gmail.com", provider: "gmail", last_history_id: null },
];

const emails = [
  {
    id: 1, account_id: 1,
    sender: "Example Sender <sender@example.com>",
    subject: "Example subject",
    body_text: "Example body text.",
    received_at: "2026-08-21T08:12:00Z", is_read: false,
  },
  // add more emails as needed - one per triage state you want to demonstrate
];

// Keyed by email id. Fields must match TriageResult in src/types.ts exactly (risk/type/priority
// are lowercase snake_case strings; signals_json is a JSON-encoded string array).
const triage = {
  1: {
    email_id: 1, type: "action_needed", priority: "medium",
    summary: "One-line plain-language summary, under 20 words.",
    risk: "safe", // "safe" | "caution" | "danger"
    signals_json: "[]",
    risk_explanation: "Why this risk level was assigned.",
    draft_reply: "Example draft reply text.",
    next_step_warning: null,
    triage_status: "ok", model_version: "gemma-triage-v1",
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// page.addInitScript's callback runs inside the browser page, not this Node process, so it
// can only see what's passed as its second argument (`data`) - it cannot close over `accounts`/
// `emails`/`triage` above. Extend the switch below (not a separate function) if the screen
// you're testing calls a command not listed here (e.g. sync_now, create_gmail_draft,
// load_model, triage_all_untriaged).
await page.addInitScript((data) => {
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      switch (cmd) {
        case "list_accounts": return Promise.resolve(data.accounts);
        case "list_emails": return Promise.resolve(data.emails);
        case "model_status": return Promise.resolve({ state: "ready", context_size: 4096 });
        case "get_triage_result": return Promise.resolve(data.triage[args.emailId] ?? null);
        case "plugin:event|listen": return Promise.resolve(1);
        case "plugin:event|unlisten": return Promise.resolve(null);
        default: return Promise.resolve(null);
      }
    },
    transformCallback: () => Math.floor(Math.random() * 1e9),
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
  };
}, { accounts, emails, triage });

await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

await page.screenshot({ path: `${OUT}/01-overview.png` });

// Example: click an email by its visible subject text, then screenshot the detail pane.
// await page.click("text=Example subject");
// await page.waitForTimeout(200);
// await page.screenshot({ path: `${OUT}/02-detail.png` });

await browser.close();
console.log("done");
