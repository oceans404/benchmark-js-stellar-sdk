// Sync package.json's sdk-baseline / sdk-candidate aliases from versions.json,
// applying SDK_BASELINE / SDK_CANDIDATE env overrides (which do NOT change the
// file). Run before `npm install`.
//
//   npm run sync-versions
//   SDK_CANDIDATE=16.0.0-rc.2 npm run sync-versions   # temporary override
//
// package.json aliases are generated from versions.json; edit the config, not
// the aliases.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toSpec } from "../lib/versions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const cfg = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"));
const baseline = process.env.SDK_BASELINE || cfg.baseline;
const candidate = process.env.SDK_CANDIDATE || cfg.candidate;
if (!baseline || !candidate) {
  console.error("versions.json must define `baseline` and `candidate` (or set SDK_BASELINE / SDK_CANDIDATE).");
  process.exit(2);
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dependencies["sdk-baseline"] = toSpec(baseline);
pkg.dependencies["sdk-candidate"] = toSpec(candidate);
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`sdk-baseline  = ${pkg.dependencies["sdk-baseline"]}${process.env.SDK_BASELINE ? "  (env override)" : ""}`);
console.log(`sdk-candidate = ${pkg.dependencies["sdk-candidate"]}${process.env.SDK_CANDIDATE ? "  (env override)" : ""}`);
console.log("\nNow run: npm install");
