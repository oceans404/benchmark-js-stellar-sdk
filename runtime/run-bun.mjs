// Bun runner. Run with: bun run runtime/run-bun.mjs
import * as sdk from "sdk-candidate";
import { runSmoke, report } from "./smoke.mjs";

const checks = await runSmoke(sdk);
const version = typeof Bun !== "undefined" ? `bun ${Bun.version}` : "bun";
const ok = report(version, checks);
process.exit(ok ? 0 : 1);
