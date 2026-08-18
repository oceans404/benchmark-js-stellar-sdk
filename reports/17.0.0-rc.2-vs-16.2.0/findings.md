# Findings: `17.0.0-rc.2` vs `16.2.0`

Measured 2026-08-18, Node v24.13.0, macOS. The four generated reports in this folder carry the raw numbers; this is the read on them. Hand-written, so `npm run benchmark` will not overwrite it.

## Verdict

**v17 is slower on the path almost everyone uses, and one dependency function is nearly the whole story.**

| | Δ vs 16.2.0 | Why it matters |
| --- | --- | --- |
| **Decode XDR from base64** | **-81%** (595k → 114k ops/s) | Every RPC response, Horizon response, and `fromXdr` call |
| Cold import | **-173%** (49 → 134 ms) | Serverless, edge, CLI startup |
| Bundle, gzipped | **+22 to +49%** | Browser apps. Varies by import surface |
| Encode XDR to bytes | -20% (715k → 576k) | Every `toXdr()` on the submit path |
| sign / verify / keypair / hash | -3% to +4% | A wash |
| **Decode XDR from raw bytes** | **+33%** (626k → 832k) | Faster, but few callers hold raw bytes |
| `nativeToScVal`, `build+sign+toXDR` | +6 to +7% | Contract args, transaction building |
| **`ScInt` round trip** | **+50%** | i128/i256 math |

Runtime compatibility is unchanged, 5/5 pass (Node, Bun, Deno, simulated browser, Cloudflare Workers), and the `buffer` shim is gone from every bundle.

Three reads on the table:

