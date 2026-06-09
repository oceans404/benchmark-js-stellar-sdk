// One cold-start sample for ONE version, in a fresh process.
//
// Run as: node perf/cold-import.mjs <v15|v16>
// Prints a JSON line: { importMs, firstOpMs }
//   importMs  = time to evaluate the package's module graph (the dynamic import)
//   firstOpMs = import + first real operation (Keypair.random + Asset.native)
// The parent (run-perf.mjs) spawns this many times per version and aggregates;
// each spawn is a cold module cache, which is the whole point.

const version = process.argv[2];
if (!["v15", "v16"].includes(version)) {
  console.error("usage: node perf/cold-import.mjs <v15|v16>");
  process.exit(2);
}
const spec = version === "v15" ? "sdk-v15" : "sdk-v16";

const t0 = performance.now();
const S = await import(spec);
const t1 = performance.now();
try {
  S.Keypair.random();
  S.Asset.native();
} catch {
  /* keep going; importMs is still valid */
}
const t2 = performance.now();

process.stdout.write(JSON.stringify({ importMs: t1 - t0, firstOpMs: t2 - t0 }));
