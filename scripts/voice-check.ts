// Quick checks for the pure voice helpers: `npx tsx scripts/voice-check.ts`
// (run from the project root; exits non-zero on the first failed expectation).
import assert from "node:assert/strict";
import { appendDictation, chunkForSpeech, describeEmailForSpeech, normalizeDictation, parseVoiceCommand } from "../src/voice";

// normalizeDictation: spoken marks, spacing, capitals
assert.equal(normalizeDictation("hello dana comma thanks for the invoice full stop"), "Hello dana, thanks for the invoice.");
assert.equal(normalizeDictation("i will pay on friday period new line best comma jordan"), "I will pay on friday.\nBest, jordan");
assert.equal(normalizeDictation("are you free thursday question mark"), "Are you free thursday?");
assert.equal(normalizeDictation("first point new paragraph second point"), "First point\n\nSecond point");
assert.equal(normalizeDictation("i think i can"), "I think I can");

// appendDictation: spacing between pieces
assert.equal(appendDictation("", "Hello"), "Hello");
assert.equal(appendDictation("Hello", "there."), "Hello there.");
assert.equal(appendDictation("Hello", ", again"), "Hello, again");
assert.equal(appendDictation("Hello\n", "Best"), "Hello\nBest");
assert.equal(appendDictation("Hello ", "Best"), "Hello Best");

// parseVoiceCommand: intent scoring - exact phrases, natural phrasings, filler, numbers, names
const cmd = (s: string) => JSON.stringify(parseVoiceCommand(s));
// read
for (const s of ["read this email", "Please read it aloud.", "can you read this to me", "what does it say", "what's new", "is there anything new", "read my emails", "tell me what this says", "read it out loud please"])
  assert.equal(cmd(s), '{"kind":"read","part":"body"}', s);
for (const s of ["what's this about", "summarize it", "give me the gist", "in short what does it say", "what is it about"]) assert.equal(cmd(s), '{"kind":"read","part":"summary"}', s);
for (const s of ["who is it from", "who sent this", "when did this arrive", "what's the subject"]) assert.equal(cmd(s), '{"kind":"read","part":"details"}', s);
// stop / help
for (const s of ["stop", "stop reading", "be quiet please", "okay that's enough", "shut up"]) assert.equal(cmd(s), '{"kind":"stop"}', s);
for (const s of ["help", "what can I say", "what can you do", "what commands are there"]) assert.equal(cmd(s), '{"kind":"help"}', s);
// navigation
for (const s of ["go back", "back", "take me back to the inbox", "close this", "I'm done with this, go back to the list"]) assert.ok(["back", "done"].includes(parseVoiceCommand(s)!.kind), s);
assert.equal(cmd("go back"), '{"kind":"back"}');
for (const s of ["open settings", "settings", "can you open the settings for me", "I want to change my preferences"]) assert.equal(cmd(s), '{"kind":"settings"}', s);
for (const s of ["show quarantine", "show me the dangerous emails", "go to quarantine"]) assert.equal(cmd(s), '{"kind":"folder","folder":"quarantine"}', s);
// reply / states
for (const s of ["reply", "I want to reply to this", "answer this email", "write back to her", "let's respond"]) assert.equal(cmd(s), '{"kind":"reply"}', s);
assert.equal(cmd("okay reply saying thank you I will publish it"), '{"kind":"reply","instructions":"thank you i will publish it"}');
assert.equal(cmd("reply with thanks, see you Thursday"), '{"kind":"reply","instructions":"thanks see you thursday"}');
assert.equal(cmd("tell her I'm free on friday"), '{"kind":"reply","instructions":"i\'m free on friday"}');
assert.equal(cmd("answer that I can't make it"), '{"kind":"reply","instructions":"i can\'t make it"}');
assert.equal(cmd("respond to this email saying we accept the offer"), '{"kind":"reply","instructions":"we accept the offer"}');
for (const s of ["mark as read", "mark this one as read", "I've read this"]) assert.equal(cmd(s), '{"kind":"mark_read","read":true}', s);
for (const s of ["mark it unread", "make this unread", "keep it unread"]) assert.equal(cmd(s), '{"kind":"mark_read","read":false}', s);
for (const s of ["mark done", "I'm finished with this one", "this is handled", "mark it as complete"]) assert.equal(cmd(s), '{"kind":"done","done":true}', s);
for (const s of ["reopen", "actually it's not done"]) assert.equal(cmd(s), '{"kind":"done","done":false}', s);
// search
assert.equal(cmd("search for invoices from dana"), '{"kind":"search","query":"invoices from dana"}');
assert.equal(cmd("find emails about the dentist"), '{"kind":"search","query":"dentist"}');
assert.equal(cmd("is there anything from the bank"), '{"kind":"search","query":"bank"}');
assert.equal(cmd("do I have any mail about my flight"), '{"kind":"search","query":"flight"}');
assert.equal(cmd("look for the electricity bill"), '{"kind":"search","query":"electricity bill"}');
assert.equal(cmd("show me messages from Priya"), '{"kind":"search","query":"priya"}');
for (const s of ["clear search", "cancel the search", "close the search results"]) assert.equal(cmd(s), '{"kind":"clear_search"}', s);
// open by position
assert.equal(cmd("open number two"), '{"kind":"open","index":1}');
assert.equal(cmd("open the third email"), '{"kind":"open","index":2}');
assert.equal(cmd("open the first one"), '{"kind":"open","index":0}');
assert.equal(cmd("open number 7"), '{"kind":"open","index":6}');
assert.equal(cmd("open the latest email"), '{"kind":"open","index":0}');
assert.equal(cmd("show me the second one"), '{"kind":"open","index":1}');
assert.equal(cmd("the fourth one please"), '{"kind":"open","index":3}');
assert.equal(cmd("open the last one"), '{"kind":"open","index":-1}');
assert.equal(cmd("read the second one"), '{"kind":"open","index":1,"thenRead":true}');
assert.equal(cmd("can you read me the latest email"), '{"kind":"open","index":0,"thenRead":true}');
// open by match
assert.equal(cmd("open dana's email"), '{"kind":"open_match","query":"dana"}');
assert.equal(cmd("open the email from dana"), '{"kind":"open_match","query":"dana"}');
assert.equal(cmd("show me the one about recruitment"), '{"kind":"open_match","query":"recruitment"}');
assert.equal(cmd("read the one from the bank"), '{"kind":"open_match","query":"bank","thenRead":true}');
assert.equal(cmd("open the github one"), '{"kind":"open_match","query":"github"}');
// next / prev / sync
for (const s of ["next email", "next", "skip this one", "move on"]) assert.equal(cmd(s), '{"kind":"next"}', s);
for (const s of ["previous", "go back one", "the one before this"]) assert.equal(cmd(s), '{"kind":"prev"}', s);
for (const s of ["check for new mail", "sync", "refresh the inbox", "is there any new mail", "get my new emails"]) assert.equal(cmd(s), '{"kind":"sync"}', s);
// not commands
assert.equal(cmd("tell me a joke"), '{"kind":"read","part":"body"}'); // "tell me" reads - acceptable lean towards helpfulness
assert.equal(cmd("the weather is nice"), "null");
assert.equal(cmd(""), "null");

