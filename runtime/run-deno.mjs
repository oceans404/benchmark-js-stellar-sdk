// Deno runner. Run with: deno run --allow-read --allow-env --allow-net runtime/run-deno.mjs
// Resolves the candidate package directly from npm (not the local alias), so
// this is a clean-room check under Deno's node-compat layer. The version is read
// from the installed `sdk-candidate` alias, so it tracks package.json.
import { resolvedVersion } from "../lib/versions.mjs";
import { runSmoke, report } from "./smoke.mjs";

const candidate = resolvedVersion("candidate");
const S = await import(`npm:@stellar/stellar-sdk@${candidate}`);

const checks = await runSmoke(S);
// @ts-ignore - Deno global only exists at runtime
const version = typeof Deno !== "undefined" ? `deno ${Deno.version.deno}` : "deno";
const ok = report(version, checks);
// @ts-ignore
Deno.exit(ok ? 0 : 1);
