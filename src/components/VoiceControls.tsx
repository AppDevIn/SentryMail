import { useEffect, useRef, useState } from "react";
import { MicIcon, MicOffIcon, SpeakerIcon, StopIcon } from "./icons";
import {
  describeCommand,
  dictationErrorMessage,
  dictationSupported,
  parseVoiceCommand,
  speak,
  stopSpeaking,
  useDictation,
  useSpeaking,
  type VoiceCommand,
} from "../voice";

// Shared voice controls. Three pieces:
//   DictateButton  - a microphone toggle that feeds finalised text to its owner (reply box, search...)
//   ReadAloudButton - play/stop for whatever text its owner supplies
//   VoiceDock      - the floating "Voice" button that listens for one spoken command

interface DictateButtonProps {
  /** Receives each finalised, punctuation-normalised piece of speech. */
  onText: (piece: string) => void;
  /** Visible label when idle; the button always carries a mic icon. */
  label?: string;
  /** Icon-only, for tight spots like the search box. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  /** Show the inline "Listening…" line after the button (default). Owners that render their own
   *  live transcript pass false. Errors always render, so a denied mic is never silent. */
  showStatus?: boolean;
  /** Optional: called with the live partial transcript so owners can preview it themselves. */
  onInterim?: (text: string) => void;
  /** Fired whenever the mic turns on or off. */
  onListeningChange?: (listening: boolean) => void;
}

export function DictateButton({
  onText,
  label = "Dictate",
  compact = false,
  disabled = false,
  className = "",
  showStatus = true,
  onInterim,
  onListeningChange,
}: DictateButtonProps) {
  const d = useDictation({ onFinal: onText, continuous: true });
  const supported = dictationSupported();

  useEffect(() => {
    onInterim?.(d.interim);
  }, [d.interim, onInterim]);
  useEffect(() => {
    onListeningChange?.(d.listening);
  }, [d.listening, onListeningChange]);

  // Don't read aloud and record at the same time - the mic would hear the speaker.
  const toggle = () => {
    if (!d.listening) stopSpeaking();
    d.toggle();
  };

  const title = !supported
    ? "Dictation isn't available in this window"
    : d.listening
      ? "Stop dictating"
      : "Speak instead of typing. Say “new line” or “full stop” for punctuation.";

  return (
    <span className={`dictate ${d.listening ? "is-listening" : ""} ${className}`}>
      <button
        type="button"
        className={`dictate-btn ${compact ? "dictate-btn-compact" : ""}`}
        aria-pressed={d.listening}
        aria-label={d.listening ? "Stop dictating" : label}
        title={title}
        disabled={disabled || !supported}
        onClick={toggle}
      >
        {d.listening ? <MicOffIcon /> : <MicIcon />}
        {!compact && <span className="dictate-label">{d.listening ? "Stop" : label}</span>}
        {d.listening && <span className="dictate-dot sm-pulse" aria-hidden="true" />}
      </button>
      {showStatus && d.listening && (
        <span className="dictate-live" role="status" aria-live="polite">
          <span className="dictate-live-label">Listening…</span>
          {d.interim && <span className="dictate-interim">{d.interim}</span>}
        </span>
      )}
      {d.error && !d.listening && (
        <span className="dictate-error" role="alert">
          {dictationErrorMessage(d.error)}
        </span>
      )}
    </span>
  );
}

interface ReadAloudButtonProps {
  /** Builds the text to read when pressed (lazily, so it reflects the latest state). */
  text: () => string;
  className?: string;
  /** Label when idle. */
  label?: string;
  disabled?: boolean;
}

export function ReadAloudButton({ text, className = "tb-btn", label = "Read aloud", disabled = false }: ReadAloudButtonProps) {
  const speaking = useSpeaking();
  return (
    <button
      type="button"
      className={`${className} read-aloud-btn ${speaking ? "is-speaking" : ""}`}
      aria-pressed={speaking}
      disabled={disabled}
      title={speaking ? "Stop reading" : "Hear this email read out loud"}
      onClick={() => (speaking ? stopSpeaking() : speak(text()))}
    >
      {speaking ? <StopIcon /> : <SpeakerIcon />}
      {speaking ? "Stop reading" : label}
    </button>
  );
}

