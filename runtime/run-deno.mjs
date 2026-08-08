// Deno runner. Run with: deno run --allow-read --allow-env --allow-net runtime/run-deno.mjs
// Resolves the candidate package directly from npm (not the local alias), so
// this is a clean-room check under Deno's node-compat layer. The version is read
// from the installed `sdk-candidate` alias, so it tracks package.json.
import { resolvedVersion } from "../lib/versions.mjs";
import { runSmoke, report } from "./smoke.mjs";

const candidate = resolvedVersion("candidate");

// Prefer the clean-room registry resolution. An unpublished candidate (a local
// build or tarball, e.g. an RC off a feature branch) has no npm entry, so fall
// back to the installed `sdk-candidate` alias — still Deno's node-compat layer,
// just resolved from node_modules instead of the registry.
let S;
let source = "npm registry";
try {
  S = await import(`npm:@stellar/stellar-sdk@${candidate}`);
} catch (err) {
  // Only a *resolution* failure justifies the fallback. Anything else (the
  // package loading and then throwing under Deno) is a real finding and must
  // stay a failure rather than be papered over by a second import.
  const msg = err?.message ?? String(err);
  if (!/could not find|not found|no matching|404|failed to (?:fetch|load)/i.test(msg)) throw err;
  S = await import("sdk-candidate");
  source = "local node_modules (candidate not published to npm)";
}
console.log(`[deno] resolved candidate ${candidate} from ${source}`);

const checks = await runSmoke(S);
// @ts-ignore - Deno global only exists at runtime
const version = typeof Deno !== "undefined" ? `deno ${Deno.version.deno}` : "deno";
const ok = report(version, checks);
// @ts-ignore
Deno.exit(ok ? 0 : 1);
