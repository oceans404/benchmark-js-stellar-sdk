// Node runner: imports v16 from node_modules and runs the shared smoke test.
import * as sdk from "sdk-v16";
import { runSmoke, report } from "./smoke.mjs";

const checks = await runSmoke(sdk);
const ok = report(`node ${process.version}`, checks);
process.exit(ok ? 0 : 1);
