# Findings: `17.0.0` vs `17.0.0-rc.2`

Measured 2026-08-21, Node v24.13.0, macOS. The four generated reports in this folder carry the raw numbers; this is the read on them. Hand-written, so `npm run benchmark` will not overwrite it.

## Verdict

**One performance change shipped between rc.2 and stable, and it is worth 3.4x on `fromXdr`. Everything else the suite measures is unchanged within noise.**

Improvements

| Metric | 17.0.0-rc.2 | 17.0.0 | Δ | Why it matters |
| --- | --- | --- | --- | --- |
| `fromXDR` | 99.0k ops/s | 339.2k ops/s | **+243%** ✅ | Every RPC response, Horizon response, and `fromXdr` call |
| keypair.random | 14.9k ops/s | 15.6k ops/s | +5% ✅ | At the noise edge. Do not quote alone |

Unchanged

| Metric | 17.0.0-rc.2 | 17.0.0 | Δ | |
| --- | --- | --- | --- | --- |
| Bundle gzip, all four scenarios | 102.7 to 178.1 KB | 102.9 to 178.3 KB | +0.1 to +0.2% | ◻️ One new file |
| Cold import, median | 138.6 ms | 140.0 ms | +1% | ◻️ Wash |
| Time to first op, median | 149.1 ms | 151.7 ms | +2% | ◻️ Wash |
| `nativeToScVal` | 853.1k ops/s | 867.5k ops/s | +2% | ◻️ Wash |
| `ScInt` round trip | 1,588k ops/s | 1,550k ops/s | -2% | ◻️ Wash |
| hash | 1,445k ops/s | 1,453k ops/s | +1% | ◻️ Wash |
| sign, verify | 7.6k, 2.1k ops/s | 7.7k, 2.1k ops/s | +1%, -2% | ◻️ Wash |
| `loadAccount` on loopback | 13.1k ops/s | 12.5k ops/s | -4% | ◻️ Wash. Both default to `fetch` |
| Runtime matrix | 5/5 pass | 5/5 pass | none | ◻️ Node, Bun, Deno, simulated browser, Workers |

**No real regression.** `perf-report.md` flags `build+sign+toXDR` at -6%, and it does not survive scrutiny: the candidate error bar is ±3.2%, and the same operation in the same session reads +4% against 16.2.0. Nothing in the release touches transaction building. Treat it as run noise, not a regression.

## What actually changed: 31 files, three kinds of change

Diffing the two packed `lib/esm` trees gives an exact answer rather than an inferred one. One file is new (`base/util/base64.js`), one dependency pin moved (`@stellar/js-xdr` from `^5.0.0-rc.2` to `^5.0.0`, now that 5.0.0 stable is published), and 29 files changed content. No public API surface moved: `Operation` and `xdr` export exactly the same names in both.

**1. The base64 fast path.** This is the only change that affects any benchmark. It is systemic rather than local, touching `xdr/values/xdr-value.js`, `xdr/values/bytes-value.js`, `base/transaction.js`, `base/transaction_base.js`, `contract/client.js`, and `webauth/challenge_transaction.js`. Each drops `uint8ArrayToBase64` and `base64ToUint8Array` from its `uint8array-extras` import and picks them up from the new local module instead. Next section.

