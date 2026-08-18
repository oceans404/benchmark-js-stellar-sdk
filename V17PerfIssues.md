# v17.0.0 performance report

Originally written 2026-08-07 against a `v17-feature-branch` build. **Read the correction section first:** two of its claims do not hold against published packages. The numbered findings below keep their original measurements and wording.

Benchmarked v17.0.0-rc.1 (`v17-feature-branch` at `f7357043`, packed locally) against `@stellar/stellar-sdk@16.2.0`. Node v24.13.0, macOS, single machine, single run. Treat anything under 5 percent as noise. Everything below is far outside that band.

The suite reported four regressions: `fromXDR` -71 percent, `build+sign+toXDR` -16 percent, cold import +164 percent, bundles 19 to 47 percent larger. Findings 1 through 5 explain the first two. Finding 6 explains the other two.

Each cause was confirmed by patching it and re-measuring. Every patched build was checked against a 14 item differential XDR corpus (transaction envelopes including fee bump and multi operation, ScVal variants, memo, asset) requiring byte identical re-encoding and identical decoded values, plus the 5 runtime smoke suite.

## Correction and status, `17.0.0-rc.2` (measured 2026-08-18)

**Finding 1 never reached a published package.** Its 630k ops/s came from branch build `f7357043`. Published `17.0.0-rc.1` measures 69,747k, so the throw-on-the-common-path defect was fixed before rc.1 shipped. The finding was real when written; do not quote "267x slower" against any released version.

**Findings 2, 3 and 5 landed and bought nothing measurable.** The code is in `@stellar/js-xdr@5.0.0-rc.2`, verified by diffing the packed tarballs: `Reader` and `Writer` now hold one reused `#view`, `readUnionArm` builds one object instead of spreading. Published rc.1 versus rc.2, same machine, same session, three trials, 216-byte `TransactionEnvelope`:

| | 16.2.0 | rc.1 | rc.2 |
| --- | --- | --- | --- |
| decode from raw bytes | 620-632k | 833-870k | 797-842k |
| decode from base64 | 588-601k | 122-124k | 121-122k |
| encode to raw bytes | 700-731k | 569-575k | 564-588k |

**js-xdr itself did not get faster on this schema**, which is the surprising part. `TransactionEnvelope.schema._read` measures 1,018k ops/s on rc.1 and 1,047k on rc.2. This is not SDK code swamping the win: js-xdr is 85 percent of SDK decode time (0.97 of 1.14 µs). js-xdr PR #150 reports 5-6x on "a Stellar-shaped schema" and the SDK's real schema shows a wash. Untested candidates: the correctness PRs merged after #150 (#151 to #155, which added per-read bounds checks) ate the gains, or V8's escape analysis had already eliminated the short-lived allocations.

Measure at the SDK boundary before investing in finding 4, which is the same layer and predicted a similar win.

The table also shows two things true since rc.1 and unchanged by rc.2: v17 decodes raw XDR **33 percent faster than v16**, so the class-per-type redesign is not what makes `fromXDR` look slow, and base64 is the entire `fromXDR` regression at 86 percent of the base64 path.

### Finding 6 is the whole remaining gap, and its verdict is wrong

`atob` is not the problem, running at 17,650k ops/s. `uint8array-extras@1.5.0` decodes as `Uint8Array.from(atob(s), x => x.codePointAt(0))`, and `Uint8Array.from(str, mapFn)` walks the string through the iterator protocol with a per-character callback. On a 288-char payload:

| | ops/s | vs the library |
| --- | --- | --- |
| `atob` alone, no byte copy | 17,650k | |
| `Buffer.from(s, "base64")` (Node only) | 12,371k | 83x faster |
| same `atob` + a `charCodeAt` loop | 3,223k | **22x faster** |
| `uint8array-extras` `base64ToUint8Array` | 149k | baseline |

All produce byte-identical output. So "an accepted trade with no fast path" is wrong: the fast path is portable and it is five lines. A `charCodeAt` loop needs no `Buffer`, runs in browsers, Node, Bun, Deno and workerd, and keeps the no-`Buffer` property that motivated the migration. `Uint8Array.fromBase64` is not in Node 24.13, so it cannot be the only path.

This got more urgent: merged PR #1661 repointed `docs/UINT8ARRAY_MIGRATION.md` at `xdr.encodeBytes` / `xdr.decodeBytes`, thin wrappers over these functions, so the guide now steers every migrating user onto a path 67x slower than the `Buffer` call it replaces. #1611 and #1642 both already propose the wrapper this needs.