interface VoiceDockProps {
  /**
   * Runs a recognised command. Return a short note to show ("Opened settings"), or null to
   * signal the command doesn't apply right now ("No email is open").
   */
  onCommand: (cmd: VoiceCommand) => string | null | void;
  /**
   * Second opinion for phrases the local parser can't place: asks the on-device model.
   * null when the model isn't loaded.
   */
  interpret: ((transcript: string) => Promise<VoiceCommand | null>) | null;
}

const TOAST_MS = 7000;

/** Floating microphone for spoken commands: press, say one thing, see what happened. */
export function VoiceDock({ onCommand, interpret }: VoiceDockProps) {
  const [toast, setToast] = useState<{ heard: string | null; note: string; tone: "ok" | "warn" | "busy" } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const heardRef = useRef(false);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const interpretRef = useRef(interpret);
  interpretRef.current = interpret;
  const thinkSeq = useRef(0);

  const showToast = (t: NonNullable<typeof toast>, sticky = false) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = sticky ? null : window.setTimeout(() => setToast(null), TOAST_MS);
  };

  const run = (heard: string, cmd: VoiceCommand) => {
    const result = onCommandRef.current(cmd);
    if (result === null) showToast({ heard, note: "That doesn't apply right now.", tone: "warn" });
    else showToast({ heard, note: result || describeCommand(cmd), tone: "ok" });
  };

  const d = useDictation({
    continuous: false,
    onFinal: (text) => {
      heardRef.current = true;
      const cmd = parseVoiceCommand(text);
      if (cmd) {
        run(text, cmd);
        return;
      }
      const ask = interpretRef.current;
      if (!ask) {
        showToast({ heard: text, note: "I didn't catch a request in that. Say “help” to hear examples, or turn on Analysis in Settings so I can understand more phrasings.", tone: "warn" });
        return;
      }
      // Ask the on-device model what was meant; keep the toast up while it thinks.
      const id = ++thinkSeq.current;
      showToast({ heard: text, note: "Thinking about what you meant…", tone: "busy" }, true);
      ask(text)
        .then((fromModel) => {
          if (id !== thinkSeq.current) return;
          if (fromModel) run(text, fromModel);
          else showToast({ heard: text, note: "I couldn't work out what you meant. Say “help” to hear examples.", tone: "warn" });
        })
        .catch(() => {
          if (id !== thinkSeq.current) return;
          showToast({ heard: text, note: "I couldn't work out what you meant. Say “help” to hear examples.", tone: "warn" });
        });
    },
  });

  // Ended without hearing a phrase: tell the user rather than leaving them guessing.
  const wasListening = useRef(false);
  useEffect(() => {
    if (wasListening.current && !d.listening && !heardRef.current && !d.error) {
      showToast({ heard: null, note: "I didn't hear anything. Press the button and speak right after.", tone: "warn" });
    }
    wasListening.current = d.listening;
    if (d.listening) heardRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.listening]);

  useEffect(() => {
    if (d.error) showToast({ heard: null, note: dictationErrorMessage(d.error), tone: "warn" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.error]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  if (!d.supported) return null;

  const press = () => {
    if (d.listening) {
      d.stop();
      return;
    }
    stopSpeaking();
    thinkSeq.current += 1; // drop any pending model answer
    setToast(null);
    d.start();
  };

  return (
    <div className="voice-dock">
      {(d.listening || toast) && (
        <div className={`voice-toast sm-fade ${toast?.tone === "warn" ? "is-warn" : ""} ${toast?.tone === "busy" ? "is-busy" : ""}`} role="status" aria-live="polite">
          {d.listening ? (
            <>
              <span className="voice-toast-title">Listening…</span>
              <span className="voice-toast-body">{d.interim || "Say a command, for example “read this email” or “help”."}</span>
            </>
          ) : (
            toast && (
              <>
                {toast.heard && <span className="voice-toast-title">Heard: “{toast.heard}”</span>}
                <span className="voice-toast-body">{toast.note}</span>
              </>
            )
          )}
        </div>
      )}
      <button
        type="button"
        className={`voice-dock-btn ${d.listening ? "is-listening" : ""}`}
        aria-pressed={d.listening}
        aria-label={d.listening ? "Stop listening" : "Voice command"}
        title={d.listening ? "Stop listening" : "Press, then say a command (try “help”)"}
        onClick={press}
      >
        {d.listening ? <MicOffIcon width={20} height={20} /> : <MicIcon width={20} height={20} />}
        <span className="voice-dock-label">{d.listening ? "Listening" : "Voice"}</span>
      </button>
    </div>
  );
}
