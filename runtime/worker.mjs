// Cloudflare Workers (workerd) entry. This is the strictest edge runtime:
// no `Buffer` global, no Node built-ins unless nodejs_compat is enabled.
//
// Run locally with:  npx wrangler dev runtime/worker.mjs --config runtime/wrangler.toml
// then hit http://localhost:8787/ — the body is the smoke-test JSON.
//
// We intentionally do NOT set nodejs_compat in wrangler.toml, so if the SDK
// still relies on a Node `Buffer` global, this fails loudly and tells us the
// "runs on edge with no polyfill" claim isn't true yet.
import * as sdk from "sdk-candidate";
import { runSmoke } from "./smoke.mjs";

export default {
  async fetch() {
    const checks = await runSmoke(sdk);
    const ok = checks.every((c) => c.ok);
    return new Response(JSON.stringify({ runtime: "cloudflare-workers", ok, checks }, null, 2), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  },
};
