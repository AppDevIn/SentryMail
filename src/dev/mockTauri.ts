// Dev-only stand-in for the Tauri IPC bridge (see main.tsx). Installs window.__TAURI_INTERNALS__
// so @tauri-apps/api's invoke()/listen() resolve against fixture data in a plain browser.
// Everything below is FABRICATED fixture data for UI work - not real email, not real model output.
import type { AccountDto, EmailDto, LabelDto, SearchResultDto, TriageResult } from "../types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const now = Date.now();
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

const accounts: AccountDto[] = [
  { id: 1, email_address: "jordan@northgate.io", provider: "gmail", last_history_id: "1" },
];

const emails: EmailDto[] = [
  {
    id: 1,
    account_id: 1,
    gmail_thread_id: "t1",
    thread_count: 1,
    thread_unread: 0,
    label_ids: ["INBOX"],
    sender: "Microsoft Account Team <security-alert@ms-verify-login.co>",
    to_addrs: "jordan@northgate.io",
    cc_addrs: "",
    body_html:
      '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px"><img src="https://tracker.example/p.gif" width="1" height="1"><h2 style="color:#0078d4">Unusual sign-in blocked</h2><p>We blocked an unusual sign-in attempt on your Microsoft account.</p><p>To keep your account open you must <a href="https://ms-verify-login.co/secure/verify?u=jordan"><b>verify your identity within 24 hours</b></a>.</p><p style="color:#b00">If you do not verify, your account and all files will be permanently deleted.</p><script>alert("xss")</script><p><img src="cid:logo123" width="120" height="40" alt="logo"></p><p style="color:#666;font-size:12px">Microsoft Account Team</p></div>',
    subject: "Unusual sign-in blocked - verify your account within 24 hours",
    body_text:
      "We blocked an unusual sign-in attempt on your Microsoft account.\n\nTo keep your account open you must verify your identity within 24 hours: https://ms-verify-login.co/secure/verify?u=jordan\n\nIf you do not verify, your account and all files will be permanently deleted.\n\nMicrosoft Account Team",
    received_at: iso(40),
    is_read: false,
  },
  {
    id: 2,
    account_id: 1,
    gmail_thread_id: "t2",
    thread_count: 1,
    thread_unread: 0,
    label_ids: ["INBOX", "Label_1"],
    sender: "Dana Whitfield <dana.whitfield@whitfield-supply.com>",
    to_addrs: "Jordan Reyes <jordan@northgate.io>",
    cc_addrs: "accounts@northgate.io",
    body_html: null,
    subject: "Re: Invoice 4471 - updated remittance details",
    body_text:
      "Hi Jordan,\n\nQuick note before you process invoice 4471: our bank details changed this month, so please use the new account on the attached remittance sheet rather than the one on file.\n\nAppreciate you turning this around before Friday.\n\nBest,\nDana",
    received_at: iso(65),
    is_read: false,
  },
  {
    id: 3,
    account_id: 1,
    gmail_thread_id: "t3",
    thread_count: 1,
    thread_unread: 0,
    label_ids: ["INBOX"],
    sender: "Priya Raman <priya@northgate.io>",
    to_addrs: "jordan@northgate.io",
    cc_addrs: "",
    body_html:
      '<div dir="ltr"><p>Hey Jordan,</p><p>Can you grab a slot for the Q3 review? <b>Thu 14:00</b> or <b>Fri 10:00</b> both work for me. Please also send the updated threat model before Friday so I can pre-read - the template is <a href="https://wiki.northgate.io/threat-model">on the wiki</a>.</p><p>Thanks!<br>Priya</p></div>',
    subject: "Q3 security review - need your slot by Friday",
    body_text:
      "Hey Jordan,\n\nCan you grab a slot for the Q3 review? Thu 14:00 or Fri 10:00 both work for me. Please also send the updated threat model before Friday so I can pre-read.\n\nThanks!\nPriya",
    received_at: iso(60 * 26),
    is_read: true,
  },
  {
    id: 4,
    account_id: 1,
    gmail_thread_id: "t4",
    thread_count: 3,
    thread_unread: 0,
    label_ids: ["INBOX"],
    sender: "Marcus Ade <marcus@adelegal.co>",
    to_addrs: "Legal <legal@northgate.io>",
    cc_addrs: "jordan@northgate.io, Sam Ortiz <sam@northgate.io>",
    body_html:
      '<div dir="ltr"><p>Hi all,</p><p>Countersigned copy attached. Let me know if anything else is outstanding on our side; otherwise we\'re good to go.</p><p>Marcus</p><br><br><div class="gmail_signature" data-smartmail="gmail_signature"><p>--<br><b>Marcus Ade</b><br>Partner, Ade Legal<br>+44 20 7946 0000</p></div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, Aug 18, 2026 at 4:02 PM Legal &lt;legal@northgate.io&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><p>Hi Marcus,</p><p>Please find the final version attached for countersignature.</p><p>Thanks,<br>Legal team</p></blockquote></div>',
    subject: "Contract countersigned - anything else needed from us?",
    body_text:
      "Hi all,\n\nCountersigned copy attached. Let me know if anything else is outstanding on our side; otherwise we're good to go.\n\nMarcus\n\nOn Tue, Aug 18, 2026 at 4:02 PM 'Legal Team' via Legal <legal@northgate.io> wrote:\n\n> Hi Marcus,\n>\n> Please find the final version attached for countersignature. The signed copy goes in\n> our shared folder\n> <\n> https://urldefense.com/v3/__https://www.northgate.io/legal/contracts__;!!AYXF0UNIvtQ$> for reference.\n>\n>\n>\n> Thanks,\n> Legal team\n>\n> On Mon, Aug 17, 2026 at 9:15 AM Marcus Ade <marcus@adelegal.co> wrote:\n>\n>> Sending over our redlines now.\n>> Marcus",
    received_at: iso(60 * 30),
    is_read: true,
  },
  {
    id: 6,
    account_id: 1,
    gmail_thread_id: "t4",
    thread_count: 3,
    thread_unread: 0,
    label_ids: ["INBOX"],
    sender: "Legal <legal@northgate.io>",
    to_addrs: "Marcus Ade <marcus@adelegal.co>",
    cc_addrs: "jordan@northgate.io",
    body_html:
      '<div dir="ltr"><p>Hi Marcus,</p><p>Please find the <b>final version</b> attached for countersignature. The signed copy goes in our <a href="https://www.northgate.io/legal/contracts">shared folder</a> for reference.</p><p>Thanks,<br>Legal team</p></div>',
    subject: "Re: Contract - final version",
    body_text:
      "Hi Marcus,\n\nPlease find the final version attached for countersignature. The signed copy goes in our shared folder\n<https://www.northgate.io/legal/contracts> for reference.\n\nThanks,\nLegal team\n\nOn Mon, Aug 17, 2026 at 9:15 AM Marcus Ade <marcus@adelegal.co> wrote:\n\n> Sending over our redlines now.\n> Marcus",
    received_at: iso(60 * 24 * 2 + 60 * 5),
    is_read: true,
  },
  {
    id: 7,
    account_id: 1,
    gmail_thread_id: "t4",
    thread_count: 3,
    thread_unread: 0,
    label_ids: ["INBOX"],
    sender: "Marcus Ade <marcus@adelegal.co>",
    to_addrs: "Legal <legal@northgate.io>",
    cc_addrs: "jordan@northgate.io",
    body_html: '<div dir="ltr">Sending over our redlines now.<br><br>Marcus</div>',
    subject: "Contract - redlines",
    body_text: "Sending over our redlines now.\n\nMarcus",
    received_at: iso(60 * 24 * 3 + 60 * 2),
    is_read: true,
  },
  {
    id: 8,
    account_id: 1,
    gmail_thread_id: "t8",
    thread_count: 1,
    thread_unread: 1,
    label_ids: ["INBOX"],
    sender: "'Wai Hou Man' via Active Coreteam <active@northgate.io>",
    to_addrs: "active@northgate.io",
    cc_addrs: "",
    body_html:
      '<div dir="ltr">Forwarding for visibility first, will compile them and update in the chat once I got home</div><div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> Jerina via SoC RT &lt;booking@comp.example.edu&gt;<br><b>Sent:</b> Friday, August 21, 2026 12:41 PM<br><b>To:</b> Wai Hou Man &lt;houman@example.edu&gt;<br><b>Subject:</b> [SOC #248627] Booking (Venue/Room): Friday Hacks Venue Booking</font><div>&nbsp;</div></div><div><p>Dear Hou Man</p><p>SR11 is not available, and SR13 is not available on one of the requested dates.</p><p>Please check the booking details to ensure that everything is in order.</p><p><b>Confirmed Booking reference "RT248627_4"</b></p><table><tr><th>Week</th><th>Date</th><th>Start</th><th>Finish</th></tr><tr><td>4</td><td>Wednesday, August 26, 2026</td><td>2:30 pm</td><td>6:30 pm</td></tr><tr><td>4</td><td>Friday, August 28, 2026</td><td>6:00 pm</td><td>9:30 pm</td></tr></table><p>Best Regards,</p><p>Jerina</p></div><div><p><b>From:</b> Wai Hou Man &lt;houman@example.edu&gt;<br><b>Sent:</b> Tuesday, 18 August 2026 3:26 pm<br><b>To:</b> booking@comp.example.edu<br><b>Subject:</b> Re: [SOC #248627] Booking (Venue/Room): Friday Hacks Venue Booking</p><p>Hey Jerina,</p><p>Thanks for assisting us with all the bookings so far. Ideally we would still like to confirm the bookings up until midterms.</p><p>Best Regards,<br>Hou Man</p></div></div>',
    subject: "Fw: [SOC #248627] Booking (Venue/Room): Friday Hacks Venue Booking",
    body_text:
      "Forwarding for visibility first, will compile them and update in the chat once I got home\n\n________________________________\nFrom: Jerina via SoC RT <booking@comp.example.edu>\nSent: Friday, August 21, 2026 12:41 PM\nTo: Wai Hou Man <houman@example.edu>\nSubject: [SOC #248627] Booking (Venue/Room): Friday Hacks Venue Booking\n\nDear Hou Man\n\nSR11 is not available, and SR13 is not available on one of the requested dates.\n\nPlease check the booking details to ensure that everything is in order.\n\nConfirmed Booking reference \"RT248627_4\"\n\nWeek Date Start Time Finish Time\n4 Wednesday, August 26, 2026 2:30 pm 6:30 pm\n4 Friday, August 28, 2026 6:00 pm 9:30 pm\n\nBest Regards,\nJerina\n\nFrom: Wai Hou Man <houman@example.edu>\nSent: Tuesday, 18 August 2026 3:26 pm\nTo: booking@comp.example.edu\nSubject: Re: [SOC #248627] Booking (Venue/Room): Friday Hacks Venue Booking\n\nHey Jerina,\n\nThanks for assisting us with all the bookings so far. Ideally we would still like to confirm the bookings up until midterms.\n\nBest Regards,\nHou Man",
    received_at: iso(30),
    is_read: false,
  },
  {
    id: 5,
    account_id: 1,
    gmail_thread_id: "t5",
    thread_count: 1,
    thread_unread: 0,
    label_ids: ["INBOX"],
    sender: "The Ciphergram <weekly@ciphergram.news>",
    to_addrs: "subscribers@ciphergram.news",
    cc_addrs: "",
    body_html: null,
    subject: "Weekly #212: on-device inference is eating the cloud",
    body_text:
      "This week: local-model benchmark results, an EU data-residency ruling, and three tools worth a look.\n\n(You're receiving this because you subscribed at ciphergram.news.)",
    received_at: iso(60 * 24 * 4),
    is_read: true,
  },
  {
    // Remote images in four different places. The only <img> is a tracking pixel; the visible
    // artwork is all CSS, so this only renders a banner if the stylesheet walker works.
    id: 9,
    account_id: 1,
    gmail_thread_id: "t9",
    thread_count: 1,
    thread_unread: 1,
    label_ids: ["INBOX"],
    sender: "Northgate Studio <hello@studio.example>",
    to_addrs: "jordan@northgate.io",
    cc_addrs: "",
    body_html:
      '<style>.hero{background:url(https://cdn.example/css-bg.png) no-repeat;height:120px;display:block}</style>' +
      '<div dir="ltr"><p>Our autumn collection is live.</p>' +
      '<span class="hero"></span>' +
      '<div style="background-image:url(https://cdn.example/band.png);height:60px"></div>' +
      '<img srcset="https://cdn.example/a.png 1x, https://cdn.example/a2.png 2x" width="200">' +
      '<table><tr><td background="https://cdn.example/tile.gif">Autumn</td></tr></table>' +
      '<img src="https://track.example/open.gif?id=9" width="1" height="1">' +
      '<p>See you soon,<br>The studio</p></div>',
    subject: "Our autumn collection is live",
    body_text: "Our autumn collection is live.\n\nSee you soon,\nThe studio",
    received_at: iso(60 * 6),
    is_read: false,
  },
  {
    // Two inline images that must both surface as chips: one referenced but too large to
    // inline, one never referenced by the HTML at all.
    id: 10,
    account_id: 1,
    gmail_thread_id: "t10",
    thread_count: 1,
    thread_unread: 0,
    label_ids: ["INBOX"],
    sender: "Dana Ruiz <dana@northgate.io>",
    to_addrs: "jordan@northgate.io",
    cc_addrs: "",
    body_html: '<div dir="ltr"><p>Photos from the site visit:</p><img src="cid:big1"><p>Dana</p></div>',
    subject: "Photos from the site visit",
    body_text: "Photos from the site visit:\n\n[image: family-photo.jpg]\n\nDana",
    received_at: iso(60 * 9),
    is_read: true,
  },
];

