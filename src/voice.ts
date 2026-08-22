// Voice: dictation (speech -> text), read-aloud (text -> speech), and a small set of spoken
// commands. Everything here uses the speech engines built into the webview (on macOS that is
// the system speech recognizer and system voices); nothing is sent to any service of ours.
//
// The module has three parts:
//   1. Settings (speaking rate, voice) persisted in localStorage.
//   2. Read-aloud: speak()/stopSpeaking() with a subscribable "speaking" flag, and helpers that
//      turn an email or the inbox into something that sounds natural when spoken.
//   3. Dictation: a thin wrapper over the webview's SpeechRecognition plus the spoken-punctuation
//      post-processing ("new line", "full stop", ...) and the command parser.

import { useCallback, useEffect, useRef, useState } from "react";
import type { EmailDto, TriageResult } from "./types";
import { formatFullTime, parseSender, splitQuotedHistory } from "./format";
import { splitSignature, unwrapPlainText } from "./components/MessageBody";

// ---------------------------------------------------------------------------------------------
// Minimal Web Speech API typings (lib.dom has no SpeechRecognition, and WebKit prefixes it).
// ---------------------------------------------------------------------------------------------

interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface RecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionResultEvent extends Event {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
}
interface RecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  }
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/** True when this window can turn speech into text. */
export function dictationSupported(): boolean {
  return recognitionCtor() !== null;
}

/** True when this window can speak text out loud. */
export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export type SpeakingRate = "slower" | "normal" | "faster";

export interface VoiceSettings {
  /** Speaking speed for read-aloud. "slower" is the comfortable default for most listeners. */
  rate: SpeakingRate;
  /** `voiceURI` of the chosen system voice, or null for the system default. */
  voiceURI: string | null;
  /** Speech recognition language (BCP 47). */
  lang: string;
}

const SETTINGS_KEY = "sm-voice";
const SETTINGS_EVENT = "sm-voice-settings";

export const RATE_VALUES: Record<SpeakingRate, number> = { slower: 0.85, normal: 1.0, faster: 1.2 };

const DEFAULT_SETTINGS: VoiceSettings = { rate: "slower", voiceURI: null, lang: navigator.language || "en-US" };

