// Cloudflare Workers (workerd) runner. Boots worker.mjs locally via wrangler's
// programmatic dev server, hits "/", and reports the smoke-test result. The
// wrangler.toml deliberately omits `nodejs_compat`, so this exercises the bare
// edge runtime. Run: node runtime/run-worker.mjs
import { unstable_dev } from "wrangler";
import { fileURLToPath } from "node:url";
import { report } from "./smoke.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const worker = await unstable_dev(here("./worker.mjs"), {
  config: here("./wrangler.toml"),
  experimental: { disableExperimentalWarning: true },
});

let checks;
try {
  const res = await worker.fetch("/");
  const body = await res.json();
  checks = body.checks ?? [{ name: "worker returned checks", ok: false, error: "no checks in response" }];
} catch (err) {
  checks = [{ name: "worker boots + responds", ok: false, error: err?.message ?? String(err) }];
} finally {
  await worker.stop();
}

const ok = report("cloudflare workers (workerd, no nodejs_compat)", checks);
process.exit(ok ? 0 : 1);
