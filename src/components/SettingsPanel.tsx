import { useEffect, useState } from "react";
import type { ModelStatus } from "../types";
import { currentTheme, setTheme as persistTheme } from "../theme";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  modelStatus: ModelStatus;
  embedModelStatus: ModelStatus;
  busy: boolean;
  lastSyncedAt: Date | null;
  onLoadModel: () => void;
  onTriageAll: () => void;
  onLoadEmbeddingModel: () => void;
  onEmbedPending: () => void;
}

function describe(status: ModelStatus): { label: string; detail: string } {
  switch (status.state) {
    case "not_configured":
      return { label: "Not installed", detail: "Place the model file in the app's models folder (see SETUP.md), then restart." };
    case "not_loaded":
      return { label: "Off", detail: "Installed on this Mac, not running yet." };
    case "loading":
      return { label: "Starting…", detail: status.progress_pct != null ? `${status.progress_pct}%` : "Loading into memory." };
    case "ready":
      return { label: "On", detail: "Runs entirely on this Mac. Email content never leaves the device." };
    case "failed":
      return { label: "Failed", detail: status.message };
  }
}

/** Where the machinery lives: model on/off, search index, sync. Out of the main UI by design. */
export function SettingsPanel({
  open,
  onClose,
  modelStatus,
  embedModelStatus,
  busy,
  lastSyncedAt,
  onLoadModel,
  onTriageAll,
  onLoadEmbeddingModel,
  onEmbedPending,
}: SettingsPanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const [theme, setTheme] = useState(currentTheme);
  const chooseTheme = (t: string) => {
    persistTheme(t);
    setTheme(t);
  };

  if (!open) return null;
  const triage = describe(modelStatus);
  const search = describe(embedModelStatus);

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings sm-fade" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-head">
          <span className="settings-title">Settings</span>
          <button type="button" className="link-action" onClick={onClose}>
            Close
          </button>
        </div>

        <section className="settings-section">
          <div className="settings-row">
            <div>
              <div className="settings-name">Appearance</div>
              <div className="settings-detail">Dark for focus, light for reading in bright rooms, or follow the system.</div>
            </div>
            <div className="settings-actions theme-picker" role="radiogroup" aria-label="Appearance">
              {(["system", "dark", "light"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme === t}
                  className={`btn btn-mini ${theme === t ? "is-selected" : ""}`}
                  onClick={() => chooseTheme(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <div>
              <div className="settings-name">Analysis</div>
              <div className="settings-detail">
                Classifies each email, checks it for scams, and drafts replies. <span className={`mono settings-state ${modelStatus.state === "ready" ? "is-accent" : ""}`}>{triage.label}</span>
              </div>
              <div className="settings-hint">{triage.detail}</div>
            </div>
            <div className="settings-actions">
              {modelStatus.state === "not_loaded" && (
                <button type="button" className="btn btn-accent" disabled={busy} onClick={onLoadModel}>
                  Turn on
                </button>
              )}
              {modelStatus.state === "failed" && (
                <button type="button" className="btn" disabled={busy} onClick={onLoadModel}>
                  Retry
                </button>
              )}
              {modelStatus.state === "ready" && (
                <button type="button" className="btn" disabled={busy} onClick={onTriageAll} title="Analyze every email that hasn't been analyzed yet">
                  Analyze new emails
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <div>
              <div className="settings-name">Search by meaning</div>
              <div className="settings-detail">
                Lets the search box find emails by what they're about, not just words. <span className={`mono settings-state ${embedModelStatus.state === "ready" ? "is-accent" : ""}`}>{search.label}</span>
              </div>
              <div className="settings-hint">{search.detail}</div>
            </div>
            <div className="settings-actions">
              {embedModelStatus.state === "not_loaded" && (
                <button type="button" className="btn btn-accent" disabled={busy} onClick={onLoadEmbeddingModel}>
                  Turn on
                </button>
              )}
              {embedModelStatus.state === "ready" && (
                <button type="button" className="btn" disabled={busy} onClick={onEmbedPending}>
                  Index new emails
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <div>
              <div className="settings-name">Sync</div>
              <div className="settings-detail">
                Checks Gmail every 5 minutes while the app is open, and when you click sync now.
              </div>
              <div className="settings-hint">{lastSyncedAt ? `Last synced ${lastSyncedAt.toLocaleTimeString()}` : "Not synced yet"}</div>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <div>
              <div className="settings-name">Privacy</div>
              <div className="settings-detail">
                Your mail is analyzed on this Mac. Remote images and tracking pixels are blocked; links open only when you click them.
                Nothing about your email is sent to any analysis service.
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
