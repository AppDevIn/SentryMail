// Dev-only diagnostic: run the app with the dev URL `http://localhost:1420/?voicetest=1` (e.g.
// `tauri dev --config '{"build":{"devUrl":"http://localhost:1420/?voicetest=1"}}'`) to exercise the
// webview's speech engines without touching the UI - prints support flags, speaks a line, starts
// recognition, and logs every event to an on-screen panel that can be read off a screenshot.
// Note: WebKit only recognizes while the window is frontmost, and a bare dev binary launched from
// another app inherits that app's TCC identity (mic access then aborts the process); launch it as an
// .app bundle or from Terminal when testing.
export function runVoiceProbe() {
  const panel = document.createElement("pre");
  panel.style.cssText =
    "position:fixed;left:12px;top:12px;z-index:99999;max-width:560px;padding:10px 12px;border-radius:8px;background:#000c;color:#9f9;font:12px/1.5 Menlo,monospace;white-space:pre-wrap;pointer-events:none";
  document.body.appendChild(panel);
  const log = (s: string) => {
    panel.textContent += `${new Date().toISOString().slice(11, 19)} ${s}\n`;
  };
  const w = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  log(`ua: ${navigator.userAgent.slice(0, 80)}`);
  log(`SpeechRecognition: ${Ctor ? "yes" : "NO"}  speechSynthesis: ${"speechSynthesis" in window ? "yes" : "NO"}`);
  if ("speechSynthesis" in window) {
    const say = () => {
      const voices = speechSynthesis.getVoices();
      log(`voices: ${voices.length} (default: ${voices.find((v) => v.default)?.name ?? "?"})`);
      const u = new SpeechSynthesisUtterance("Voice probe. Read aloud works.");
      u.onstart = () => log("tts: start");
      u.onend = () => log("tts: end");
      u.onerror = (e) => log(`tts: error ${e.error}`);
      speechSynthesis.speak(u);
    };
    if (speechSynthesis.getVoices().length) say();
    else speechSynthesis.addEventListener("voiceschanged", say, { once: true });
  }
  if (!Ctor) return;
  let attempts = 0;
  const tryRec = () => {
    attempts += 1;
    log(`rec: attempt ${attempts} (visibility=${document.visibilityState}, focus=${document.hasFocus()})`);
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.onstart = () => log("rec: start (mic open)");
    rec.onaudiostart = () => log("rec: audiostart");
    rec.onsoundstart = () => log("rec: soundstart");
    rec.onspeechstart = () => log("rec: speechstart");
    rec.onresult = (e: any) => {
      const r = e.results[e.results.length - 1];
      log(`rec: result${r.isFinal ? " FINAL" : ""}: "${r[0].transcript}"`);
    };
    let lastErr = "";
    rec.onerror = (e: any) => {
      lastErr = e.error;
      log(`rec: error ${e.error} ${e.message ?? ""}`);
    };
    rec.onend = () => {
      log("rec: end");
      // WebKit refuses while the window isn't frontmost; try again once it is.
      if (lastErr === "not-allowed" && attempts < 6) window.setTimeout(tryRec, 6000);
    };
    try {
      rec.start();
      log("rec: start() called");
    } catch (e) {
      log(`rec: start() threw ${String(e)}`);
    }
  };
  window.setTimeout(tryRec, 4000);
}