emails.push({
  id: 9,
  account_id: 1,
  gmail_thread_id: "t9",
  thread_count: 1,
  thread_unread: 0,
  label_ids: [],
  sender: "Facilities Desk <facilities@northgate.io>",
  to_addrs: "jordan@northgate.io",
  cc_addrs: "",
  body_html: null,
  subject: "Booking receipt - Room 3B, 13 Nov",
  body_text: "Automated receipt. Room 3B is booked for 13 Nov, 14:00-16:00. No reply needed.",
  received_at: iso(60 * 24 * 6),
  is_read: true,
});

const labels: LabelDto[] = [
  { id: 1, account_id: 1, gmail_label_id: "Label_1", name: "Finance", label_type: "user", color_bg: "#fb4c2f", color_fg: "#ffffff", description: "Invoices, payments, bank details, anything about money owed or paid.", auto_apply: true, thread_count: 1 },
  { id: 2, account_id: 1, gmail_label_id: "Label_2", name: "Clients", label_type: "user", color_bg: "#ffad47", color_fg: "#000000", description: null, auto_apply: false, thread_count: 0 },
  { id: 3, account_id: 1, gmail_label_id: "Label_3", name: "Internal", label_type: "user", color_bg: "#16a766", color_fg: "#ffffff", description: "Mail between Northgate colleagues: reviews, scheduling, internal process.", auto_apply: false, thread_count: 0 },
];

