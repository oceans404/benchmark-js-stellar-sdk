// Hot-path microbenchmarks for ONE role (baseline or candidate).
//
// Run as: node perf/micro.mjs <baseline|candidate> <out.json>
// It imports only the requested role's SDK (process isolation is the parent's
// job; run-perf.mjs spawns one of these per role) and writes tinybench results
// as JSON to <out.json>. stdout is left for tinybench/SDK noise; only the file
// is parsed by the parent.

import { Bench } from "tinybench";
import { writeFileSync } from "node:fs";
import { ROLES, alias } from "../lib/versions.mjs";

const role = process.argv[2];
const outFile = process.argv[3];
if (!ROLES.includes(role) || !outFile) {
  console.error("usage: node perf/micro.mjs <baseline|candidate> <out.json>");
  process.exit(2);
}

const S = await import(alias(role));

// Fixed inputs, built once outside the timed functions.
const kp = S.Keypair.random();
const destPk = S.Keypair.random().publicKey(); // fixed destination (no keygen in hot loop)
const msg = crypto.getRandomValues(new Uint8Array(32));
const sig = kp.sign(msg);
const data = crypto.getRandomValues(new Uint8Array(64));
const scVals = ["hello", 42n, true, { k: "v" }, [1, 2, 3], new Uint8Array(8)];
const intVals = [0n, 2n ** 63n - 1n, -(2n ** 63n), 2n ** 64n - 1n];

const buildTx = () => {
  const acct = new S.Account(kp.publicKey(), "0");
  return new S.TransactionBuilder(acct, {
    fee: S.BASE_FEE,
    networkPassphrase: S.Networks.TESTNET,
  })
    .addOperation(
      S.Operation.payment({
        destination: destPk,
        asset: S.Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();
};
// v17 renamed `toXDR` -> `toXdr` and `TransactionBuilder.fromXDR` -> `fromXdr`
// with no back-compat aliases; bind to whichever the installed version exposes
// so the same benchmark measures the same work in both.
const toXdr = (t) => (t.toXdr ? t.toXdr() : t.toXDR());
const fromXdr = (xdr) =>
  S.TransactionBuilder.fromXdr
    ? S.TransactionBuilder.fromXdr(xdr, S.Networks.TESTNET)
    : S.TransactionBuilder.fromXDR(xdr, S.Networks.TESTNET);

const signedXdr = (() => {
  const t = buildTx();
  t.sign(kp);
  return toXdr(t);
})();

// [name, fn]. Each is feature-probed once before being added; anything that
// throws (symbol missing in this version) is skipped and reported, not fatal.
const candidates = [
  ["sign", () => kp.sign(msg)],
  ["verify", () => kp.verify(msg, sig)],
  ["hash", () => S.hash(data)],
  ["keypair.random", () => S.Keypair.random()],
  [
    "build+sign+toXDR",
    () => {
      const t = buildTx();
      t.sign(kp);
      return toXdr(t);
    },
  ],
  ["fromXDR", () => fromXdr(signedXdr)],
  ["nativeToScVal", () => { for (const v of scVals) S.nativeToScVal(v); }],
  [
    "ScInt round-trip",
    () => {
      for (const v of intVals) {
        const s = new S.ScInt(v);
        s.toI128();
        s.toBigInt();
      }
    },
  ],
];

const bench = new Bench({ time: 1500, warmupTime: 400 });
const skipped = [];
for (const [name, fn] of candidates) {
  try {
    fn(); // probe
    bench.add(name, fn);
  } catch (err) {
    skipped.push({ name, error: err?.message ?? String(err) });
  }
}

if (typeof bench.warmup === "function") {
  try { await bench.warmup(); } catch { /* older/newer API: run() handles it */ }
}
await bench.run();

const results = bench.tasks.map((t) => {
  const r = t.result ?? {};
  return {
    name: t.name,
    // defensive across tinybench 2.x (hz/rme) and 3.x (throughput.*)
    hz: r.hz ?? r.throughput?.mean ?? null,
    rme: r.rme ?? r.throughput?.rme ?? r.latency?.rme ?? null,
    samples: r.samples?.length ?? r.latency?.samples?.length ?? null,
    error: r.error ? (r.error.message ?? String(r.error)) : undefined,
  };
});

writeFileSync(outFile, JSON.stringify({ role, node: process.version, results, skipped }, null, 2));
