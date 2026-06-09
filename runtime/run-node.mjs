// Node runner: imports the candidate SDK and runs the shared smoke test.
import * as sdk from "sdk-candidate";
import { runSmoke, report } from "./smoke.mjs";

const checks = await runSmoke(sdk);
const ok = report(`node ${process.version}`, checks);
process.exit(ok ? 0 : 1);
