// Permanently set the benchmarked SDK versions: updates versions.json (the
// config) AND the package.json aliases. Then run `npm install`.
//
//   node scripts/set-versions.mjs <baseline> <candidate>
//   node scripts/set-versions.mjs 15.1.0 16.0.0-rc.2
//
// For a temporary (uncommitted) change, leave versions.json alone and use the
// SDK_BASELINE / SDK_CANDIDATE env vars with `npm run sync-versions` instead.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toSpec } from "../lib/versions.mjs";

const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) {
  console.error("usage: node scripts/set-versions.mjs <baseline> <candidate>");
  console.error("  e.g. node scripts/set-versions.mjs 15.1.0 16.0.0-rc.2");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Update the config (preserving the "//" doc key).
const cfgPath = join(root, "versions.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
cfg.baseline = baseline;
cfg.candidate = candidate;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

// 2. Sync the generated package.json aliases.
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dependencies["sdk-baseline"] = toSpec(baseline);
pkg.dependencies["sdk-candidate"] = toSpec(candidate);
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`versions.json + package.json updated:`);
console.log(`  sdk-baseline  = ${pkg.dependencies["sdk-baseline"]}`);
console.log(`  sdk-candidate = ${pkg.dependencies["sdk-candidate"]}`);
console.log("\nNow run: npm install");