**2. The error contract.** `xdr/values/xdr-string.js` replaces four `SyntaxError` throws with `XdrError`, and `xdr-value.js` wraps hex and base64 decoding in a try/catch that rethrows as `XdrError: invalid <format> input`. Confirmed at runtime: `xdr.decodeBytes("!!!not base64!!!", "base64")` throws `XdrError` in 17.0.0 where rc.2 leaks a `DOMException`. This closes [#1642](https://github.com/stellar/js-stellar-sdk/issues/1642). The suite does not benchmark error paths, so none of this shows up in the tables.

**3. One new feature.** `Operation.createCustomContract` gained an `externalRef` option in `base/operations/invoke_host_function.js`, with matching wiring in `contract/client.js`. It accepts either a `ContractExecutableExternalRef` or a plain `{owner, tag}`, rejects passing both `wasmHash` and `externalRef`, and requires the owner to be a contract address. The `ContractExecutableExternalRef` XDR type already existed in rc.2, so this is wiring an existing type into the operation builder rather than a protocol addition. **This suite does not exercise it at all.** A functional release note reviewer should not read a green benchmark run as coverage of this change.

The remaining diffs are the version string in `rpc/axios.js` and `horizon/horizon_axios_client.js`, and `.d.ts` files tracking the above.

## The base64 swap, measured

rc.2 called `uint8array-extras@1.5.0`, which decodes as `Uint8Array.from(atob(s), x => x.codePointAt(0))`. `Uint8Array.from(str, mapFn)` walks the string through the iterator protocol with a per-character callback. 17.0.0 replaces it with `atob` followed by a `charCodeAt` loop in `lib/esm/base/util/base64.js`.

Measured in one process with both versions installed, 288-char `TransactionEnvelope`, byte-identical output from every row:

| | ops/s | ratio |
| --- | --- | --- |
| base64 decode, `uint8array-extras` (rc.2's call) | 149k | baseline |
| base64 decode, 17.0.0 `base/util/base64.js` | 2,770k | **18.6x** |
| `TransactionBuilder.fromXdr`, rc.2 | 101.9k | baseline |
| `TransactionBuilder.fromXdr`, 17.0.0 | 349.1k | **3.4x** |

Same-process numbers, so this is independent of the cross-run drift that makes report folders unsafe to read side by side. The generated `perf-report.md` in this folder agrees at 99.0k and 339.2k.

The scope stayed narrow, which is the right call. `uint8ArrayToHex` and `hexToUint8Array` still come from the dependency and are still several times slower than native, but they are off the hot path. The dependency has zero transitive dependencies and supplies 10 functions across roughly 81 files; only base64 was pathological.

## Bundle cost of the change: 0.2 percent

The new module adds 0.2 KB gzip to the full SDK (178.1 to 178.3), 0.2 KB to a classic Horizon app, and 0.1 to 0.2 KB to `/rpc` and `/contract`. An 18.6x decode win for two tenths of a percent is the cheapest trade in the release.

The tree-shaking picture is identical between the two: `eventsource` and `smol-toml` drop out of the narrow imports, `buffer` is absent everywhere, and `feaxios` still rides along in all four bundles. That last one is unchanged and still worth fixing.

## Not fixed in this release

**`encodeArray` on a scalar type still fails with an internal error.** `xdr.encodeArray(xdr.Uint32, [xdr.Uint32(1)])` throws `TypeError: v.toXdrObject is not a function` in both rc.2 and 17.0.0, naming neither the call nor the type. Scalar typedefs have no `.schema` and no `fromXdrObject`, but the release note says these work with "any XDR class". TypeScript rejects it, so this reaches plain JavaScript only. Notable because the release did do error-contract work elsewhere, so this one was in scope and got missed. PR [#1658](https://github.com/stellar/js-stellar-sdk/pull/1658) is the template: a `type.schema` guard in `src/xdr/values/xdr-value.ts` that throws naming the type. No issue filed.

**Cold import and bundle size are untouched**, as expected. Both trace to the per-type XDR redesign, not to anything in this diff. Tracked in [#1605](https://github.com/stellar/js-stellar-sdk/issues/1605).

**Byte helpers are still not exported.** [#1611](https://github.com/stellar/js-stellar-sdk/issues/1611) asked for hex and base64 helpers under SDK names, and 17.0.0 exposes no top-level export matching `base64`, `hex`, `uint8`, or `bytes`. The ask is cheaper now that the base64 pair is SDK-owned code rather than a dependency re-export.

## Caveats

- Single machine, single run for the generated tables. Treat anything under 5 percent as a wash. The base64 and `fromXdr` numbers above were measured in one process with both versions installed, which removes the cross-run problem but not the single-machine one.
- The base64 split was measured on one 288-char payload. base64's share of decode grows with payload size, so larger envelopes gain more.
- The suite covers bundle size, cold import, eight hot paths, loopback transport, and four crypto/XDR primitives on five runtimes. It does not cover the `externalRef` feature or the error-contract change, which are two of the three substantive changes in this release.
- File-level diffs were taken against the installed packages in `node_modules/sdk-baseline` (17.0.0-rc.2) and `node_modules/sdk-candidate` (17.0.0), not against repository tags.
