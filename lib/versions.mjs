// The two SDK versions under comparison are configured in `versions.json` (the
// source of truth). `npm run set-versions` / `sync-versions` generate the
// `sdk-baseline` / `sdk-candidate` npm aliases in package.json from it (env
// overrides: SDK_BASELINE / SDK_CANDIDATE). Everything else derives from the two
// role slots below; report labels are read from whatever is actually installed.
//
//   baseline  = the version you compare FROM (today: @stellar/stellar-sdk@15.1.0)
//   candidate = the version under test       (today: @stellar/stellar-sdk@16.0.0-rc.2)

import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROLES = ["baseline", "candidate"];

// npm alias name for a role, e.g. alias("candidate") === "sdk-candidate".
export const alias = (role) => `sdk-${role}`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Resolved @stellar/stellar-sdk version for a role (e.g. "16.0.0-rc.1"), read
// from the installed alias. Falls back to the role name if not installed.
export function resolvedVersion(role) {
  try {
    return JSON.parse(
      readFileSync(join(root, "node_modules", alias(role), "package.json"), "utf8"),
    ).version;
  } catch {
    throw new Error(
      `${alias(role)} is not installed. Run \`npm install\` ` +
        "(after `npm run sync-versions` if you edited versions.json).",
    );
  }
}

// Turn a version/spec into an npm-alias target.
//   "15.1.0"                         -> "npm:@stellar/stellar-sdk@15.1.0"
//   "@stellar/stellar-sdk@16.0.0-rc" -> "npm:@stellar/stellar-sdk@16.0.0-rc"
//   "@my/fork@1.0.0"                 -> "npm:@my/fork@1.0.0"
//   "file:../js-stellar-sdk"         -> "file:../js-stellar-sdk" (verbatim)
export const toSpec = (v) => {
  const s = String(v).replace(/^npm:/, "");
  if (/^(file:|link:|git\+|git:|github:|https?:)/.test(s)) return s;
  if (/^(@[^/@]+\/)?[A-Za-z0-9._-]+@.+/.test(s)) return `npm:${s}`;
  return `npm:@stellar/stellar-sdk@${s}`;
};

const safe = (v) => String(v).replace(/[^\w.-]+/g, "-");

// Folder name for this comparison's reports, e.g. "16.0.0-rc.1-vs-15.1.0".
export function reportDirName() {
  return `${safe(resolvedVersion("candidate"))}-vs-${safe(resolvedVersion("baseline"))}`;
}

// Absolute reports directory for this comparison (created if missing).
export function reportDir() {
  const dir = join(root, "reports", reportDirName());
  mkdirSync(dir, { recursive: true });
  return dir;
}