export function getVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      rate: parsed.rate === "slower" || parsed.rate === "normal" || parsed.rate === "faster" ? parsed.rate : DEFAULT_SETTINGS.rate,
      voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : null,
      lang: typeof parsed.lang === "string" && parsed.lang ? parsed.lang : DEFAULT_SETTINGS.lang,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function setVoiceSettings(patch: Partial<VoiceSettings>) {
  const next = { ...getVoiceSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
}

/** Live view of the voice settings; re-renders when any part of the app changes them. */
export function useVoiceSettings(): VoiceSettings {
  const [settings, setSettings] = useState<VoiceSettings>(getVoiceSettings);
  useEffect(() => {
    const onChange = () => setSettings(getVoiceSettings());
    window.addEventListener(SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(SETTINGS_EVENT, onChange);
  }, []);
  return settings;
}

/** System voices for the UI's language, friendliest first. Empty until the engine has loaded them. */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return [];
  const all = window.speechSynthesis.getVoices();
  const base = (getVoiceSettings().lang || "en").split("-")[0].toLowerCase();
  const mine = all.filter((v) => v.lang.toLowerCase().startsWith(base));
  const pool = mine.length > 0 ? mine : all;
  // Default voice first, then local voices, then alphabetical. Keeps the pick list short to scan.
  return [...pool].sort((a, b) => Number(b.default) - Number(a.default) || Number(b.localService) - Number(a.localService) || a.name.localeCompare(b.name));
}

/** Resolves once the engine has a voice list (some engines populate it asynchronously). */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(listVoices);
  useEffect(() => {
    if (!speechSupported()) return;
    const refresh = () => setVoices(listVoices());
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);
  return voices;
}

// ---------------------------------------------------------------------------------------------
// Read-aloud
// ---------------------------------------------------------------------------------------------

type SpeakingListener = (speaking: boolean) => void;
const speakingListeners = new Set<SpeakingListener>();
let speakingNow = false;
let utteranceSeq = 0;

function setSpeaking(v: boolean) {
  if (speakingNow === v) return;
  speakingNow = v;
  speakingListeners.forEach((l) => l(v));
}

export function isSpeaking(): boolean {
  return speakingNow;
}

/** Splits text into utterance-sized pieces: some engines cut off long single utterances. */
export function chunkForSpeech(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const sentences = para.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];
    let buf = "";
    for (const s of sentences) {
      if ((buf + s).length > max && buf) {
        out.push(buf.trim());
        buf = "";
      }
      // A single enormous sentence still has to go somewhere; split it on commas.
      if (s.length > max) {
        for (const piece of s.split(/(?<=,)\s/)) {
          if ((buf + piece).length > max && buf) {
            out.push(buf.trim());
            buf = "";
          }
          buf += `${piece} `;
        }
      } else {
        buf += s;
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter(Boolean);
}

/** Speaks `text` with the user's voice settings, replacing anything currently being spoken. */
export function speak(text: string, opts: { onEnd?: () => void } = {}) {
  if (!speechSupported()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const id = ++utteranceSeq;
  const settings = getVoiceSettings();
  const voice = settings.voiceURI ? synth.getVoices().find((v) => v.voiceURI === settings.voiceURI) ?? null : null;
  const chunks = chunkForSpeech(text);
  if (chunks.length === 0) return;
  setSpeaking(true);
  let remaining = chunks.length;
  const finish = () => {
    if (id !== utteranceSeq) return; // superseded by a newer speak()/stop
    remaining -= 1;
    if (remaining <= 0) {
      setSpeaking(false);
      opts.onEnd?.();
    }
  };
  chunks.forEach((chunk) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.rate = RATE_VALUES[settings.rate];
    u.lang = settings.lang;
    if (voice) u.voice = voice;
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  });
}

export function stopSpeaking() {
  if (!speechSupported()) return;
  utteranceSeq += 1;
  window.speechSynthesis.cancel();
  setSpeaking(false);
}

/** Whether anything is being read aloud right now (shared across the app). */
export function useSpeaking(): boolean {
  const [speaking, set] = useState(speakingNow);
  useEffect(() => {
    speakingListeners.add(set);
    return () => {
      speakingListeners.delete(set);
    };
  }, []);
  return speaking;
}

// --- What to say -----------------------------------------------------------------------------

/** Plain text of one message as it should be read: newest part only, no signature, links named not spelled. */
export function speakableBody(bodyText: string | null | undefined, max = 6000): string {
  const newest = splitQuotedHistory(unwrapPlainText(bodyText || "")).newest;
  const { body } = splitSignature(newest);
  let text = body
    .replace(/<?\bhttps?:\/\/[^\s>]+>?/gi, " (a link) ")
    .replace(/\[image[^\]]*\]/gi, " (an image) ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > max) text = `${text.slice(0, max).replace(/\s+\S*$/, "")}. The rest of this message was not read.`;
  return text;
}

const RISK_SPOKEN: Record<string, string> = {
  danger: "Warning. This email was flagged as dangerous. Do not click its links, reply, or act on it.",
  caution: "Be careful with this one. It was flagged as suspicious.",
};

/** Which part of an open email to read: the message itself (default), the on-device summary, or who/when/subject. */
export type ReadPart = "body" | "summary" | "details";

/**
 * Read-aloud script for an open email. "body" reads the message directly (a one-line warning first
 * only if it was flagged dangerous); "summary" reads the on-device summary and risk note; "details"
 * reads sender, time, subject and who it was sent to.
 */
export function describeEmailForSpeech(email: EmailDto, triage: TriageResult | null, part: ReadPart = "body"): string {
  const sender = parseSender(email.sender);
  const ok = !!triage && triage.triage_status === "ok";
  const risk = ok ? triage!.user_risk ?? triage!.risk : null;
  const parts: string[] = [];
  if (part === "details") {
    parts.push(`From ${sender.name || sender.address || "an unknown sender"}${sender.address && sender.address !== sender.name ? `, ${sender.address}` : ""}.`);
    parts.push(`Received ${formatFullTime(email.received_at)}.`);
    parts.push(`Subject: ${email.subject?.trim() || "no subject"}.`);
    if (email.to_addrs) parts.push(`Sent to ${email.to_addrs.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}.`);
    if (email.cc_addrs) parts.push(`Copied to ${email.cc_addrs.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}.`);
    if (risk && RISK_SPOKEN[risk]) parts.push(RISK_SPOKEN[risk]);
    return parts.join("\n\n");
  }
  if (part === "summary") {
    if (!ok) return "This email hasn't been analyzed yet, so there is no summary. Say \"read it\" to hear the message itself.";
    if (risk && RISK_SPOKEN[risk]) parts.push(RISK_SPOKEN[risk]);
    parts.push(triage!.summary ? `In short: ${triage!.summary}` : "No summary is available.");
    if (risk !== "safe" && triage!.risk_explanation) parts.push(triage!.risk_explanation);
    if (triage!.type === "action_needed" && !triage!.done) parts.push("It looks like this one needs something from you.");
    return parts.join("\n\n");
  }
  // body: straight into the message. Keep only the danger warning - that one is worth the interruption.
  if (risk === "danger") parts.push(RISK_SPOKEN.danger);
  const body = speakableBody(email.body_text);
  parts.push(body || "This message has no readable text.");
  parts.push("End of message.");
  return parts.join("\n\n");
}

/** Short spoken rundown of the list: unread count and the newest few messages. */
export function describeInboxForSpeech(title: string, emails: EmailDto[], unread: number, max = 5): string {
  if (emails.length === 0) return `${title} is empty.`;
  const intro = unread > 0 ? `You have ${unread} unread ${unread === 1 ? "email" : "emails"} in ${title}.` : `No unread email in ${title}.`;
  const top = (unread > 0 ? emails.filter((e) => !e.is_read || e.thread_unread > 0) : emails).slice(0, max);
  const lines = top.map((e, i) => {
    const s = parseSender(e.sender);
    return `${i + 1}. From ${s.name || s.address || "unknown"}: ${e.subject?.trim() || "no subject"}.`;
  });
  return [intro, ...lines, `Say "open number one" to open the first one.`].join("\n");
}

export const VOICE_HELP =
  'Just say what you want, in your own words. For example: "read this to me", "what\'s this about", "who is it from", "what\'s new", "open the second one", "read the one from Dana", "reply saying thanks, I\'ll be there", "mark it done", "find anything about invoices", "check for new mail", "go back", "open settings", or "stop".';

// ---------------------------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------------------------

export type DictationError = "not-allowed" | "not-visible" | "no-mic" | "network" | "unsupported" | "other";

export function dictationErrorMessage(err: DictationError): string {
  switch (err) {
    case "unsupported":
      return "Dictation isn't available in this window.";
    case "not-allowed":
      return "Microphone access was turned off. Allow the microphone and speech recognition for Sentry Mail in System Settings > Privacy & Security.";
    case "not-visible":
      return "Bring the Sentry Mail window to the front, then press the microphone again.";
    case "no-mic":
      return "No microphone was found. Plug one in or check System Settings > Sound > Input.";
    case "network":
      return "Speech recognition couldn't reach its service. Check your internet connection and try again.";
    default:
      return "Dictation stopped unexpectedly. Try again.";
  }
}

/** Spoken punctuation and layout words -> characters. Longer phrases first so "new paragraph" wins over "new". */
const SPOKEN_MARKS: [RegExp, string][] = [
  [/\bnew paragraph\b/gi, "\n\n"],
  [/\bnew line\b/gi, "\n"],
  [/\bnext line\b/gi, "\n"],
  [/\bfull stop\b/gi, "."],
  [/\bperiod\b/gi, "."],
  [/\bquestion mark\b/gi, "?"],
  [/\bexclamation (?:mark|point)\b/gi, "!"],
  [/\bcomma\b/gi, ","],
  [/\bsemicolon\b/gi, ";"],
  [/\bcolon\b/gi, ":"],
  [/\bopen (?:quote|quotes|bracket|parenthesis)\b/gi, " ("],
  [/\bclose (?:quote|quotes|bracket|parenthesis)\b/gi, ") "],
  [/\bhyphen\b/gi, "-"],
  [/\bdash\b/gi, " - "],
  [/\bat sign\b/gi, "@"],
  [/\bsmiley(?: face)?\b/gi, ":)"],
];

/** Turns a raw transcript piece into typed text: punctuation words become marks, spacing is tidied,
 *  and sentence starts are capitalized. Pure so it can be unit-tested. */
export function normalizeDictation(raw: string): string {
  let text = ` ${raw.trim()} `;
  for (const [re, mark] of SPOKEN_MARKS) text = text.replace(re, mark);
  text = text
    .replace(/[ \t]+([.,!?;:)])/g, "$1") // no space before punctuation
    .replace(/([(])[ \t]+/g, "$1") // no space after an opening bracket
    .replace(/[ \t]*\n[ \t]*/g, "\n") // tidy around newlines
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^ +| +$/g, "");
  // Capitalize after sentence-ending punctuation and at paragraph starts.
  text = text.replace(/(^|[.!?]\s+|\n+\s*)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  // Engines often leave a standalone lowercase "i"; fix the common one.
  text = text.replace(/\bi\b(?=['\s,.!?])/g, "I");
  return text;
}

/** Appends a dictated piece to existing text with sensible spacing (no double spaces, no space after a newline). */
export function appendDictation(existing: string, piece: string): string {
  if (!piece) return existing;
  if (!existing) return piece;
  const endsBreak = /\n$/.test(existing);
  const startsPunct = /^[.,!?;:)]/.test(piece);
  const startsBreak = /^\n/.test(piece);
  if (endsBreak || startsPunct || startsBreak || /\s$/.test(existing)) return existing + piece;
  return `${existing} ${piece}`;
}

export interface DictationOptions {
  /** Called with each finalised, normalised piece of text. */
  onFinal: (text: string) => void;
  /** Keep listening through pauses until stop() (dictation) vs. stop after one phrase (commands). */
  continuous?: boolean;
}

export interface Dictation {
  supported: boolean;
  listening: boolean;
  /** What the recognizer currently thinks you're saying (not yet final). */
  interim: string;
  error: DictationError | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

/**
 * Speech -> text. WebKit stops recognizing after a pause even in continuous mode, so in
 * continuous mode we restart the engine on `end` until the user explicitly stops. Fatal errors
 * (permission, no mic) end the session and surface as `error`.
 */
export function useDictation({ onFinal, continuous = true }: DictationOptions): Dictation {
  const supported = dictationSupported();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<DictationError | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const wantRef = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const restartTimer = useRef<number | null>(null);

  const teardown = useCallback(() => {
    if (restartTimer.current !== null) {
      window.clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.onstart = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    }
    setInterim("");
    setListening(false);
  }, []);

  const launch = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError("unsupported");
      wantRef.current = false;
      return;
    }
    const rec = new Ctor();
    rec.lang = getVoiceSettings().lang;
    rec.continuous = continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let fatal = false;
    rec.onstart = () => setListening(true);
    rec.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) {
          const piece = normalizeDictation(t);
          if (piece) onFinalRef.current(piece);
        } else {
          interimText += t;
        }
      }
      setInterim(interimText.trim());
    };
    rec.onerror = (e) => {
      switch (e.error) {
        case "not-allowed":
        case "service-not-allowed":
          fatal = true;
          // WebKit refuses to listen while the window is hidden or in the background
          // (error "not-allowed", message "Page is not visible to user"); that isn't a permission problem.
          setError(/not visible/i.test(e.message ?? "") ? "not-visible" : "not-allowed");
          break;
        case "audio-capture":
          fatal = true;
          setError("no-mic");
          break;
        case "network":
          fatal = true;
          setError("network");
          break;
        case "no-speech":
        case "aborted":
          break; // routine; the `end` handler decides whether to restart
        default:
          fatal = true;
          setError("other");
      }
    };
    rec.onend = () => {
      setInterim("");
      if (recRef.current !== rec) return; // torn down already
      if (fatal || !continuous || !wantRef.current) {
        wantRef.current = false;
        recRef.current = null;
        setListening(false);
        return;
      }
      // Continuous dictation: the engine paused on silence; pick it straight back up.
      restartTimer.current = window.setTimeout(() => {
        restartTimer.current = null;
        if (wantRef.current) launch();
      }, 120);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      // start() throws if an instance is already running; treat as a restart.
      recRef.current = null;
      setListening(false);
    }
  }, [continuous]);

  const start = useCallback(() => {
    if (!supported) {
      setError("unsupported");
      return;
    }
    setError(null);
    wantRef.current = true;
    teardown();
    launch();
  }, [supported, teardown, launch]);

  const stop = useCallback(() => {
    wantRef.current = false;
    teardown();
  }, [teardown]);

  const toggle = useCallback(() => {
    if (wantRef.current || recRef.current) stop();
    else start();
  }, [start, stop]);

  // Unmount: stop the microphone.
  useEffect(
    () => () => {
      wantRef.current = false;
      teardown();
    },
    [teardown],
  );

  return { supported, listening, interim, error, start, stop, toggle };
}

