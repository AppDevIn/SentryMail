import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import App from "./App";
import { initTheme } from "./theme";

initTheme();

function boot() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Dev-only: `npm run dev` then open http://localhost:1420/?mock=1 in a plain browser to work
// on the UI against fixture data without the Tauri shell, Gmail, or a model file.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")) {
  import("./dev/mockTauri").then(boot);
} else {
  boot();
}

// Dev-only: ?voicetest=1 runs the speech-engine probe (src/dev/voiceProbe.ts) over the live app.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("voicetest")) {
  import("./dev/voiceProbe").then((m) => m.runVoiceProbe());
}
