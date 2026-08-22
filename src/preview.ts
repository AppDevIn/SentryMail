import type { AttachmentDto } from "./types";

/**
 * What the in-app preview can render. Adding a type later (spreadsheets, plain text) means
 * one new branch in `previewKindFor` plus one `case` in AttachmentPreview - nothing else moves.
 */
export type PreviewKind = "image" | "pdf" | "unsupported";

/** Mirrors MAX_PREVIEW_BYTES in src-tauri/src/commands.rs, so we can refuse without a round trip. */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

function hasExtension(filename: string, ext: string): boolean {
  return filename.toLowerCase().trimEnd().endsWith(ext);
}

/**
 * Picks the renderer for an attachment. Sniffing may only ever *downgrade* to a safer choice -
 * an unknown type is never promoted into SVG or HTML.
 */
export function previewKindFor(a: AttachmentDto): PreviewKind {
  const mime = a.mime_type.toLowerCase().split(";")[0].trim();
  // Senders mislabel PDFs constantly, so fall back to the extension for generic types.
  if (mime === "application/pdf" || mime === "application/x-pdf") return "pdf";
  if ((mime === "application/octet-stream" || mime === "") && hasExtension(a.filename, ".pdf")) return "pdf";
  // SVG can carry script and external references: it must go to the external-open path instead.
  if (mime === "image/svg+xml") return "unsupported";
  if (mime.startsWith("image/")) return "image";
  return "unsupported";
}

/** Why we won't preview this, or null when we will. */
export function previewRefusalReason(a: AttachmentDto): "too-big" | "unsupported" | null {
  if (previewKindFor(a) === "unsupported") return "unsupported";
  if (a.size > MAX_PREVIEW_BYTES) return "too-big";
  return null;
}