// ---------------------------------------------------------------------------------------------
// Spoken commands
// ---------------------------------------------------------------------------------------------
//
// Two layers. `parseVoiceCommand` is an intent scorer: it strips filler, then looks for the *meaning*
// of a phrase (keywords, a number, a name) rather than an exact sentence, so "could you read me the
// second one" and "open number two and read it" both work. When it can't place a phrase, the dock
// asks the on-device model (`interpret_voice_command`) to map it to one of the same intents.

export type VoiceCommand =
  | { kind: "back" }
  | { kind: "settings" }
  /** Read aloud: the open email (its message, summary, or details) or, with nothing open, the inbox. */
  | { kind: "read"; part?: ReadPart }
  | { kind: "stop" }
  /** Start a reply. `instructions` = what the user wants said ("reply saying thanks, I'll publish it"), handed to the on-device drafter. */
  | { kind: "reply"; instructions?: string }
  | { kind: "mark_read"; read: boolean }
  | { kind: "done"; done: boolean }
  | { kind: "search"; query: string }
  | { kind: "clear_search" }
  /** Open the Nth visible email (0-based; -1 = last). `thenRead` = read it aloud once open. */
  | { kind: "open"; index: number; thenRead?: boolean }
  /** Open the visible email whose sender or subject best matches `query` ("Dana's email", "the one about invoices"). */
  | { kind: "open_match"; query: string; thenRead?: boolean }
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "sync" }
  | { kind: "folder"; folder: "inbox" | "quarantine" }
  | { kind: "help" };

