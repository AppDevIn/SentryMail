import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask } from "pdfjs-dist";

// The worker and the wasm/cmap/font assets are copied into public/pdfjs by
// scripts/sync-pdfjs.mjs. Root-relative paths work under both the Vite dev server and
// tauri://localhost. Nothing here ever reaches the network.
GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

/**
 * Opens a PDF from bytes we already hold in memory.
 *
 * A PDF from an email is attacker-controlled input, so this is deliberately locked down:
 *
 * - `disableFontFace` draws glyphs as canvas paths instead of injecting an attacker-built
 *   `@font-face` into the document. That font path is exactly where CVE-2024-4367 lived: a
 *   missing type check on a font's FontMatrix reached `eval()` and gave arbitrary JS in the
 *   hosting origin. It was fixed in pdf.js 4.2.67 and the eval path is gone entirely in 6.x,
 *   but we keep the safer rendering mode regardless.
 * - There is no `isEvalSupported: false` here because on 6.x the option no longer exists - the
 *   eval-based font path it used to guard has been removed outright.
 * - Parsing itself runs in the pdf.js Web Worker, which has no DOM and no
 *   `window.__TAURI_INTERNALS__`, so a malicious file cannot reach `invoke()`.
 *
 * Note for a future CSP: tauri.conf.json currently sets `"csp": null`, so the module worker and
 * wasm instantiation are unblocked. Adding a real CSP would need `worker-src 'self'` and
 * `script-src 'wasm-unsafe-eval'`.
 */
export function loadPdf(data: Uint8Array): PDFDocumentLoadingTask {
  // Returns the loading task, not the promise: `destroy()` lives on the task and is what tears
  // the worker down when the viewer unmounts.
  return getDocument({
    data,
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    disableFontFace: true,
    useSystemFonts: false,
    // We always hand it a complete in-memory buffer, so there is nothing to range-request.
    disableAutoFetch: true,
    disableRange: true,
    verbosity: 0,
  });
}