const base = { model_version: "fixture", triage_status: "ok" as const, user_risk: null as null, done: false };
const triage: Record<number, TriageResult> = {
  1: {
    ...base,
    email_id: 1,
    type: "scam_risk",
    priority: "high",
    summary: "Credential-phishing attempt impersonating Microsoft with a fake verification link.",
    risk: "danger",
    signals_json: JSON.stringify(["urgency_pressure", "credential_request", "sender_mismatch", "suspicious_links", "emotional_manipulation"]),
    risk_explanation:
      "The sender's domain is a lookalike, not microsoft.com, and the email pressures you to enter credentials within 24 hours or lose your files.",
    draft_reply: null,
    next_step_warning: "Don't click the link. If you're worried about your account, open microsoft.com yourself and check there.",
  },
  2: {
    ...base,
    email_id: 2,
    type: "action_needed",
    priority: "high",
    summary: "Vendor asks you to pay invoice 4471 to a newly changed bank account.",
    risk: "caution",
    signals_json: JSON.stringify(["money_request", "urgency_pressure"]),
    risk_explanation:
      "Changing bank details mid-thread is the classic payment-diversion pattern. It may be genuine, but confirm by phone before paying.",
    draft_reply:
      "Hi Dana,\n\nThanks for the heads-up. Before we update anything on our side, could you confirm the new account details on a quick call? I'll ring the number we have on file.\n\nBest,\nJordan",
    next_step_warning: "Call Dana on a number you already have (not one from this email) and confirm the new account before paying.",
  },
  3: {
    ...base,
    email_id: 3,
    type: "action_needed",
    priority: "high",
    summary: "Priya needs you to pick a review slot and send the threat model before Friday.",
    risk: "safe",
    signals_json: "[]",
    risk_explanation: "Known colleague on your own domain asking for a routine scheduling decision.",
    draft_reply:
      "Hi Priya,\n\nThu 14:00 works for me. I'll send the updated threat model over before Friday.\n\nThanks,\nJordan",
    next_step_warning: null,
  },
  4: {
    ...base,
    email_id: 4,
    type: "action_needed",
    priority: "medium",
    summary: "Contract is countersigned; a short acknowledgement is all that's needed.",
    risk: "safe",
    signals_json: "[]",
    risk_explanation: "Known correspondent closing out an existing thread; nothing is being requested of you.",
    draft_reply: "Hi Marcus,\n\nReceived, thank you. Nothing else needed from your side.\n\nBest,\nJordan",
    next_step_warning: null,
  },
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const threadOf = (e: EmailDto) => emails.filter((x) => x.account_id === e.account_id && x.gmail_thread_id === e.gmail_thread_id);
/** One row per thread (latest message), newest first, like the real backend. */
function latestPerThread(): EmailDto[] {
  const latest = new Map<string, EmailDto>();
  for (const e of [...emails].sort((a, b) => b.received_at.localeCompare(a.received_at))) {
    if (!latest.has(e.gmail_thread_id)) latest.set(e.gmail_thread_id, e);
  }
  return [...latest.values()];
}
function threadRisk(e: EmailDto): number {
  let level = 0;
  for (const m of threadOf(e)) {
    const t = triage[m.id];
    const r = t ? (t.user_risk ?? t.risk) : null;
    if (r === "danger") level = 2;
    else if (r === "caution") level = Math.max(level, 1);
  }
  return level;
}
/** Mirrors `folder_predicate` in commands.rs. */
function inFolder(e: EmailDto, folder: string): boolean {
  const archived = !threadOf(e).some((m) => m.label_ids.includes("INBOX"));
  switch (folder) {
    case "archive":
      return archived;
    case "flagged":
      return !archived && threadRisk(e) >= 1;
    case "quarantine":
      return !archived && threadRisk(e) === 2;
    case "all":
      return true;
    default:
      return !archived;
  }
}

window.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "list_accounts":
        return accounts;
      case "remove_account": {
        await delay(300);
        const idx = accounts.findIndex((a) => a.id === args.accountId);
        if (idx >= 0) accounts.splice(idx, 1);
        for (let i = emails.length - 1; i >= 0; i--) if (emails[i].account_id === args.accountId) emails.splice(i, 1);
        return null;
      }
      case "list_labels":
        return labels;
      case "set_label_settings": {
        const l = labels.find((x) => x.id === args.labelId);
        if (!l) throw new Error("label not found");
        l.description = ((args.description as string | null) ?? "").trim() || null;
        l.auto_apply = !!args.autoApply && !!l.description;
        return l;
      }
      case "suggest_labels": {
        await delay(900);
        const e = emails.find((x) => x.id === args.emailId);
        const out: { gmail_label_id: string; name: string }[] = [];
        if (e && /invoice|payment|bank/i.test(e.subject + e.body_text)) out.push({ gmail_label_id: "Label_1", name: "Finance" });
        if (e && /northgate\.io>?$/i.test(e.sender) && !/weekly/i.test(e.subject)) out.push({ gmail_label_id: "Label_3", name: "Internal" });
        return out;
      }
      case "apply_labels": {
        const e = emails.find((x) => x.id === args.emailId);
        if (!e) throw new Error("email not found");
        const add = (args.add as string[]) ?? [];
        const remove = (args.remove as string[]) ?? [];
        e.label_ids = [...e.label_ids.filter((l) => !remove.includes(l)), ...add.filter((l) => !e.label_ids.includes(l))];
        return { label_ids: e.label_ids, warning: null };
      }
      case "list_emails": {
        const offset = (args.offset as number | null) ?? 0;
        const limit = (args.limit as number | null) ?? 100;
        const labelId = (args.labelId as string | null) ?? null;
        const folder = (args.folder as string | null) ?? "inbox";
        return latestPerThread()
          .filter((e) => !labelId || threadOf(e).some((x) => x.label_ids.includes(labelId)))
          .filter((e) => inFolder(e, folder))
          .map((e) => ({
            ...e,
            thread_count: threadOf(e).length,
            thread_unread: threadOf(e).filter((x) => !x.is_read).length,
          }))
          .slice(offset, offset + limit);
      }
      case "folder_counts": {
        const rows = latestPerThread();
        return {
          inbox_total: rows.filter((e) => inFolder(e, "inbox")).length,
          inbox_unread: rows.filter((e) => inFolder(e, "inbox") && threadOf(e).some((x) => !x.is_read)).length,
          quarantine: rows.filter((e) => inFolder(e, "quarantine")).length,
          flagged: rows.filter((e) => inFolder(e, "flagged")).length,
          archive: rows.filter((e) => inFolder(e, "archive")).length,
        };
      }
      case "archive_thread": {
        await delay(200);
        const e = emails.find((x) => x.id === args.emailId);
        if (!e) throw new Error("email not found");
        for (const m of threadOf(e)) {
          m.label_ids = args.archived ? m.label_ids.filter((l) => l !== "INBOX") : [...new Set(["INBOX", ...m.label_ids])];
        }
        return { archived: !!args.archived, warning: null };
      }
      case "send_message": {
        await delay(600);
        if (!String(args.to ?? "").includes("@")) throw new Error("Add at least one recipient address");
        return null;
      }
      case "list_thread_messages": {
        const e = emails.find((x) => x.id === args.emailId);
        return e
          ? emails.filter((x) => x.gmail_thread_id === e.gmail_thread_id).sort((a, b) => b.received_at.localeCompare(a.received_at))
          : [];
      }
      case "email_counts": {
        const labelId = (args.labelId as string | null) ?? null;
        const folder = (args.folder as string | null) ?? "inbox";
        const rows = latestPerThread()
          .filter((e) => !labelId || threadOf(e).some((x) => x.label_ids.includes(labelId)))
          .filter((e) => inFolder(e, folder));
        return { total: rows.length, unread: rows.filter((e) => threadOf(e).some((x) => !x.is_read)).length };
      }
      case "set_read": {
        const e = emails.find((x) => x.id === args.emailId);
        if (e) e.is_read = args.isRead as boolean;
        return { synced_to_gmail: true, warning: null };
      }
      case "get_email": {
        const e = emails.find((x) => x.id === args.emailId);
        return e ? { ...e, thread_unread: e.is_read ? 0 : 1 } : null;
      }
      case "model_status":
        return { state: "ready", context_size: 4096 };
      case "embedding_model_status":
        return { state: "not_loaded" };
      case "get_triage_result":
        return triage[args.emailId as number] ?? null;
      case "set_done": {
        const t = triage[args.emailId as number];
        if (!t) throw new Error("analyze the email first, then mark it done");
        t.done = !!args.done;
        return null;
      }
      case "set_user_risk": {
        const t = triage[args.emailId as number];
        if (!t) throw new Error("analyze the email first, then set your verdict");
        t.user_risk = (args.risk as "safe" | "caution" | "danger" | null) ?? null;
        return t;
      }
      case "triage_email": {
        await delay(1100);
        const id = args.emailId as number;
        triage[id] = triage[id] ?? {
          ...base,
          email_id: id,
          type: "fyi",
          priority: "low",
          summary: "FYI newsletter. Two items relevant to you; no action needed.",
          risk: "safe",
          signals_json: "[]",
          risk_explanation: "Bulk newsletter you subscribed to, with a working unsubscribe link.",
          draft_reply: null,
          next_step_warning: null,
        };
        return triage[id];
      }
      case "list_attachments":
        if (args.emailId === 4)
          return [
            { id: 1, attachment_id: "att-1", filename: "Countersigned-Agreement.pdf", mime_type: "application/pdf", size: 182340, content_id: null, is_inline: false },
          ];
        if (args.emailId === 1)
          return [{ id: 2, attachment_id: "att-2", filename: "logo.png", mime_type: "image/png", size: 68, content_id: "logo123", is_inline: true }];
        if (args.emailId === 10)
          return [
            // Referenced by the HTML, but skipped for size - the chip is the only way to reach it.
            { id: 7, attachment_id: "att-7", filename: "family-photo.jpg", mime_type: "image/jpeg", size: 8_400_000, content_id: "big1", is_inline: true },
            // Marked inline with a cid the HTML never mentions: invisible under the old filter.
            { id: 8, attachment_id: "att-8", filename: "site-plan.png", mime_type: "image/png", size: 1709, content_id: "orphan1", is_inline: true },
          ];
        return [];
      case "open_attachment":
        await delay(400);
        console.info("[mock] open_attachment", args);
        return "/tmp/mock";
      case "inline_images":
        if (args.emailId === 1)
          return {
            images: [
              {
                content_id: "logo123",
                mime_type: "image/png",
                data_base64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
              },
            ],
            skipped: [],
          };
        if (args.emailId === 10)
          return {
            images: [],
            skipped: [
              { content_id: "big1", filename: "family-photo.jpg", size: 8_400_000, reason: "too large to show in the message" },
            ],
          };
        return { images: [], skipped: [] };
      case "unsubscribe_info":
        return args.emailId === 5
          ? { method: { kind: "browser", url: "https://ciphergram.news/unsubscribe" }, unsubscribed_at: null }
          : { method: { kind: "unavailable" }, unsubscribed_at: null };
      case "create_gmail_draft":
        await delay(args.send ? 700 : 400);
        return "draft-fixture";
      case "summarize_message": {
        if (!args.allowGenerate) return null;
        await delay(500);
        const t = String(args.text ?? "");
        return t.includes("redlines") ? "Says the redlines are being sent over." : "Asks for the final version to be countersigned and returned.";
      }
      case "draft_reply": {
        await delay(1200);
        const instr = String(args.instructions ?? "");
        if (/declin|no thanks|can't/i.test(instr)) return "Hi Marcus,\n\nThanks for sending this over. Unfortunately we can't take this further right now, but I appreciate you following up.\n\nBest,\nJordan";
        if (/short/i.test(instr)) return "Hi Marcus,\n\nReceived - nothing else needed, thanks.\n\nJordan";
        return "Hi Marcus,\n\nThanks for sending the countersigned copy over. Nothing else is needed from your side - we'll take it from here.\n\nBest,\nJordan";
      }
      case "plugin:opener|open_url":
        console.info("[mock] open_url", args);
        return null;
      case "search": {
        await delay(150);
        const q = String(args.query ?? "").trim().toLowerCase();
        if (!q) return [];
        const accountId = (args.accountId as number | null) ?? null;
        const labelId = (args.labelId as string | null) ?? null;
        const dangerOnly = !!args.dangerOnly;
        const limit = Math.min((args.limit as number | null) ?? 50, 50);
        const terms = q.split(/\s+/).filter(Boolean);
        const effectiveRisk = (id: number) => {
          const t = triage[id];
          return t ? t.user_risk ?? t.risk : null;
        };
        // Scope follows the current view (ADR 0004): account, label, Quarantine = danger only.
        const scoped = emails.filter(
          (e) =>
            (accountId === null || e.account_id === accountId) &&
            (labelId === null || e.label_ids.includes(labelId)) &&
            (!dangerOnly || effectiveRisk(e.id) === "danger"),
        );
        const threadCount = (e: EmailDto) =>
          emails.filter((x) => x.account_id === e.account_id && x.gmail_thread_id === e.gmail_thread_id).length;
        const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const termRe = new RegExp([...terms].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "gi");
        // FTS5-style snippet: ~160 chars around the first hit, matched terms wrapped in U+E000/U+E001.
        const snippetFor = (e: EmailDto) => {
          const body = e.body_text.replace(/\s+/g, " ").trim();
          const hay = body.toLowerCase();
          let first = -1;
          for (const t of terms) {
            const at = hay.indexOf(t);
            if (at !== -1 && (first === -1 || at < first)) first = at;
          }
          // Window of ~160 chars around the first hit, snapped to word boundaries.
          let start = first === -1 ? 0 : Math.max(0, first - 60);
          if (start > 0) start = body.lastIndexOf(" ", start) + 1;
          let end = Math.min(body.length, start + 160);
          if (end < body.length) end = body.lastIndexOf(" ", end);
          const frag = (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
          return frag.replace(termRe, (m) => `\uE000${m}\uE001`);
        };
        const keywordHits = scoped.filter((e) => {
          const hay = `${e.subject} ${e.body_text} ${e.sender}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
        const hits: SearchResultDto[] = keywordHits.map((e, i) => ({
          email_id: e.id,
          account_id: e.account_id,
          gmail_thread_id: e.gmail_thread_id,
          thread_count: threadCount(e),
          sender: e.sender,
          subject: e.subject,
          snippet: snippetFor(e),
          received_at: e.received_at,
          score: 1 / (60 + i + 1),
          matched: ["keyword"],
        }));
        // Demo only: a longer query that found something also surfaces one "related by meaning" hit
        // so the RELATED tag is visible (a real nonsense query yields nothing - ADR 0006 similarity floor).
        if (q.length >= 4 && keywordHits.length > 0) {
          const related = scoped.find((e) => !keywordHits.includes(e));
          if (related) {
            hits.push({
              email_id: related.id,
              account_id: related.account_id,
              gmail_thread_id: related.gmail_thread_id,
              thread_count: threadCount(related),
              sender: related.sender,
              subject: related.subject,
              snippet: related.body_text.replace(/\s+/g, " ").trim().slice(0, 160),
              received_at: related.received_at,
              score: 1 / (60 + hits.length + 1),
              matched: ["semantic"],
            });
          }
        }
        return hits.slice(0, limit);
      }
      case "sync_now":
        await delay(500);
        return { accounts_synced: 1, new_emails: 0, errors: [] };
      // Calendar/meetings commands: the fixture set has no meetings, but list_meetings must
      // still return an array - App maps and filters over it on every render.
      case "fetch_remote_images": {
        // Long enough that the "Getting pictures…" state is screenshottable.
        await delay(900);
        const px =
          "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAWklEQVR42u3OMQEAAAgDoC251a3gLzSg2XTVDktLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS+u3tQ5QYAGtQBmUAAAAAElFTkSuQmCC";
        return (args.urls as string[]).map((url) => {
          if (url.includes("css-bg")) return { url, mime_type: null, data_base64: null, error: "the sender's server did not send the picture" };
          if (url.includes("tile.gif")) return { url, mime_type: null, data_base64: null, error: "that picture is too large to show" };
          return { url, mime_type: "image/png", data_base64: px };
        });
      }
      case "list_meetings":
        return [];
      case "scan_meetings":
        return 0;
      case "dismiss_meeting":
        return null;
      case "plugin:event|listen":
        return 1;
      case "plugin:event|unlisten":
        return null;
      default:
        return null;
    }
  },
  transformCallback: () => Math.floor(Math.random() * 1e9),
  unregisterCallback: () => {},
  convertFileSrc: (p: string) => p,
};

// Newer @tauri-apps/api routes unlisten through its own internals object. Without this every
// listen() cleanup throws, React unmounts the tree, and the page renders blank.
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

export {};
