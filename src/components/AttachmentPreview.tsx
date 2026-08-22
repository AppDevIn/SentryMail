import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentDto } from "../types";
import { api } from "../api";
import { formatSize } from "../format";
import { previewKindFor, previewRefusalReason } from "../preview";

const PdfViewer = lazy(() => import("./PdfViewer"));

interface AttachmentPreviewProps {
  emailId: number;
  attachment: AttachmentDto;
  /** Subject of the conversation it came from, for orientation in the header. */
  emailSubject: string;
  /**
   * False when triage rated the message `danger`. Rendering in a script-less worker is safer
   * than the OS handler, so the preview itself stays available - but handing the file to the
   * system app must stay blocked, exactly as the attachment chips used to block it.
   */
  allowExternalOpen: boolean;
  onBack: () => void;
}

/** Short machine label for the header: "PDF · 178 KB". */
function kindLabel(a: AttachmentDto): string {
  const kind = previewKindFor(a);
  if (kind === "pdf") return "PDF";
  if (kind === "image") return a.mime_type.replace(/^image\//, "").toUpperCase();
  return a.mime_type || "FILE";
}

export function AttachmentPreview({ emailId, attachment, emailSubject, allowExternalOpen, onBack }: AttachmentPreviewProps) {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingExternally, setOpeningExternally] = useState(false);
  // Kept apart from `error`: a failed external open must not replace a preview that is working.
  const [externalError, setExternalError] = useState<string | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);

  const refusal = previewRefusalReason(attachment);
  const kind = previewKindFor(attachment);

  // The way out should be the first thing a keyboard lands on.
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  // The preview owns Escape while it is up; EmailDetail's own handler stands down via `suspended`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement) {
        document.activeElement.blur();
        return;
      }
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  useEffect(() => {
    setBytes(null);
    setError(null);
    setRenderFailed(false);
    // Nothing to fetch when we already know we cannot show it.
    if (refusal) return;
    let cancelled = false;
    setLoading(true);
    api
      .attachmentBytes(emailId, attachment.attachment_id)
      .then((buf) => {
        if (!cancelled) setBytes(buf);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [emailId, attachment.attachment_id, refusal]);

  const openExternally = async () => {
    if (!allowExternalOpen) return;
    setOpeningExternally(true);
    setExternalError(null);
    try {
      await api.openAttachment(emailId, attachment.attachment_id);
    } catch (e) {
      setExternalError(String(e));
    } finally {
      setOpeningExternally(false);
    }
  };

  /** Stable identity: PdfViewer tears down and re-parses the document when this changes. */
  const onRenderFailed = useCallback(() => setRenderFailed(true), []);

  const externalButton = (accent: boolean) =>
    allowExternalOpen ? (
      <button
        type="button"
        className={`btn ${accent ? "btn-accent " : ""}preview-btn`}
        disabled={openingExternally}
        onClick={() => void openExternally()}
      >
        {openingExternally ? "Opening…" : "Open with my computer's app"}
      </button>
    ) : null;

  const fallback = (headline: string, explanation: string) => (
    <div className="preview-fallback">
      <p className="preview-fallback-title">{headline}</p>
      <p className="preview-fallback-note">{explanation}</p>
      {!allowExternalOpen && (
        <p className="preview-fallback-note">
          This email looks like a scam, so we will not hand the file to another app on your computer.
        </p>
      )}
      <div className="preview-fallback-actions">
        {externalButton(true)}
        <button type="button" className="btn preview-btn" onClick={onBack}>
          Back to the email
        </button>
      </div>
      {externalError && <p className="inline-error">{externalError}</p>}
    </div>
  );

  let body: React.ReactNode;
  if (refusal === "too-big") {
    body = fallback(
      "This file is too big to show here",
      `${attachment.filename} is ${formatSize(attachment.size)}. We can only show files up to 25 MB.`,
    );
  } else if (refusal === "unsupported") {
    body = fallback("We can't show this kind of file yet", `You can still open ${attachment.filename} with the app your computer uses for it.`);
  } else if (renderFailed) {
    body = fallback("We couldn't read this file", "It may be damaged, or protected with a password.");
  } else if (error) {
    body = fallback("We couldn't open this file", error);
  } else if (loading || !bytes) {
    body = (
      <p className="preview-status" aria-live="polite">
        Opening {attachment.filename}…
      </p>
    );
  } else if (kind === "image") {
    body = <ImagePreview data={bytes} mimeType={attachment.mime_type} filename={attachment.filename} onFailed={onRenderFailed} />;
  } else {
    body = (
      <Suspense fallback={<p className="preview-status" aria-live="polite">Opening the document…</p>}>
        <PdfViewer data={bytes} filename={attachment.filename} onFailed={onRenderFailed} />
      </Suspense>
    );
  }

  return (
    <section className="preview sm-fade" role="region" aria-label={`Preview of ${attachment.filename}`}>
      <div className="preview-bar">
        <button type="button" ref={backRef} className="preview-back" onClick={onBack}>
          ← Back to the email
        </button>
        <span className="preview-title" title={`${attachment.filename} — from "${emailSubject}"`}>
          {attachment.filename}
        </span>
        <span className="mono preview-meta">
          {kindLabel(attachment)} · {formatSize(attachment.size)}
        </span>
        <div className="preview-actions">{externalButton(false)}</div>
      </div>
      {externalError && <p className="inline-error preview-external-error">{externalError}</p>}
      <div className="preview-stage">{body}</div>
    </section>
  );
}

/** Images need no library: a blob URL straight into an <img>. */
function ImagePreview({
  data,
  mimeType,
  filename,
  onFailed,
}: {
  data: ArrayBuffer;
  mimeType: string;
  filename: string;
  onFailed: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([data], { type: mimeType }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data, mimeType]);
  if (!url) return null;
  // image/* covers formats no browser decodes (tiff, heic, x-icon). Without this they would
  // sit as a permanently broken image with no way out.
  return <img className="preview-image" src={url} alt={filename} onError={onFailed} />;
}
