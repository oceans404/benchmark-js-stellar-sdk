// Deno runner. Run with: deno run --allow-read --allow-env runtime/run-deno.mjs
// Deno resolves the package directly from npm (not the local alias), so this is
// a clean-room check of whether v16 works under Deno's node-compat layer.
import * as sdk from "npm:@stellar/stellar-sdk@16.0.0-rc.1";
import { runSmoke, report } from "./smoke.mjs";

const checks = await runSmoke(sdk);
// @ts-ignore - Deno global only exists at runtime
const version = typeof Deno !== "undefined" ? `deno ${Deno.version.deno}` : "deno";
const ok = report(version, checks);
// @ts-ignore
Deno.exit(ok ? 0 : 1);
