import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdf } from "../pdf";

/** Beyond this we stop rendering and point at the system app; long PDFs are rare in mail. */
const MAX_PAGES = 50;
const ZOOM_LADDER = [0.75, 1, 1.25, 1.5, 2, 3];

interface PdfViewerProps {
  data: ArrayBuffer;
  filename: string;
  /** Corrupt, encrypted or otherwise unreadable: the parent swaps in the fallback card. */
  onFailed: () => void;
}

export default function PdfViewer({ data, onFailed }: PdfViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // pdf.js takes ownership of the buffer it is given, so hand it a copy: React 19's
    // StrictMode runs this effect twice and the second pass would otherwise get a detached one.
    const task = loadPdf(new Uint8Array(data.slice(0)));
    task.promise
      .then((pdf) => {
        if (cancelled) return;
        setDoc(pdf);
        setPageCount(pdf.numPages);
      })
      .catch(() => {
        // Tearing the task down mid-load rejects the promise; that is not a real failure.
        if (!cancelled) onFailed();
      });
    return () => {
      cancelled = true;
      setDoc(null);
      void task.destroy();
    };
  }, [data, onFailed]);

  // Default to fit-to-width, snapped to the nearest rung of the ladder.
  useEffect(() => {
    if (!doc || scale !== null) return;
    let cancelled = false;
    doc.getPage(1).then((page) => {
      if (cancelled) return;
      const available = (stageRef.current?.clientWidth ?? 900) - 48;
      const natural = page.getViewport({ scale: 1 }).width;
      const wanted = available / natural;
      const snapped = ZOOM_LADDER.reduce((best, s) => (Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best), ZOOM_LADDER[0]);
      setScale(snapped);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, scale]);

  const shown = Math.min(pageCount, MAX_PAGES);
  const zoomIndex = scale === null ? -1 : ZOOM_LADDER.indexOf(scale);

  return (
    <div className="pdf" ref={stageRef}>
      <div className="pdf-controls">
        <button
          type="button"
          className="btn preview-btn"
          disabled={zoomIndex <= 0}
          onClick={() => setScale(ZOOM_LADDER[Math.max(0, zoomIndex - 1)])}
        >
          Zoom out
        </button>
        <span className="mono pdf-zoom">{scale === null ? "…" : `${Math.round(scale * 100)}%`}</span>
        <button
          type="button"
          className="btn preview-btn"
          disabled={zoomIndex < 0 || zoomIndex >= ZOOM_LADDER.length - 1}
          onClick={() => setScale(ZOOM_LADDER[Math.min(ZOOM_LADDER.length - 1, zoomIndex + 1)])}
        >
          Zoom in
        </button>
        {pageCount > 0 && (
          <span className="mono pdf-count">
            {pageCount} {pageCount === 1 ? "page" : "pages"}
          </span>
        )}
      </div>

      {doc && scale !== null &&
        Array.from({ length: shown }, (_, i) => (
          // Keying on scale remounts the canvas on zoom rather than re-rendering into a live
          // one, which is what pdf.js refuses with "Cannot use the same canvas during multiple
          // render() operations."
          <PdfPage key={`${i + 1}@${scale}`} doc={doc} pageNumber={i + 1} scale={scale} onFailed={onFailed} />
        ))}

      {pageCount > MAX_PAGES && (
        <p className="preview-note">
          Showing the first {MAX_PAGES} pages of {pageCount}. Open it with your computer's app to see all of it.
        </p>
      )}
    </div>
  );
}

function PdfPage({
  doc,
  pageNumber,
  scale,
  onFailed,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onFailed: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;

    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
        return task.promise.then(() => {
          if (!cancelled) setReady(true);
        });
      })
      .catch((e: unknown) => {
        // A cancelled render is the expected outcome of StrictMode's double-invoke and of
        // zooming mid-render - it is not a failure worth surfacing.
        if (cancelled || (e as { name?: string })?.name === "RenderingCancelledException") return;
        onFailed();
      });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale, onFailed]);

  return (
    <div className="preview-page">
      <span className="mono preview-page-num">
        page {pageNumber}
        {ready ? "" : " · loading"}
      </span>
      <canvas ref={canvasRef} />
    </div>
  );
}
