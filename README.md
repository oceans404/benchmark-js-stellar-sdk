# Stellar JS SDK benchmarks: bundle size, runtime compatibility & performance

Independent, reproducible measurements of [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) across two versions at a time. You configure a **baseline** (what you compare from) and a **candidate** (what is under test), and the suite reports bundle size, runtime compatibility, speed, and network transport for that pair.

Everything runs against real installed packages, published or locally built, and is meant to be re-run on your own machine or adapted to your own app.

**Currently configured pair: `17.0.0-rc.2` vs `16.2.0`.** Both are published to npm, so no local build is needed (`17.0.0-rc.2` is on the `rc` dist-tag; `npm i @stellar/stellar-sdk@17` still 404s because npm excludes prereleases from ranges). For an unpublished build, see [Testing an unpublished build](#testing-an-unpublished-build).

## Reports (the source of truth)

The numbers live in generated, committed reports. Each comparison gets its own folder, `reports/<candidate>-vs-<baseline>/`, so results from different pairs sit side by side.

| Report | Question | Bottom line for 17.0.0-rc.2 vs 16.2.0 |
| --- | --- | --- |
| [`bundle-report.md`](reports/17.0.0-rc.2-vs-16.2.0/bundle-report.md) | Smaller? | No. 22 to 49 percent larger gzipped, and ~3 KB larger than rc.1. The `buffer` shim is gone from every bundle. |
| [`runtime-report.md`](reports/17.0.0-rc.2-vs-16.2.0/runtime-report.md) | Runs where I deploy? | Yes. Passes on Node, Bun, Deno, simulated browser, and Cloudflare Workers. |
| [`perf-report.md`](reports/17.0.0-rc.2-vs-16.2.0/perf-report.md) | Faster? | Mixed. `ScInt` +50 percent, but `fromXDR` -57 percent and cold import +173 percent. **Unchanged from rc.1** once machine drift is removed, see `findings.md`. |
| [`network-report.md`](reports/17.0.0-rc.2-vs-16.2.0/network-report.md) | Transport cost? | A wash. Both default to `fetch`; the axios opt-in is 17 percent slower. |
| [`findings.md`](reports/17.0.0-rc.2-vs-16.2.0/findings.md) | **Is v17 faster or slower?** | Slower where it counts. Decoding XDR from base64 is 5x slower, and that one dependency function is nearly the whole story: raw-byte decoding is 33 percent *faster*. Plus the bug list and a map to existing issues. |

[**`V17PerfIssues.md`**](V17PerfIssues.md) is the follow-up investigation into the v17 regressions, with a correction header for what has since landed. Findings 2, 3 and 5 shipped in `@stellar/js-xdr@5.0.0-rc.2` but moved nothing at the SDK boundary; finding 1 turned out to be fixed before rc.1 published and should not be quoted against a released version. **Finding 6, the pure-JS base64 codec, is now the entire `fromXDR` regression**, and it is a five-line portable fix rather than the accepted trade it was originally called.

> Single machine, single run. Directional, not a controlled lab result. Treat differences under 5 percent as a wash.

Earlier pairs remain committed under `reports/`, for example [`16.0.0-rc.1-vs-15.1.0`](reports/16.0.0-rc.1-vs-15.1.0/).

## What gets measured

**Bundle size.** Four import scenarios, bundled with esbuild (minified, gzipped) for both versions, plus a check of which heavy or environment-specific dependencies (`eventsource`, `smol-toml`, `axios`, `feaxios`, `buffer`) survive tree-shaking.

| Scenario | Import |
| --- | --- |
| `full` | `import * as StellarSdk` |
| `rpc-only` | `import { Server } from '@stellar/stellar-sdk/rpc'` |
| `horizon-classic` | `Keypair, TransactionBuilder, Asset, Horizon` |
| `contract` | `import { Client } from '@stellar/stellar-sdk/contract'` |

**Runtime compatibility.** The same four operations on each runtime with **no polyfills installed**, so a missing global fails loudly: keypair sign and verify, StrKey round-trip, SHA-256, and build, sign, serialize to XDR. These are crypto and XDR primitives only, not Horizon, RPC, or SSE. A pass means the primitives work on that runtime, not that every feature does.

**Performance.** Cold import and time-to-first-op (fresh process per sample), plus hot-path microbenchmarks (sign, verify, hash, keygen, build+sign+toXDR, fromXDR, `nativeToScVal`, `ScInt`) via `tinybench`, **each version in its own process** to avoid shared JIT and GC skew.

**Network transport.** The same `loadAccount` call against a local loopback server (fixed payload, no real network) across three configs: the baseline's default client, the candidate's default client, and the candidate's axios opt-in (`@stellar/stellar-sdk/axios`). This isolates client overhead from wire latency.

> Import note: the `./rpc` and `./contract` subpaths export members directly (`import { Server } from '.../rpc'`); the `rpc` and `contract` namespaces are at the package root (`import { rpc } from '@stellar/stellar-sdk'`).

## Run it yourself

Node 22+ is required; the committed reports were generated on Node 24 and `.nvmrc` pins v24 so reproductions match. The two versions install side by side via npm aliases, `sdk-baseline` and `sdk-candidate`, so one install gets both.

```bash
nvm use            # Node 24
npm install        # both SDK versions + tooling

# all four write into reports/<candidate>-vs-<baseline>/
npm run benchmark  # bundle sizes
npm run smoke      # runtime checks
npm run perf       # baseline-vs-candidate speed
npm run net        # transport comparison

npm run size       # optional: print candidate bundle sizes (see below)
```

`smoke` covers Node and a simulated browser out of the box. The others are optional and skipped if absent:

```bash
curl -fsSL https://bun.sh/install | bash        # Bun
curl -fsSL https://deno.land/install.sh | sh    # Deno
npm install -D wrangler                         # Cloudflare Workers (workerd)
```

### `npm run size`

This prints the candidate's gzipped bundle size per scenario. It does **not** assert anything today, because `.size-limit.json` sets no `limit` values. Budgets are deliberately left unset: they are specific to one candidate version, and this repo's candidate is configurable, so a pinned budget would fail the moment you switch pairs. To gate a specific version in CI, add a `limit` to each entry.

## Changing the versions under test

The pair is configured in **`versions.json`**, the source of truth:

```json
{ "baseline": "16.2.0", "candidate": "17.0.0-rc.2" }
```

A bare version means `@stellar/stellar-sdk@<version>`. A full spec, a fork, or a `file:` path also works. The `package.json` aliases and all report labels are generated from this, so it is the only thing you edit.

**Permanent change** (updates `versions.json` and the aliases):

```bash
npm run set-versions 16.2.0 17.0.0-rc.2
npm install
npm run benchmark && npm run smoke && npm run perf && npm run net
```

**Temporary override** (leaves `versions.json` unchanged, for CI or a one-off):

```bash
SDK_CANDIDATE=17.0.0-rc.2 npm run sync-versions
npm install
```

The override still rewrites `package.json` and the lockfile on install, so the working tree goes dirty. That is expected for a throwaway run. Do not commit it. Use `npm install`, not `npm ci`, after a sync.

Either way, report headers and tables pick up the new version strings automatically, read from whatever is actually installed.

### Testing an unpublished build

To benchmark a release candidate or a feature branch that is not on npm, pack it and point the candidate at the tarball:

```bash
# in your js-stellar-sdk clone, on the branch you want to test
pnpm install                       # its `prepare` script runs the production build
pnpm pack

# back in this repo
mkdir -p .local-sdk && cp /path/to/stellar-stellar-sdk-<version>.tgz .local-sdk/
SDK_BASELINE=16.2.0 SDK_CANDIDATE=file:./.local-sdk/stellar-stellar-sdk-<version>.tgz npm run sync-versions
npm install
```

`.local-sdk/` is gitignored. Keep the tarball inside the repo rather than in a temp directory, otherwise the next `npm install` breaks when that directory is cleaned.

One consequence: the Deno runner normally resolves the candidate from the npm registry as a clean-room check. An unpublished candidate has no registry entry, so it falls back to the local install and says so in its output. The fallback triggers only on a resolution failure, so a genuine Deno load failure still fails.

**Testing your own app?** Point a fixture at your real entry imports, or just install the candidate in your project and run your own build and tests.

## What this doesn't cover

- **Real-browser and full-feature edge coverage.** The browser row is simulated (Node with the `Buffer` global removed) and the checks cover crypto and XDR primitives, not Horizon, RPC, or SSE. A headless-browser run and HTTP streaming checks on edge would be stronger.
- **Controlled-lab speed numbers.** Single machine, single run, directional.
- **Old Node.** The test machine runs Node 24, so the `EBADENGINE` failure below Node 22 is not exercised.
- **Real network conditions.** The transport benchmark is loopback only, which removes exactly the latency that dominates production.

## Layout

```
versions.json      the two SDK versions under comparison (source of truth)
lib/versions.mjs   resolves the baseline/candidate slots + report folder
fixtures/          bundle-size entry files, one per scenario per version
scripts/           analyze.mjs (bundle benchmark) + set/sync-versions helpers
runtime/           smoke.mjs (the operations) + per-runtime runners + run-all.mjs
perf/              micro/cold-import/run-perf (speed) + net-bench/run-net (transport)
reports/           <candidate>-vs-<baseline>/*.md (committed); meta/ (ignored)
.local-sdk/        locally built SDK tarballs (ignored)
.size-limit.json   size-limit config for `npm run size`
V17PerfIssues.md   investigation into the v17.0.0-rc.1 regressions
```

## References

- [`@stellar/stellar-sdk` on GitHub](https://github.com/stellar/js-stellar-sdk), the SDK these tests measure
- [`@stellar/js-xdr`](https://github.com/stellar/js-xdr), the XDR layer, rewritten for v17
- [v16 migration guide](https://stellar.github.io/js-stellar-sdk/guides/00-migration/)

Licensed under [Apache-2.0](LICENSE).
