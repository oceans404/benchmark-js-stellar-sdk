# Stellar JS SDK v16: bundle size, runtime compatibility & performance tests

Independent, reproducible measurements of what developers gain by upgrading [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) to **v16** (currently [`16.0.0-rc.1`](https://github.com/stellar/js-stellar-sdk/releases/tag/v16.0.0-rc.1)), compared against the **v15.1.0** baseline.

## Why this exists

v16 ships **Protocol 27** support, so if you build on Stellar you'll need to move to it to stay current with the network. It's also a major modernization: `@stellar/stellar-base` is folded in, the build is ESM-first, native `fetch` replaces axios, and Node 22 is required. Full upgrade details are in the [v16 migration guide](https://stellar.github.io/js-stellar-sdk/guides/00-migration/).

Since the upgrade is happening anyway, the point of this repo is to **quantify the improvements you get** when you make the move, across three dimensions:

1. **Smaller bundles.** v16 is described as producing smaller, tree-shakeable bundles. This repo measures the real gzipped size against v15, for the way apps actually import the SDK.
2. **Broader runtime support.** v16 targets browsers, serverless, and the edge. This repo boots the SDK on Node, Bun, Deno, a simulated browser environment, and a bare Cloudflare Workers runtime and runs real operations.
3. **Speed.** This repo benchmarks cold-start and CPU hot paths against v15, each version in its own process, and reports regressions as plainly as wins.

Everything runs against the **published packages** and is meant to be re-run on your own machine, or adapted to your own app, so you don't have to take anyone's word for it.

## Reports (the source of truth)

The numbers live in these generated, committed reports. Each comparison gets its own folder, `reports/<candidate>-vs-<baseline>/`, so results from different version pairs are kept side by side. The current run:

| Report | Question | Bottom line |
| --- | --- | --- |
| [`bundle-report.md`](reports/16.0.0-rc.1-vs-15.1.0/bundle-report.md) | Smaller? | Yes, substantially. Tree-shaking helps but isn't surgical yet. |
| [`runtime-report.md`](reports/16.0.0-rc.1-vs-15.1.0/runtime-report.md) | Runs where I deploy? | Passes on Node, Bun, Deno, browser, and Cloudflare Workers. |
| [`perf-report.md`](reports/16.0.0-rc.1-vs-15.1.0/perf-report.md) | Faster? | Loads faster and most hot paths are faster; one keygen regression, plus a signing caveat. |
| [`network-report.md`](reports/16.0.0-rc.1-vs-15.1.0/network-report.md) | Transport: fetch vs axios? | The candidate's fetch client gets higher loopback throughput (largely connection reuse), but the network dominates in production. |

> These are for `16.0.0-rc.1` vs `15.1.0` on a single machine and are directional. Re-run on your own hardware (and on stable v16) to confirm.

## What gets measured

**Bundle size** — four import scenarios, bundled (minified, gzipped) for both versions, plus a check of which heavy/environment-specific deps (`eventsource`, `smol-toml`, `axios`, `feaxios`, `buffer`) survive tree-shaking:

| Scenario | Import |
| --- | --- |
| `full` | `import * as StellarSdk` |
| `rpc-only` | `import { Server } from '@stellar/stellar-sdk/rpc'` |
| `horizon-classic` | `Keypair, TransactionBuilder, Asset, Horizon` |
| `contract` | `import { Client } from '@stellar/stellar-sdk/contract'` |

**Runtime compatibility** — the same four operations on each runtime, with **no polyfills installed** so a missing global fails loudly: keypair sign/verify, StrKey round-trip, SHA-256 hash, and build + sign + `toXDR`. These are crypto + XDR primitives only (not Horizon/RPC/SSE), so a pass means the primitives work on that runtime, not that every feature does. The "browser" runner is Node with the `Buffer` global removed (a simulation), not a real browser.

**Performance** — cold import + time-to-first-op (fresh process per sample), and hot-path microbenchmarks (sign, verify, hash, keygen, build+sign+toXDR, fromXDR, `nativeToScVal`, `ScInt`) via `tinybench`, **each version in its own process** to avoid shared JIT/GC skew.

**Network transport** — the same `loadAccount` call against a local loopback server (fixed payload, no real network), across three configs: v15 (axios), v16 default (native `fetch`), and v16's axios opt-in (`@stellar/stellar-sdk/axios`). This isolates client overhead from wire latency.

> Import note: the `./rpc` and `./contract` subpaths export members directly (`import { Server } from '.../rpc'`); the `rpc`/`contract` namespaces are at the package root (`import { rpc } from '@stellar/stellar-sdk'`). Same in v15 and v16.

## Run it yourself

v16 requires Node 22+; the committed reports were generated on Node 24 and `.nvmrc` pins v24 so reproductions match. The two versions under comparison install side by side via npm aliases — `sdk-baseline` (compare-from) and `sdk-candidate` (under-test) — so one install gets both.

```bash
nvm use            # Node 24 (matches the reports; v16 requires 22+)
npm install        # both SDK versions + tooling

# all four write into reports/<candidate>-vs-<baseline>/
npm run benchmark  # bundle sizes
npm run smoke      # runtime checks
npm run perf       # baseline-vs-candidate speed
npm run net        # transport: fetch vs axios

npm run size       # optional: assert candidate bundles against .size-limit.json budgets
```

### Changing the versions under test

The versions are configured in **`versions.json`** (the source of truth):

```json
{ "baseline": "15.1.0", "candidate": "16.0.0-rc.1" }
```

`baseline` is what you compare from, `candidate` is what's under test. A bare version means `@stellar/stellar-sdk@<version>`; a full spec (or a fork) works too. The `package.json` aliases and all report labels are generated from this, so it's the only thing you edit.

**Permanent change** (updates `versions.json` + aliases):

```bash
npm run set-versions 15.1.0 16.0.0-rc.2
npm install
npm run benchmark && npm run smoke && npm run perf && npm run net
```

**Temporary override** (leaves `versions.json` unchanged, e.g. for CI):

```bash
SDK_CANDIDATE=16.0.0-rc.2 npm run sync-versions
npm install
```

This leaves `versions.json` untouched but does rewrite `package.json` (and the lockfile on install), so the working tree will be dirty. That's expected for a throwaway/CI run; don't commit it. Use `npm install` (not `npm ci`) after a sync, since the lockfile won't match until the install runs.

Either way, report headers and tables pick up the new version strings automatically (read from the installed packages). So when a new v16 build lands, it's a one-line config change.

`smoke` covers Node and a simulated browser environment out of the box. The other runtimes are optional and skipped if absent; install them to fill in the matrix:

```bash
curl -fsSL https://bun.sh/install | bash        # Bun
curl -fsSL https://deno.land/install.sh | sh    # Deno
npm install -D wrangler                         # Cloudflare Workers (workerd)
```

**Testing your own app?** Point a fixture at your real entry imports, or just `npm install @stellar/stellar-sdk@16.0.0-rc.1` in your project and run your own build + tests.

## What this doesn't cover (yet)

- **Zero-polyfill edge.** The browser and Workers passes work via a bundled `buffer` shim. They run, but that's not yet "no polyfills." See the runtime report's caveats.
- **Real-browser + full-feature edge coverage.** The "browser" row is simulated (Node minus `Buffer`), and the checks cover crypto+XDR primitives, not Horizon/RPC/SSE. A headless-browser (Playwright) run and HTTP/streaming checks on edge would be stronger.
- **Controlled-lab speed numbers.** Results are single-machine, single-run, and directional. Treat differences under ±5% as a wash.
- **The Node 22 floor.** v16 requires Node 22+; the test machine runs Node 24, so the `EBADENGINE` failure on older Node isn't exercised here.

## Layout

```
versions.json     the two SDK versions under comparison (source of truth)
lib/versions.mjs  resolves the baseline/candidate slots + report folder
fixtures/         bundle-size entry files, one per scenario per version
scripts/          analyze.mjs (bundle benchmark) + set/sync-versions helpers
runtime/          smoke.mjs (the operations) + per-runtime runners + run-all.mjs
perf/             micro/cold-import/run-perf (speed) + net-bench/run-net (transport)
reports/          <candidate>-vs-<baseline>/*.md (committed); meta/ (ignored)
.size-limit.json  bundle-size budgets for `npm run size`
```

## References

- [`@stellar/stellar-sdk` on GitHub](https://github.com/stellar/js-stellar-sdk) — the SDK these tests measure
- [v16.0.0-rc.1 release notes](https://github.com/stellar/js-stellar-sdk/releases/tag/v16.0.0-rc.1) — the release under test
- [v16 migration guide](https://stellar.github.io/js-stellar-sdk/guides/00-migration/) — the upgrade reference these scenarios are based on

Licensed under [Apache-2.0](LICENSE).