const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, one: 1,
  second: 2, "2nd": 2, two: 2,
  third: 3, "3rd": 3, three: 3,
  fourth: 4, "4th": 4, four: 4,
  fifth: 5, "5th": 5, five: 5,
  sixth: 6, "6th": 6, six: 6,
  seventh: 7, "7th": 7, seven: 7,
  eighth: 8, "8th": 8, eight: 8,
  ninth: 9, "9th": 9, nine: 9,
  tenth: 10, "10th": 10, ten: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};

/** Words people drop into speech that carry no meaning for us. Longer phrases first. */
const FILLER =
  /\b(i would like to|i'd like to|i want to|i wanna|i need to|i need you to|could you please|can you please|would you please|could you|can you|would you|will you|please|kindly|let's|lets|let us|go ahead and|hey|hi|hello|ok|okay|alright|right|now|just|actually|basically|for me|to me|thanks|thank you|sentry mail|sentry|computer|um|uh|erm|hmm)\b/g;

function basicPhrase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:"“”()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhrase(raw: string): string {
  return basicPhrase(raw).replace(FILLER, " ").replace(/\s+/g, " ").trim();
}

/** "number two", "the third one", "2", "latest", "last" -> 0-based index (-1 = last), or null. */
function findPosition(t: string): number | null {
  if (/\b(latest|newest|most recent|top|top one|first one|the first|first)\b/.test(t)) return 0;
  if (/\b(last|bottom|oldest|final)\b/.test(t) && !/\b(last one i|the last time)\b/.test(t)) return -1;
  const num = t.match(/\b(?:number|no|num|#)?\s*(\d{1,2})\b/);
  if (num) return Math.max(0, parseInt(num[1], 10) - 1);
  for (const word of t.split(" ")) {
    if (word in ORDINALS && word !== "one") return ORDINALS[word] - 1;
  }
  // "one" only counts as a number next to "number" ("number one"), not in "this one".
  if (/\bnumber one\b/.test(t)) return 0;
  return null;
}

const READ_RE = /\b(read|reading|listen|hear|speak|say|tell me|out loud|aloud|narrate|recite|what does (it|this|that|the email|the message) say|what's (in|new)|what is (in|new)|whats (in|new)|anything new|what did (he|she|they|it) (say|write)|go through|go over|summar(y|ize|ise)|gist|play)\b/;
const SUMMARY_RE = /\b(summar(y|ize|ise|ise)|what's (this|it|that) about|what is (this|it|that) about|gist|in short|briefly|short version|tl;?dr|the point of (this|it)|key points?)\b/;
const DETAILS_RE = /\b(who (is|was|'s) (it|this|that) from|who sent (it|this|that|me this)|who's (it|this) from|whos (it|this) from|when (did|was) (it|this|that) (arrive|come|sent|come in)|what's the subject|what is the subject|who is (it|this) (to|for)|who (else )?got (it|this))\b/;
const SEARCH_LEAD =
  /^(?:(?:search|find|look for|looking for|look up|lookup|pull up|bring up|get me|get|show me|show|fetch|do i have|have i got|did i get|is there|are there|where is|where's|wheres)\b\s*)/;

/** Maps one spoken phrase to a command, or null if it isn't one we recognise. Forgiving about phrasing. */
export function parseVoiceCommand(raw: string): VoiceCommand | null {
  const t0 = basicPhrase(raw); // before filler removal ("can you" is meaningful in "what can you do")
  const t = normalizePhrase(raw);
  if (!t) return null;

  // Help / stop / clear-search first: short, unambiguous, and they'd otherwise be shadowed.
  if (/\b(help|what can i say|what can you do|what do you understand|what can i ask|commands|instructions|how does this work|how do i use this)\b/.test(t0)) return { kind: "help" };
  if (/\b(clear|cancel|close|remove|reset|exit|end|drop)\b.*\b(search|searching|results|filter)\b|\b(search|results)\b.*\b(clear|cancel|close|remove|reset|off)\b/.test(t))
    return { kind: "clear_search" };
  if (/\b(stop|quiet|hush|shush|silence|silent|shut up|pause|enough|be still|never mind|nevermind|cancel)\b/.test(t)) return { kind: "stop" };

  // Settings / folders / sync: keyword-driven, phrasing doesn't matter.
  if (/\b(settings?|preferences|options|configure|configuration|set up|setup)\b/.test(t)) return { kind: "settings" };
  if (/\b(quarantine|quarantined|dangerous|danger|scam|scams|suspicious|phishing|spam|threats?)\b/.test(t) && !/\b(mark|flag|not|isn't|is not)\b/.test(t))
    return { kind: "folder", folder: "quarantine" };
  if (/\b(sync|syncing|refresh|reload|fetch|update|check (for |my |the |any )*(new |latest )?(mail|email|emails|messages|inbox)|new (mail|email|emails|messages)|get (my |the |any |some )*(new |latest )?(mail|email|emails|messages))\b/.test(t) && !READ_RE.test(t))
    return { kind: "sync" };

  // Read-state and done-state come before "read" so "mark it as read" isn't a read-aloud.
  if (/\bunread\b/.test(t) && !SEARCH_LEAD.test(t)) return { kind: "mark_read", read: false };
  if (
    /\bas read\b|\b(i've|i have|already|i already) read\b/.test(t) ||
    (/\b(mark|flag|set|make|consider|treat)\b.*\bread\b/.test(t) && !/\bread (it|this|that|me|the|out|aloud|my|them)\b/.test(t))
  )
    return { kind: "mark_read", read: true };
  if (/\b(reopen|re-open|not done|undone|unfinished|not finished|undo done|still open|open it again)\b/.test(t)) return { kind: "done", done: false };
  if (/\b(done|finished|handled|dealt with|taken care|complete|completed|resolved|sorted|wrap(ped)? up|that's it for this|i'm through)\b/.test(t) && !READ_RE.test(t))
    return { kind: "done", done: true };

  // Reply, optionally with what to say: "reply saying thanks, I'll publish it", "tell her I'm free Thursday",
  // "answer that I can't make it". The content becomes instructions for the on-device drafter.
  const replyVerb = /\b(reply|replying|respond|responding|answer|write back|get back to|message (him|her|them) back|send (a |an |my )?(reply|answer|response)|draft (a |an |my )?(reply|response)|compose)\b/;
  // Content is taken from the un-stripped phrase: words like "thank you" are filler for us but are
  // exactly what the user wants said.
  const tellThem = t0.match(/^(?:ok |okay |um |uh |hey )*(?:please )?(?:tell|let) (?:him|her|them|the sender|this person)(?: know)? (?:that )?(.+)$/);
  if (replyVerb.test(t) || tellThem) {
    const content =
      tellThem?.[1] ??
      t0.match(/(?:reply|respond|answer|write back|get back to (?:him|her|them))\b(?: to (?:this|that|it|him|her|them|the email|this email))?(?: by)?(?: saying| and say| to say| with| that| telling (?:him|her|them)| and tell (?:him|her|them)|:)\s+(.+)$/)?.[1] ??
      null;
    const instructions = content?.replace(/^(?:that|like|something like|just)\s+/, "").trim();
    return instructions ? { kind: "reply", instructions } : { kind: "reply" };
  }

  // Next / previous.
  if (/\b(next|following|after this|skip|move on|the one after|forward one|go forward)\b/.test(t)) return { kind: "next" };
  if (/\b(previous|prior|before this|the one before|earlier one|back one|go back one|one back)\b/.test(t)) return { kind: "prev" };

  const wantsRead = READ_RE.test(t);
  const opensSomething = /\b(open|show|go to|goto|select|pick|choose|pull up|bring up|display|view|read|take me to|jump to|get)\b/.test(t);

  // "the second one", "number three", "read me the latest" -> open by position (and read if asked).
  const position = findPosition(t);
  if (position !== null && (opensSomething || /\b(one|email|message|mail|thread|that|it)\b/.test(t))) {
    return wantsRead ? { kind: "open", index: position, thenRead: true } : { kind: "open", index: position };
  }

  // "open Dana's email", "read the one about invoices", "show me the GitHub one" -> open by match.
  const byMatch =
    t.match(/\b(?:open|show|read|go to|pull up|bring up|view|display|select|find)\b(?: me)?(?: up)? (?:the |that |this |my )?(?:one|email|message|mail|thread|conversation)? ?(?:from|by|about|regarding|re|on|with|titled|called|named|mentioning|that mentions|that says|saying) (.+)$/) ??
    t.match(/\b(?:open|show|read|go to|pull up|bring up|view|display|select)\b(?: me)?(?: up)? (?:the |that |this |my )?(.+?)(?:'s)? (?:one|email|message|mail|thread|conversation)$/);
  if (byMatch) {
    const q = byMatch[1].replace(/\b(the|a|an|that|this|my|one|email|message|mail|thread)\b/g, " ").replace(/\s+/g, " ").trim();
    if (q && !/^(inbox|quarantine|settings|list|it|them)$/.test(q)) return wantsRead ? { kind: "open_match", query: q, thenRead: true } : { kind: "open_match", query: q };
  }

  // Search: anything that leads with a search verb and has words left after it.
  const lead = t.match(SEARCH_LEAD);
  if (lead) {
    let q = t.slice(lead[0].length);
    q = q
      .replace(/^(?:me |up |for |any |some |all |the |my |an |a )+/, "")
      .replace(/^(?:emails?|e-mails?|mails?|messages?|mail|anything|something|everything|stuff|threads?|conversations?)\b\s*/, "")
      .replace(/^(?:that (?:are|is|were|was) |which (?:are|is) )?(?:about|on|regarding|concerning|related to|to do with|mentioning|that mention|that say|saying|with|containing|for|from|by|sent by|titled|called)\b\s*/, "")
      .replace(/\b(in my inbox|in the inbox|in my email|in my mail)\b/g, " ")
      .replace(/^(?:the|a|an|my|our|that|this|those|these) /, "")
      .replace(/\s+/g, " ")
      .trim();
    if (q && !/^(inbox|quarantine|settings|list|new|it|them|me)$/.test(q)) return { kind: "search", query: q };
  }

  // Read aloud: the message itself by default; "what's this about" -> summary; "who is it from" -> details.
  if (SUMMARY_RE.test(t)) return { kind: "read", part: "summary" };
  if (DETAILS_RE.test(t)) return { kind: "read", part: "details" };
  if (wantsRead) return { kind: "read", part: "body" };

  // Back / inbox.
  if (/\b(back|inbox|close|return|exit|leave|home|list|go away|get out|main screen|mailbox|all emails|my emails|my mail)\b/.test(t)) return { kind: "back" };

  return null;
}

/** Intent names the on-device model may answer with (mirrors the GBNF grammar in src-tauri/src/llm/grammar.rs). */
export interface ModelIntent {
  intent: string;
  query: string;
}

/** Turns the model's answer into a command; unknown/empty -> null. */
export function commandFromModelIntent(r: ModelIntent): VoiceCommand | null {
  const q = (r.query ?? "").trim();
  switch (r.intent) {
    case "read":
      return { kind: "read", part: "body" };
    case "read_summary":
      return { kind: "read", part: "summary" };
    case "read_details":
      return { kind: "read", part: "details" };
    case "stop":
      return { kind: "stop" };
    case "reply":
      return q ? { kind: "reply", instructions: q } : { kind: "reply" };
    case "back":
      return { kind: "back" };
    case "settings":
      return { kind: "settings" };
    case "mark_read":
      return { kind: "mark_read", read: true };
    case "mark_unread":
      return { kind: "mark_read", read: false };
    case "done":
      return { kind: "done", done: true };
    case "reopen":
      return { kind: "done", done: false };
    case "search":
      return q ? { kind: "search", query: q } : null;
    case "clear_search":
      return { kind: "clear_search" };
    case "open_number": {
      const n = parseInt(q, 10);
      if (/^(last|bottom|oldest)$/i.test(q)) return { kind: "open", index: -1 };
      return Number.isFinite(n) && n > 0 ? { kind: "open", index: n - 1 } : { kind: "open", index: 0 };
    }
    case "open_match":
      return q ? { kind: "open_match", query: q } : null;
    case "next":
      return { kind: "next" };
    case "previous":
      return { kind: "prev" };
    case "sync":
      return { kind: "sync" };
    case "quarantine":
      return { kind: "folder", folder: "quarantine" };
    case "inbox":
      return { kind: "folder", folder: "inbox" };
    case "help":
      return { kind: "help" };
    default:
      return null;
  }
}

/** Short confirmation spoken/shown after a command runs, so the user knows it landed. */
export function describeCommand(cmd: VoiceCommand): string {
  switch (cmd.kind) {
    case "back":
      return "Back to the inbox";
    case "settings":
      return "Opening settings";
    case "read":
      return cmd.part === "summary" ? "Here's the summary" : cmd.part === "details" ? "Here are the details" : "Reading";
    case "stop":
      return "Stopped";
    case "reply":
      return cmd.instructions ? `Drafting a reply: "${cmd.instructions}"` : "Opening a reply";
    case "mark_read":
      return cmd.read ? "Marked as read" : "Marked as unread";
    case "done":
      return cmd.done ? "Marked done" : "Reopened";
    case "search":
      return `Searching for "${cmd.query}"`;
    case "clear_search":
      return "Search cleared";
    case "open":
      return `${cmd.index < 0 ? "Opening the last email" : `Opening email ${cmd.index + 1}`}${cmd.thenRead ? " and reading it" : ""}`;
    case "open_match":
      return `Opening the email about "${cmd.query}"${cmd.thenRead ? " and reading it" : ""}`;
    case "next":
      return "Next email";
    case "prev":
      return "Previous email";
    case "sync":
      return "Checking for new mail";
    case "folder":
      return cmd.folder === "quarantine" ? "Showing quarantine" : "Showing the inbox";
    case "help":
      return "Here's what you can say";
  }
}