- **The XDR redesign is not the problem.** Raw-byte decoding got 33 percent *faster*. base64 decoding is 5x slower, and base64 is 86 percent of the time on that path. Fix that one function and `fromXdr` beats v16. Next section.
- **Cold import and bundle size are the real cost of the redesign.** Structural, not bugs, and unchanged since rc.1. Tracked in [#1605](https://github.com/stellar/js-stellar-sdk/issues/1605).
- **rc.2 is a correctness release: five real fixes, no performance change.** Every v17 number above has been true since rc.1. The rc.2 gains the generated tables show are cross-run machine drift, covered below.

## Fix before GA: base64 decoding is 85x slower than native, and it is one line

High impact on perf, no correctness impact. Upstream, not a Stellar bug.

`atob` is not the problem, running at 17,650k ops/s. `uint8array-extras@1.5.0` decodes as:

```js
return Uint8Array.from(globalThis.atob(base64UrlToBase64(base64String)), x => x.codePointAt(0));
```

`Uint8Array.from(str, mapFn)` walks the string through the iterator protocol with a per-character callback. On a 288-char payload it manages **149k ops/s**, against **12,371k** for `Buffer.from(s, "base64")` and **3,223k** for the same `atob` followed by a `charCodeAt` loop. All three produce byte-identical output.

So the fast path is portable and it is five lines. A `charCodeAt` loop needs no `Buffer`, runs in browsers, Node, Bun, Deno and workerd, and keeps the no-`Buffer` property that motivated the migration. `Uint8Array.fromBase64` would be cleanest but is not in Node 24.13, so it cannot be the only path. Encode has the same shape (`btoa(String.fromCodePoint.apply(...))`), 17x slower than native.

This corrects `V17PerfIssues.md` finding 6, which called it "an accepted trade with no fast path."

**Fix:** wrap the two base64 functions locally instead of calling `uint8array-extras` directly, with `Buffer` where present and `atob`/`btoa` plus a manual loop otherwise. Worth filing upstream at [`sindresorhus/uint8array-extras`](https://github.com/sindresorhus/uint8array-extras) too, but the SDK should not wait on that.

**Two open issues already propose that exact wrapper**, both for other reasons, so this is a scope addition rather than new work. [#1642](https://github.com/stellar/js-stellar-sdk/issues/1642) wants the decoders wrapped so malformed input throws `XdrError` instead of a `DOMException`, and [#1611](https://github.com/stellar/js-stellar-sdk/issues/1611) wants hex and base64 helpers exported under SDK names. Landing either one is the moment to put the fast path behind it. Doing all three separately means touching `src/xdr/values/xdr-value.ts` three times.

**Scope it to those two functions, do not drop the dependency.** The SDK imports 10 of its functions across 81 files and ~173 call sites, and only base64 is pathological: `uint8ArrayToHex` is 5x slower than native, `hexToUint8Array` 3x, and `stringToUint8Array` matches `TextEncoder` exactly. Zero transitive deps, and a direct portable replacement for every `Buffer` method the Uint8Array migration removed.

**This got worse, not better.** Merged PR [#1661](https://github.com/stellar/js-stellar-sdk/pull/1661) repointed `docs/UINT8ARRAY_MIGRATION.md` at `xdr.encodeBytes` / `xdr.decodeBytes`, thin wrappers over these functions, so the guide now steers every migrating user onto a path 67x slower than the `Buffer` call it replaces.

## What to file and comment

Checked 2026-08-18.

| Finding | Issue | Action |
| --- | --- | --- |
| base64 wrapper | **[#1611](https://github.com/stellar/js-stellar-sdk/issues/1611)** (open, Q3) *Export byte encoding helpers* | Comment. It proposes re-exporting `uint8array-extras` under SDK names as "re-export work, not new implementation". Wrong call at 85x |
| base64 wrapper | **[#1642](https://github.com/stellar/js-stellar-sdk/issues/1642)** (open, v17.0.0) *Malformed base64 and hex decode errors escape `XdrError`* | Comment. Already proposes wrapping the same two decoders, for error-contract reasons. One change, not two |
| base64, as a perf issue | **none found** | **File it.** Neither [#1611](https://github.com/stellar/js-stellar-sdk/issues/1611) nor [#1642](https://github.com/stellar/js-stellar-sdk/issues/1642) mentions performance |
| `encodeArray` scalar guard | **none found** | **File it** |
| Cross-run drift in reports | **[#1459](https://github.com/stellar/js-stellar-sdk/issues/1459)** (open) *Wire the benchmark suite into CI* | Comment. Baseline-normalized deltas are a prerequisite, or CI pages on machine noise |
| js-xdr [#150](https://github.com/stellar/js-xdr/pull/150) does not reproduce | **none found** | **File it in `js-xdr`** |
| Cold import, bundle | **[#1605](https://github.com/stellar/js-stellar-sdk/issues/1605)** (open) *Tree-shakeable XDR access* | Covered. No action |

**Release gate:** `@stellar/js-xdr` v5.0.0 stable is still unpublished. npm `latest` is `4.0.0`; only the two RCs exist. rc.2 moved the SDK's pin from `^5.0.0-rc.1` to `^5.0.0-rc.2`, so the one item gating stable v17 moved sideways rather than closing. Protocol 28 testnet vote is 2026-08-21.

`V17PerfIssues.md` findings 1 through 7 were shared in Slack on 2026-08-07 and never became issues in either repo. Findings 2, 3 and 5 were fixed anyway by js-xdr PR [#150](https://github.com/stellar/js-xdr/pull/150); findings 4 and 6 remain untracked. That document also needs a correction: its headline "267x slower" for `StrKey.isValid` came from branch build `f7357043` and was already fixed by the time rc.1 published (69,747k ops/s).

## rc.2 vs rc.1: no performance change, and the cross-run drift that hid it

The apparent rc.2 gains in the generated tables (`build+sign+toXDR` -6% → +6%, `fromXDR` -70% → -57%) are cross-run drift. The rc.1 suite ran 2026-08-11 and the rc.2 suite ran today on a faster machine. Installing both and measuring in one session, three trials, 216-byte `TransactionEnvelope`:

| | 16.2.0 | rc.1 | rc.2 |
| --- | --- | --- | --- |
| decode from raw bytes | 620-632k | 833-870k | 797-842k |
| decode from base64 | 588-601k | 122-124k | 121-122k |
| encode to raw bytes | 700-731k | 569-575k | 564-588k |

This is a suite process problem, and the reason the first read of this release was wrong. Each folder's candidate-vs-baseline deltas are sound, because both were measured in one run. The failure mode is reading rc.1's folder next to rc.2's and treating the difference as a release delta. The tell is that the baseline moves too: 16.2.0's `hash` read 1,311k on 2026-08-11 and 1,433k today, same package, a 9 percent swing with no candidate involved.

**Fix:** normalize deltas against the baseline measured in the same run, which the suite already collects, and stamp the header with the baseline's own drift since the previous run. To compare two candidates, install both and measure in one process. This belongs in [#1459](https://github.com/stellar/js-stellar-sdk/issues/1459), which proposes a perf-regression gate in CI: without normalization that gate pages on machine noise.

## Minor: `encodeArray` on a scalar type fails with an internal error

Low. Plain JavaScript only, TypeScript already rejects it.

rc.2's new `xdr.encodeArray` / `xdr.decodeArray` work correctly for XDR classes: round-trip is byte-identical and `maxLength` throws `XdrError: array: array length 1 exceeds maximum 0`. But the release note says they work with "any XDR class", and scalar typedefs are not classes. `xdr.Uint32` and `xdr.Int64` have no `.schema` and no `fromXdrObject`:

```js
xdr.encodeArray(xdr.Uint32, [xdr.Uint32(1), xdr.Uint32(2)]);
// TypeError: v.toXdrObject is not a function
//   at Module.encodeArray (xdr-value.js:73)
```

Same shape as [#1640](https://github.com/stellar/js-stellar-sdk/issues/1640), which rc.2 just fixed: the `.d.ts` rejects it, the runtime does not, so the error reaches plain JS and TypeScript run without a type-check pass, naming neither the call nor the type.

**The fix already has a template in the tree.** [#1640](https://github.com/stellar/js-stellar-sdk/issues/1640) was closed by PR [#1658](https://github.com/stellar/js-stellar-sdk/pull/1658), which gave all 115 generated union bases a constructor that throws naming the arm factory to call. Applying the same shape here means a `type.schema` guard in `encodeArray` / `decodeArray` that throws naming the type, in `src/xdr/values/xdr-value.ts`.

## Open question: js-xdr PR [#150](https://github.com/stellar/js-xdr/pull/150)'s speedup does not reproduce

PR [#150](https://github.com/stellar/js-xdr/pull/150) removed js-xdr's per-scalar and per-union-arm allocations and reports 5-6x faster decode on "a Stellar-shaped schema." Against the SDK's actual `TransactionEnvelope` schema it is a wash: `schema._read` measures 1,018k ops/s on js-xdr 5.0.0-rc.1 and 1,047k on rc.2.

The code change is real, verified by diffing the packed tarballs. And SDK code above js-xdr is not swamping the win: **js-xdr is 85 percent of SDK decode time**, 0.97 of 1.14 µs, so a genuine 5-6x would be plainly visible.

I have not isolated why. Two untested candidates: the correctness PRs merged after [#150](https://github.com/stellar/js-xdr/pull/150) ([#151](https://github.com/stellar/js-xdr/pull/151) to [#155](https://github.com/stellar/js-xdr/pull/155) added per-read bounds checks) ate the gains, or V8's escape analysis had already eliminated the short-lived allocations. Either way a merged PR claims a speedup the consuming SDK does not see, and that belongs in `stellar/js-xdr` rather than the SDK repo.

This matters for `V17PerfIssues.md` finding 4 (eager `${path}.${key}` strings), which is the same layer and predicted a similar win. Measure at the SDK boundary before investing in it.

## Not a bug

`kp.verify(tx.hash(), tx.signatures[0].signature)` returns `true` in rc.2 and `false` in 16.2.0. That is the API changing, not a v16 defect. v16 XDR fields are accessor functions, so the correct v16 code is `.signature()`. The real rc.2 improvement is that the same mistake now throws instead of silently returning `false`.

## Caveats

- The base64 split was measured on one 216-byte payload. base64's share grows with payload size, so larger envelopes are worse.
- Bundle and cold-import numbers depend entirely on import surface. Never quote them unscoped.
- Single machine. Treat anything under 5 percent as a wash.
