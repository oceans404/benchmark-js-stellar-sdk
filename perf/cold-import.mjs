// One cold-start sample for ONE role (baseline or candidate), in a fresh process.
//
// Run as: node perf/cold-import.mjs <baseline|candidate>
// Prints a JSON line: { importMs, firstOpMs }
//   importMs  = time to evaluate the package's module graph (the dynamic import)
//   firstOpMs = import + first real operation (Keypair.random + Asset.native)
// The parent (run-perf.mjs) spawns this many times per role and aggregates;
// each spawn is a cold module cache, which is the whole point.

import { ROLES, alias } from "../lib/versions.mjs";

const role = process.argv[2];
if (!ROLES.includes(role)) {
  console.error("usage: node perf/cold-import.mjs <baseline|candidate>");
  process.exit(2);
}

const t0 = performance.now();
const S = await import(alias(role));
const t1 = performance.now();
try {
  S.Keypair.random();
  S.Asset.native();
} catch {
  /* keep going; importMs is still valid */
}
const t2 = performance.now();

process.stdout.write(JSON.stringify({ importMs: t1 - t0, firstOpMs: t2 - t0 }));
