// Template for screenshotting the email-client React UI headlessly, without a display and
// without a real Tauri backend. Copy this to a scratch directory, edit the fixture data and
// the click/screenshot steps at the bottom for whatever you're trying to show, then:
//
//   1. cd ~/repos/SentryMAil && \
//        nohup npm run dev -- --port 1420 --strictPort > /tmp/vite-dev.log 2>&1 &
//   2. wait for it to be ready: curl -s -o /dev/null -w "%{http_code}" http://localhost:1420
//   3. node <your-copy-of-this-file>.mjs   (needs `playwright` resolvable - `npm install
//      playwright` in the same scratch dir if it isn't already, then
//      `npx playwright install chromium` once to fetch the browser binary)
//   4. pkill -f "vite --port 1420"  when done
//
// Debugging a blank page: attach page.on("pageerror") BEFORE page.goto(), or you will miss
// every load-time error and see only an empty body.
//
// The core trick: @tauri-apps/api's invoke()/listen() call into window.__TAURI_INTERNALS__,
// which doesn't exist in a plain browser. page.addInitScript() injects a fake one before the
// app's JS runs, so every Tauri command call resolves with fixture data instead of erroring.
// This proves the UI renders/behaves correctly - it is NOT real model output or a real inbox.
// Always say so when sharing screenshots taken this way.

import { chromium } from "playwright";

// On NixOS, Playwright's downloaded Chromium cannot run (it exits 127 - the prebuilt binary
// is not patched for the Nix store). Point it at a system browser instead.
const CHROMIUM = "/etc/profiles/per-user/abhijay/bin/chromium";

const OUT = "."; // change to wherever you want the PNGs written

const accounts = [
  { id: 1, email_address: "example@gmail.com", provider: "gmail", last_history_id: null },
];

const emails = [
  {
    id: 1, account_id: 1,
    sender: "Example Sender <sender@example.com>",
    // These are NOT optional - EmailList calls .toLowerCase() on the address fields and
    // maps over label_ids, so omitting any of them crashes the component.
    to_addrs: "example@gmail.com", cc_addrs: "",
    subject: "Example subject",
    body_text: "Example body text.",
    body_html: null,
    gmail_thread_id: "t1", thread_count: 1, thread_unread: 0,
    label_ids: ["INBOX", "UNREAD"],
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

const browser = await chromium.launch({ executablePath: CHROMIUM });
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
        // App reads .state off these at mount - returning null crashes the whole tree.
        case "embedding_model_status": return Promise.resolve({ state: "not_loaded" });
        case "email_counts": return Promise.resolve({ total: 1, unread: 1 });
        case "list_labels": return Promise.resolve([]);
        case "sync_now": return Promise.resolve({ accounts_synced: 1, new_emails: 0, errors: [] });
        case "plugin:event|listen": return Promise.resolve(1);
        case "plugin:event|unlisten": return Promise.resolve(null);
        default: return Promise.resolve(null);
      }
    },
    transformCallback: () => Math.floor(Math.random() * 1e9),
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
  };
  // Newer @tauri-apps/api routes unlisten through its own internals object; without this,
  // every listen() cleanup throws and React unmounts the tree into a blank page.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
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
