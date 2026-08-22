// Copies pdf.js's runtime assets into public/ so the viewer is fully offline.
//
// pdf.js 6 loads its JPEG2000 decoder and colour-management code as .wasm at runtime, and
// pulls CJK/CID character maps, ICC profiles and the standard font data on demand. Without
// local copies those PDFs throw (e.g. "JpxImage#instantiateWasm: Ensure that the wasmUrl API
// parameter is provided"). Copying the worker here too - rather than relying on Vite's
// `new URL(..., import.meta.url)` worker handling - keeps one mechanism, with no CDN fetch
// and no content-hash surprises across Vite majors.
//
// Everything copied must stay version-matched to the installed pdfjs-dist, which is why this
// runs from predev/prebuild rather than being committed.
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const SRC = "node_modules/pdfjs-dist";
const OUT = "public/pdfjs";

if (!existsSync(SRC)) {
  console.error("[sync-pdfjs] pdfjs-dist is not installed - run npm install first.");
  process.exit(1);
}

const version = JSON.parse(readFileSync(`${SRC}/package.json`, "utf8")).version;
const stamp = `${OUT}/.version`;

// predev/prebuild run this on every start, and a dev server may be serving these files right
// now - so only rebuild the directory when the installed version actually changed. Wiping it
// unconditionally makes the worker 404 for whoever is mid-request.
if (existsSync(stamp) && readFileSync(stamp, "utf8") === version) {
  console.log(`[sync-pdfjs] public/pdfjs already matches pdfjs-dist ${version}`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const dir of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
  if (existsSync(`${SRC}/${dir}`)) cpSync(`${SRC}/${dir}`, `${OUT}/${dir}`, { recursive: true });
  else console.warn(`[sync-pdfjs] ${dir}/ not present in this pdfjs-dist - skipping.`);
}
cpSync(`${SRC}/build/pdf.worker.min.mjs`, `${OUT}/pdf.worker.min.mjs`);

writeFileSync(stamp, version);
console.log(`[sync-pdfjs] copied pdf.js ${version} assets into public/pdfjs`);