| # | Finding | rc.2 status |
| --- | --- | --- |
| 1 | `StrKey.isValid` throws on the common path | Fixed **before published rc.1** |
| 2 | `Reader` allocates per scalar read | In js-xdr 5.0.0-rc.2, no measurable SDK-level effect |
| 3 | `readUnionArm` allocates twice per union | In js-xdr 5.0.0-rc.2, no measurable SDK-level effect |
| 4 | Error path strings built eagerly | Open. Measure at the SDK boundary first |
| 5 | `Writer` allocates per scalar write | In js-xdr 5.0.0-rc.2, no measurable SDK-level effect |
| 6 | base64 replaced by a pure JS codec | **Open, and the whole `fromXDR` gap** |
| 7 | Class per XDR type | Open, design trade. Cold import +173%, bundles +22 to +49%, unchanged |

Full write-up: [`reports/17.0.0-rc.2-vs-16.2.0/findings.md`](reports/17.0.0-rc.2-vs-16.2.0/findings.md).

## Summary

| # | Finding | Impact | Verdict |
| --- | --- | --- | --- |
| 1 | `StrKey.isValid` throws on the common path | `isValidMed25519PublicKey` 267x slower; `build()` -40% | **Regression and bug** |
| 2 | js-xdr `Reader` allocates per scalar read | decode +51% when fixed | **Bug in new code** |
| 3 | js-xdr `readUnionArm` allocates twice per union | decode +101% when fixed | **Bug in new code** |
| 4 | js-xdr builds error path strings eagerly | decode +17% when fixed | **Inefficiency, needs a design call** |
| 5 | js-xdr `Writer` allocates per scalar write | encode +110% when fixed | **Bug in new code** |
| 6 | base64 replaced by a pure JS codec | 62x slower decode | **Regression, accepted trade with no fast path** |
| 7 | Class per XDR type | cold import +164%, bundles +19 to +47% | **Design trade, not a bug** |

Findings 2, 3, and 4 together take decode from 347k to 1,225k ops/s. That is 3.5x stock v17 and 1.85x faster than v16.

---

## 1. `StrKey.isValid` throws an exception on the common path

`stellar/js-stellar-sdk`, `src/base/strkey.ts` line 391.

v16 checked the encoded length first, so a wrong strkey type returned `false` in a few nanoseconds. v17 removed that switch and calls `decodeCheck` unconditionally inside a `try`. `decodeCheck` reports a length mismatch by throwing, so the negative case now constructs an `Error` with a stack trace and discards it.

`decodeAddressToMuxedAccount` asks `isValidMed25519PublicKey` about every destination address. Ordinary G addresses are the common case, so the common case is the throwing case, twice per transaction build.

| | 16.2.0 | v17 | patched |
| --- | --- | --- | --- |
| `isValidMed25519PublicKey(G…)` | 167,973k ops/s | 630k ops/s | 107,698k ops/s |
| `TransactionBuilder.build()` | 172k ops/s | 104k ops/s | 313k ops/s |

**Why (hypothesis).** Deliberate consolidation, not an oversight. The v17 source comment reads "encoded-length bounds are enforced by `decodeCheck`". Moving validation into one place is good design. What was missed is that the shared path signals failure by throwing, and that a validity predicate calls it on inputs expected to fail.

**Verdict: regression and bug.** The consolidation is sound; using a throw to answer a predicate is the defect. Restoring a length pre-check before the `try` makes `build()` 1.8x faster than v16. A cleaner fix gives `decodeCheck` a non throwing sibling. Note the positive path (`isValidEd25519PublicKey`) is 2.5x faster in v17, so only the negative path regressed.

---

## 2, 3, 5. js-xdr allocates per scalar and per union

`stellar/js-xdr` 5.0.0-rc.1, `Reader`, `Writer`, and `readUnionArm`.

Three instances of the same pattern. Every integer read allocates a byte copy and a fresh `DataView`:

```js
readInt32(path) {
  const view = viewFor(this.readBytes(4, path));  // slice() + new DataView()
  return view.getInt32(0, false);
}
```

`Writer` mirrors it, allocating a `Uint8Array`, a `DataView`, and then copying. `readUnionArm` builds `{[switchKey]: d}` and spreads it into a second literal, so two allocations per union with computed keys that defeat V8 shape caching. Stellar XDR is union heavy. In CPU profiles `readUnionArm` is the top frame at 24 percent, `viewFor` is 13.7 percent, and buffer allocation is 9.0 percent.

Fixes are mechanical. Cache one `DataView` per `Reader` and read at offset. Same for `Writer`, recreating only on buffer growth. Build the union result in one allocation.

