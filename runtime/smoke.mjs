// Shared runtime smoke test for @stellar/stellar-sdk v16.
//
// Exercises the SDK paths most likely to break outside Node: ed25519 signing
// (needs crypto.getRandomValues), hashing, XDR build (needs no `Buffer` global),
// and a tree-shakeable subpath import. It imports the *real published v16*
// package, not a fixture, so it reflects what a consumer gets.
//
// This file is runtime-agnostic. The per-runtime runners (run-node.mjs,
// run-deno.mjs, run-bun.mjs, worker.mjs) import `runSmoke` and report.
//
// It deliberately does NOT install any polyfills, so a missing global
// (e.g. `Buffer` on an edge runtime) surfaces as a real failure.

// v17 renamed `toXDR` -> `toXdr` and `TransactionBuilder.fromXDR` -> `fromXdr`
// with no back-compat aliases, so call whichever the installed version exposes.
// This is a naming difference, not a runtime-compatibility one.
const txToXdr = (tx) => (tx.toXdr ? tx.toXdr() : tx.toXDR());
const txFromXdr = (TB, xdr, passphrase) =>
  TB.fromXdr ? TB.fromXdr(xdr, passphrase) : TB.fromXDR(xdr, passphrase);

export async function runSmoke(sdk) {
  const checks = [];
  const check = async (name, fn) => {
    try {
      await fn();
      checks.push({ name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, error: err?.message ?? String(err) });
    }
  };

  // 1. Keypair generation + signing. Needs crypto.getRandomValues + @noble/ed25519.
  await check("keypair: random + sign + verify", () => {
    const kp = sdk.Keypair.random();
    const msg = new TextEncoder().encode("smoke");
    const sig = kp.sign(msg);
    if (!kp.verify(msg, sig)) throw new Error("signature did not verify");
  });

  // 2. StrKey round-trip (pure JS, should work anywhere).
  await check("strkey: encode/decode round-trip", () => {
    const kp = sdk.Keypair.random();
    const pub = kp.publicKey();
    const raw = sdk.StrKey.decodeEd25519PublicKey(pub);
    if (sdk.StrKey.encodeEd25519PublicKey(raw) !== pub)
      throw new Error("strkey round-trip mismatch");
  });

  // 3. Hashing.
  await check("hash: sha256 of bytes", () => {
    const out = sdk.hash(new TextEncoder().encode("smoke"));
    if (!out || out.length !== 32) throw new Error("unexpected hash length");
  });

  // 4. Build + sign a transaction, then serialize to XDR. Touches the most
  //    Buffer-sensitive path (envelope encoding) without any network call.
  await check("tx: build + sign + toXDR", () => {
    const kp = sdk.Keypair.random();
    const account = new sdk.Account(kp.publicKey(), "0");
    const tx = new sdk.TransactionBuilder(account, {
      fee: sdk.BASE_FEE,
      networkPassphrase: sdk.Networks.TESTNET,
    })
      .addOperation(
        sdk.Operation.payment({
          destination: sdk.Keypair.random().publicKey(),
          asset: sdk.Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(kp);
    const xdr = txToXdr(tx);
    if (typeof xdr !== "string" || xdr.length === 0)
      throw new Error("toXDR produced empty output");
    // round-trip back
    const parsed = txFromXdr(sdk.TransactionBuilder, xdr, sdk.Networks.TESTNET);
    if (!parsed) throw new Error("fromXDR failed");
  });

  return checks;
}

// Pretty-print + exit code helper shared by the runners.
export function report(runtime, checks) {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.length - pass;
  console.log(`\n[${runtime}] ${pass}/${checks.length} checks passed`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : ` — ${c.error}`}`);
  }
  return fail === 0;
}