// chunkForSpeech: never loses text, respects the cap for normal prose
const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ");
const chunks = chunkForSpeech(long);
assert.ok(chunks.length > 1);
assert.ok(chunks.every((c) => c.length <= 240), "chunk too long");
assert.equal(chunks.join(" ").replace(/\s+/g, " "), long);

// describeEmailForSpeech: reads who/subject/warning/body, names links instead of spelling them
const sampleEmail = {
    id: 1, account_id: 1, gmail_thread_id: "t", thread_count: 1, thread_unread: 0, label_ids: [],
    sender: "Dana Whitfield <dana@example.com>", to_addrs: "", cc_addrs: "", body_html: null,
    subject: "Invoice 4471", body_text: "Hi Jordan,\n\nPlease pay here: https://example.com/pay\n\nThanks,\nDana\n-- \nDana W | Supply",
    received_at: "2026-08-22T10:00:00Z", is_read: true,
  };
const sampleTriage = {
    email_id: 1, triage_status: "ok", type: "action_needed", priority: "high", risk: "caution", user_risk: null,
    summary: "Dana asks you to pay invoice 4471 using new bank details.", risk_explanation: "Changed bank details are a common scam sign.",
    signals_json: "[]", draft_reply: null, next_step_warning: null, done: false, model_version: "x", created_at: "x",
  } as never;
const script = describeEmailForSpeech(sampleEmail, sampleTriage);
const summaryScript = describeEmailForSpeech(sampleEmail, sampleTriage, "summary");
assert.match(summaryScript, /Be careful with this one/);
assert.match(summaryScript, /In short: Dana asks you/);
assert.match(summaryScript, /needs something from you/);
const detailsScript = describeEmailForSpeech(sampleEmail, sampleTriage, "details");
assert.match(detailsScript, /^From Dana Whitfield, dana@example.com\./);
assert.match(detailsScript, /Subject: Invoice 4471/);
assert.doesNotMatch(detailsScript, /Hi Jordan/);
// body (default): straight into the message, no preamble for a caution-level email
assert.match(script, /^Hi Jordan,/);
assert.doesNotMatch(script, /Email from|Subject:|Summary:/);
assert.match(script, /\(a link\)/);
assert.doesNotMatch(script, /https:\/\//);
assert.doesNotMatch(script, /Dana W \| Supply/, "signature should be dropped");
assert.match(script, /End of message\.$/);

console.log("voice-check: all checks passed");