| | 16.2.0 | v17 | patched |
| --- | --- | --- | --- |
| envelope decode | 662k ops/s | 347k ops/s | 1,225k ops/s |
| envelope encode | 706k ops/s | 288k ops/s | 606k ops/s |

**Why (hypothesis).** js-xdr 5 is a rewrite to a Uint8Array native, `Buffer` free model. `Buffer` has ergonomic read and write helpers at an offset; `Uint8Array` does not, and `DataView` is the standard replacement. The natural translation allocates a view per call. Correctness first, with optimization deferred and apparently not revisited.

**Verdict: bugs in new code.** Not regressions in the strict sense, since none of this code existed in v16, but they are defects that produce a user visible regression. Byte identical output before and after, so the fixes carry no behavior risk.

---

## 4. Error path strings are built eagerly

`stellar/js-xdr` 5.0.0-rc.1, `StructType._read` and friends.

Every field read concatenates a diagnostic path that is almost never used:

```js
value[key] = schema._read(reader, `${path}.${key}`);
```

A ten field struct builds ten strings per decode, purely to label an error thrown only on malformed input. Removing this is worth 17 percent of decode.

**Why (hypothesis).** v17 clearly invested in better XDR error messages, and a precise path is genuinely useful when decoding fails. Passing the string down is the simplest way to get it. The cost is invisible until profiled.

**Verdict: inefficiency, needs a design call rather than a mechanical fix.** This is the one finding that trades against error message quality. Making the path lazy (a frame object, a reader side path stack, or a thunk) keeps both, at some complexity cost. Worth deciding deliberately, not worth silently reverting.

---

## 6. base64 replaced by a pure JS codec

`stellar/js-stellar-sdk`, `src/xdr/values/xdr-value.ts` and `bytes-value.ts`.

The Buffer to Uint8Array migration swapped native base64 for `uint8array-extras`.

| | native | `uint8array-extras` | ratio |
| --- | --- | --- | --- |
| decode, 288 byte envelope | 9,345k ops/s | 152k ops/s | 62x slower |
| encode | 12,344k ops/s | 674k ops/s | 18x slower |

`TransactionBuilder.fromXdr` takes base64, so every call is capped near 152k ops/s before any XDR work begins. This is about 63 percent of the `fromXDR` regression. It also gates findings 2 through 4: with those fixed, end to end `fromXdr` still only reaches 108k ops/s because base64 becomes the wall.

**Why (hypothesis).** Dropping the `Buffer` dependency was a headline v17 goal, and it worked. The `buffer` shim no longer appears in any bundle. `uint8array-extras` is the obvious portable replacement, and the assumption appears to be that portable means pure JS.

**Verdict: regression from an accepted trade, but the trade was not necessary.** Native base64 exists in every target runtime. `Buffer` in Node, `atob` and `btoa` in browsers and Workers. A fast path with the pure JS codec as fallback keeps the no Buffer dependency property and recovers the cost. `Uint8Array.fromBase64` would be cleanest but is not in Node 24 yet, so it cannot be the only path.

---

## 7. Class per XDR type

**Verdict: design trade, not a bug.** Patching findings 1 through 6 did not move any of these.

- Cold import +164 percent, 49ms to 131ms median. v17 ships 620 ESM files against v16's 175. A full bundle pulls 622 modules against 192, of which 460 are XDR types against 28.
- Bundles 19 to 47 percent larger gzipped. Full SDK 119.3 KB to 174.9 KB.
- `tx.toXdr()` capped near 56k ops/s by `toEnvelope()` rebuilding XDR class objects. This sits above the js-xdr layer and finding 5 does not help it.

The same redesign pays for itself elsewhere: `ScInt` round trip +70 percent, `nativeToScVal` +10 percent, `StrKey` positive path 2.5x, hash +6 percent, and no `buffer` shim in any bundle. Worth stating plainly in the release notes rather than treating as something to fix.

---

## Note for whoever verifies finding 1

Isolated microbenchmarks confirm the opposite conclusion. Timing `StrKey.decodeEd25519PublicKey` in a tight loop reports v17 as 2.4x **faster**. Timing the same function inside a real `build()` shows it 1.8x **slower**. Per call site attribution then reveals the cause, which is two extra `med25519` calls a loop benchmark never triggers. Measure in the real call path.

## Caveats

- Single machine, single run. Directional, not a controlled lab result.
- Fixes were applied to `node_modules` and validated against the differential corpus and the smoke suite. The SDK's own unit test suite has not been run against them.
