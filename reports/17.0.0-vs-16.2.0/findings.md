# Findings: `17.0.0` vs `16.2.0`

Measured 2026-08-21, Node v24.13.0, macOS. The four generated reports in this folder carry the raw numbers; this is the read on them. Hand-written, so `npm run benchmark` will not overwrite it.

## Verdict

**17.0.0 is faster than 16.2.0 on every hot path it changes, and slower to load. Decode is the headline gain, cold start and bundle size are the cost, and both sides trace to the same per-type XDR redesign.**

Improvements

| Metric | 16.2.0 | 17.0.0 | Δ | Why it matters |
| --- | --- | --- | --- | --- |
| `ScInt` round trip | 1,061k ops/s | 1,573k ops/s | **+48%** ✅ | i128/i256 math |
| `fromXDR` | 262k ops/s | 341k ops/s | **+30%** ✅ | Every RPC response, Horizon response, and `fromXdr` call |
| `buffer` shim in bundles | all 4 scenarios | none | **removed** ✅ | 58 KB of a Node shim no longer ships to browsers |
| `hash` | 1,419k ops/s | 1,497k ops/s | +5% ✅ | At the noise edge. Do not quote alone |
| `nativeToScVal` | 819k ops/s | 861k ops/s | +5% ✅ | At the noise edge. Do not quote alone |

Regressions

| Metric | 16.2.0 | 17.0.0 | Δ | Why it matters |
| --- | --- | --- | --- | --- |
| Cold import, median | 46.5 ms | 143.1 ms | **+208%** ❌ | Serverless, edge, CLI startup |
| Time to first op, median | 56.2 ms | 154.2 ms | **+174%** ❌ | Same, measured end to end |
| Bundle gzip, full SDK | 119.3 KB | 178.3 KB | **+49.5%** ❌ | Browser apps on `import * as` |
| Bundle gzip, `/rpc` and `/contract` | 95.4 KB | 134.4 KB | **+41%** ❌ | Browser apps on subpath imports |
| Bundle gzip, classic Horizon | 84.6 KB | 102.9 KB | **+21.7%** ❌ | The mildest import surface |

Neither way

| Metric | 16.2.0 | 17.0.0 | Δ | |
| --- | --- | --- | --- | --- |
| build+sign+toXDR | 6.2k ops/s | 6.5k ops/s | +4% | ◻️ Wash |
| `loadAccount` on loopback | 12.9k ops/s | 13.4k ops/s | +4% | ◻️ Wash. Both default to `fetch` |
| verify | 2.2k ops/s | 2.2k ops/s | +3% | ◻️ Wash |
| keypair.random | 15.8k ops/s | 15.4k ops/s | -2% | ◻️ Wash |
| sign | 8.0k ops/s | 7.7k ops/s | -3% | ◻️ Wash. See the signing asterisk below |

`perf-report.md` flags nothing over its 5 percent regression threshold. Runtime compatibility is 5/5 (Node, Bun 1.3.9, Deno 2.8.2, simulated browser, Cloudflare Workers on `workerd` with `nodejs_compat` off), though the suite measures the candidate only, so that is a v17 result rather than a comparison.

Three reads on the tables:

