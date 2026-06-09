// Browser-without-polyfill check.
//
// Bundles the smoke test for `platform: browser` (the way a web app bundles the
// SDK), then runs the bundled output in this process with the Node `Buffer`
// global removed — simulating a browser, where `Buffer` does not exist. If v16
// inlines its own buffer shim it passes (at a bundle-size cost, flagged by the
// bundle benchmark); if it leans on a global `Buffer`, it fails here.
//
// Run: node runtime/run-browser.mjs

import { build } from "esbuild";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { report } from "./smoke.mjs";

// The entry must live inside the project so esbuild resolves `sdk-v16` from
// node_modules and `./smoke.mjs` relatively. Output goes to a temp dir.
const entryFile = join(import.meta.dirname, ".browser-entry.mjs");
writeFileSync(
  entryFile,
  `import * as sdk from "sdk-v16";
import { runSmoke } from "./smoke.mjs";
globalThis.__runSmoke = () => runSmoke(sdk);
`,
);

const tmp = mkdtempSync(join(tmpdir(), "sdk-browser-"));
const bundlePath = join(tmp, "bundle.mjs");
const savedBuffer = globalThis.Buffer;

// One try/finally so the temp dir, entry file, and Buffer global are always
// restored — even if the esbuild build itself throws.
let checks;
try {
  await build({
    entryPoints: [entryFile],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    logLevel: "silent",
  });
  // Remove the Node-only global so the bundle can't quietly rely on it.
  delete globalThis.Buffer;
  await import(pathToFileURL(bundlePath).href);
  checks = await globalThis.__runSmoke();
} catch (err) {
  checks = [{ name: "browser bundle builds, loads + runs without Buffer global", ok: false, error: err?.message ?? String(err) }];
} finally {
  globalThis.Buffer = savedBuffer;
  try { unlinkSync(entryFile); } catch { /* already gone */ }
  rmSync(tmp, { recursive: true, force: true });
}

const ok = report("browser (simulated: Node, Buffer global removed)", checks);
console.log(
  ok
    ? "  → v16 stands alone without a Buffer global (bundled shim). Note: simulated, not a real browser."
    : "  → v16 relies on a Buffer global or a missing browser API here; see failures above.",
);
process.exit(ok ? 0 : 1);
