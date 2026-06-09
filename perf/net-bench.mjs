// Transport benchmark for ONE client config against a loopback server.
//
// Run as: node perf/net-bench.mjs <config> <port> <address> <out.json>
//   config: baseline | candidate-fetch | candidate-axios
// Imports only the requested build (the parent isolates each in its own process)
// and benchmarks `Horizon.Server.loadAccount()` against http://127.0.0.1:<port>,
// which returns a fixed account payload instantly. So this times the SDK's
// request-build + HTTP-client + JSON-parse path, not real network latency.

import { Bench } from "tinybench";
import { writeFileSync } from "node:fs";

const [config, portStr, address, outFile] = process.argv.slice(2);
const spec =
  config === "baseline"
    ? "sdk-baseline"
    : config === "candidate-axios"
      ? "sdk-candidate/axios"
      : "sdk-candidate";

let out;
try {
  const S = await import(spec);
  const server = new S.Horizon.Server(`http://127.0.0.1:${portStr}`, { allowHttp: true });

  // probe once so a parse/shape failure surfaces clearly, not as a bench error
  await server.loadAccount(address);

  const bench = new Bench({ time: 2000, warmupTime: 500 });
  bench.add("loadAccount", async () => {
    await server.loadAccount(address);
  });
  if (typeof bench.warmup === "function") {
    try { await bench.warmup(); } catch { /* run() handles it on newer API */ }
  }
  await bench.run();

  const r = bench.tasks[0].result ?? {};
  out = {
    config,
    node: process.version,
    hz: r.hz ?? r.throughput?.mean ?? null,
    rme: r.rme ?? r.throughput?.rme ?? r.latency?.rme ?? null,
    samples: r.samples?.length ?? r.latency?.samples?.length ?? null,
  };
} catch (err) {
  out = { config, node: process.version, hz: null, error: err?.message ?? String(err) };
}

writeFileSync(outFile, JSON.stringify(out, null, 2));