- **Decode is faster despite losing native base64.** 17.0.0 ships its own portable base64 in `lib/esm/base/util/base64.js` rather than taking the obvious dependency. Next section.
- **Cold import and bundle size are the whole cost, and they are structural.** 624 bundle input files against 192, of which 459 are XDR type modules. No hot-path work touches this. Tracked in [#1605](https://github.com/stellar/js-stellar-sdk/issues/1605).
- **The `@stellar/js-xdr` dependency is settled.** 5.0.0 stable is published and 17.0.0 pins `^5.0.0`.

## Why decode is faster, and what it cost to get there

`fromXdr` takes base64, so base64 decoding gates the whole path before any XDR work begins. 16.2.0 decoded it with `Buffer.from(s, "base64")`. Dropping the `Buffer` dependency was a headline v17 goal, so 17.0.0 needed a portable replacement, and the obvious one is `uint8array-extras`, which the SDK already depends on for hex and byte comparison.

It did not take the obvious one. `lib/esm/xdr/values/xdr-value.js` line 1 imports only `areUint8ArraysEqual`, `uint8ArrayToHex`, and `hexToUint8Array` from `uint8array-extras`. Line 2 pulls `uint8ArrayToBase64` and `base64ToUint8Array` from a local `../../base/util/base64.js`, which is `atob` followed by a `charCodeAt` loop.

That choice is worth roughly 18x. Measured in one process on a 288-char `TransactionEnvelope`, all three producing byte-identical output:

| | ops/s | vs the dependency |
| --- | --- | --- |
| `Buffer.from(s, "base64")`, the call 16.2.0 used | 10,303k | 69x |
| 17.0.0 `base/util/base64.js` | 2,770k | **18.6x** |
| `uint8array-extras` `base64ToUint8Array` | 149k | baseline |

`uint8array-extras@1.5.0` decodes as `Uint8Array.from(atob(s), x => x.codePointAt(0))`, and `Uint8Array.from(str, mapFn)` walks the string through the iterator protocol with a per-character callback. That is the entire 18x.

Read the first row honestly. The portable path is still 3.7x slower than the native `Buffer` call 16.2.0 made, so v17 did give something up here. It comes out ahead anyway because the per-type redesign made raw-byte decoding about a third faster, which more than covers the base64 gap. Net is the +30% in the verdict table.

Two things came along with the local wrapper. `xdr.decodeBytes` now throws `XdrError: invalid base64 input` on malformed input rather than leaking a `DOMException`, which closes [#1642](https://github.com/stellar/js-stellar-sdk/issues/1642). And because `xdr.encodeBytes` and `xdr.decodeBytes` sit on top of these two functions, the path `docs/UINT8ARRAY_MIGRATION.md` steers migrating users onto is the fast one, which was the concern raised against merged PR [#1661](https://github.com/stellar/js-stellar-sdk/pull/1661).

The scope stayed narrow. `uint8ArrayToHex` is still about 5x slower than native and `hexToUint8Array` about 3x, both untouched, both off the hot path. Dropping the dependency outright would be the wrong call: the SDK imports 10 of its functions across roughly 81 files, it has zero transitive dependencies, and only base64 was pathological.

## The cost: cold import and bundle size

Cold import goes from 46.5 ms to 143.1 ms median, a 3.1x increase, with time to first op tracking it at 56.2 to 154.2 ms. Bundle growth is +49.5% gzip on the full SDK, +41% on `/rpc` and `/contract`, and +21.7% on a classic Horizon app. Bundling both versions from source under `platform: node` puts the full SDK at +61%, so the headline is not a packaging artifact.

The cause is visible in `meta/full.candidate.json`. The 17.0.0 bundle draws on 624 input files against 16.2.0's 192. Of those, 459 are XDR type modules totalling 1,038,459 raw bytes, and 16.2.0 contributes zero files under an `xdr/` path because it does not use a module-per-type layout. This is a design trade, not a defect, and the right place for it is release notes rather than a fix queue.

The `buffer` removal is real and does not offset it. `node_modules/buffer/index.js` accounts for 58,353 raw bytes in the 16.2.0 bundle and appears in none of the four 17.0.0 bundles. Against a megabyte of XDR modules it does not register.

Ignore the `+1195%` import p90 row in `perf-report.md`. It records 684.0 ms against a 143.1 ms median in the same run, which is a 4.8x spread that no other metric in the suite shows. It is a scheduling outlier, not a signal.

## `V17PerfIssues.md`, re-checked against 17.0.0

That document was written 2026-08-07 against a pre-release branch build. Two of its seven findings do not survive contact with the shipped package, and its headline number is one of them.

| # | Finding | Status against 17.0.0 |
| --- | --- | --- |
| 1 | `StrKey.isValid` throws on the common path | **Does not reproduce.** `isValidMed25519PublicKey(G…)` measures 36,791k ops/s, against the 630k that produced the "267x slower" headline |
| 2, 3, 5 | js-xdr allocates per scalar read, per union arm, per scalar write | Landed in `@stellar/js-xdr` 5.0.0, no measurable effect at the SDK boundary |
| 4 | Error path strings built eagerly | Open, and still unmeasured at the SDK boundary |
| 6 | base64 replaced by a pure JS codec | **Fixed.** See the section above. Its verdict, "an accepted trade with no fast path", was wrong |
| 7 | Class per XDR type | Open, design trade. Cold import +208%, bundles +21.7 to +49.5% |

Do not quote finding 1's "267x slower" against any released version.

Finding 4 deserves less attention than its 17 percent estimate suggests. It sits in the same js-xdr layer as findings 2, 3, and 5, and those landed a real code change that delivered nothing measurable to the SDK. `@stellar/js-xdr` PR [#150](https://github.com/stellar/js-xdr/pull/150) reports 5-6x faster decode on "a Stellar-shaped schema" while `TransactionEnvelope.schema._read` moves about 3 percent, and js-xdr is roughly 85 percent of SDK decode time, so a genuine 5-6x would be plainly visible. Two untested explanations: the bounds-check PRs merged after #150 ate the gains, or V8 escape analysis had already eliminated the short-lived allocations. Either way it belongs in `stellar/js-xdr`, and the lesson for finding 4 is to measure at the SDK boundary before investing.

## Still open

**`encodeArray` on a scalar type fails with an internal error.** `xdr.encodeArray(xdr.Uint32, [xdr.Uint32(1)])` throws `TypeError: v.toXdrObject is not a function`, naming neither the call nor the type. Scalar typedefs have no `.schema` and no `fromXdrObject`, but the release note says these work with "any XDR class". TypeScript rejects it, so this reaches plain JavaScript only. PR [#1658](https://github.com/stellar/js-stellar-sdk/pull/1658) is the template: add a `type.schema` guard in `src/xdr/values/xdr-value.ts` that throws naming the type. No issue filed.

**Byte helpers are not exported.** [#1611](https://github.com/stellar/js-stellar-sdk/issues/1611) asked for hex and base64 helpers under SDK names, and 17.0.0 exposes no top-level export matching `base64`, `hex`, `uint8`, or `bytes`. The ask is cheaper than it was, because the base64 pair is now SDK-owned code in `base/util/base64.js` rather than a re-export of a dependency.

**Cross-run drift in the suite.** [#1459](https://github.com/stellar/js-stellar-sdk/issues/1459) proposes a perf gate in CI, and it needs baseline-normalized deltas first. 16.2.0's own `hash` reads 1,311k on 2026-08-11 and 1,432k on 2026-08-18, the same package on the same suite, a 9 percent swing with no candidate involved. A gate built on raw cross-run deltas pages on machine noise. Each report folder's own candidate-versus-baseline numbers are sound, because both were measured in one run; the hazard is reading two folders side by side.

## What to say in release notes

Lead with decode. `fromXdr` is 30 percent faster than 16.2.0, `ScInt` round trips 48 percent faster, and the `buffer` shim is gone from every bundle. The four-runtime no-polyfill matrix (Bun, Deno, Cloudflare Workers, and a simulated browser) is a v17 capability claim worth making on its own.

State the cold-import and bundle costs plainly as the price of the per-type XDR redesign, and always scope bundle numbers to an import surface, because +21.7% on a classic Horizon app and +49.5% on `import * as` are different conversations. Do not quote `hash` or `nativeToScVal` at +5% without the noise band next to them.

Signing carries an asterisk that predates v17. 17.0.0 signs via pure-JS `@noble/ed25519`, and these numbers compare against 16.2.0's pure-JS path. A 16.2.0 install with the native `sodium-native` addon (`FastSigning`) is far faster than either, so against that configuration v17 is a regression.

## Caveats

- Single machine, single run for the generated tables. Treat anything under 5 percent as a wash. The base64 and `StrKey` numbers in this document were measured in one process with the package installed, which removes the cross-run problem but not the single-machine one.
- The base64 split was measured on one 288-char payload. base64's share of decode grows with payload size.
- Bundle and cold-import numbers depend entirely on import surface. Never quote them unscoped.
- The runtime matrix exercises crypto and XDR primitives only, not Horizon HTTP, RPC, or SSE streaming. "Browser" is `runtime/run-browser.mjs` deleting `globalThis.Buffer` from a Node process, not a real browser.
- `runtime-report.md` says the browser and Workers passes "rely on the bundler inlining a `buffer` shim". That is stale. The string is hardcoded at `runtime/run-browser.mjs:65` and prints on any pass, and no 17.0.0 bundle contains a `buffer` file. It was accurate for 16.2.0 and understates the 17.0.0 result.
