// Bundle-size + tree-shaking benchmark for @stellar/stellar-sdk.
//
// For each scenario it bundles a fixture with esbuild (production settings),
// then records raw / gzip / brotli sizes and which "watched" dependencies
// actually landed in the bundle. Results are written to reports/bundle-report.md
// (the committed performance report) and printed to the console.
//
// Run: npm run benchmark

import { build, version as esbuildVersion } from "esbuild";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { ROLES, resolvedVersion, reportDir } from "../lib/versions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = reportDir();
const metaDir = join(outDir, "meta");
mkdirSync(metaDir, { recursive: true });

const labels = { baseline: resolvedVersion("baseline"), candidate: resolvedVersion("candidate") };

// Describe how a bundler actually resolves the baseline instead of assuming it.
// v15 shipped a prebuilt, un-tree-shakeable `browser` UMD root and no ESM entry;
// v16+ are ESM-first, so the UMD caveat only applies to some baselines.
const baselinePkg = JSON.parse(
  readFileSync(join(root, "node_modules", "sdk-baseline", "package.json"), "utf8"),
);
const baselineHasUmdRoot = Boolean(baselinePkg.browser);
const baselineSourceFormat = baselinePkg.module ? "ESM" : "CJS";

// Deltas are reported in the direction they actually go — the candidate is not
// always the smaller build.
const direction = (p) => (p >= 0 ? "smaller" : "larger");
const fmtDelta = (p) => `**${Math.abs(p).toFixed(0)}% ${direction(p)}**`;
// Signed percentage in the headline table's convention: positive = candidate
// is larger. Takes a already-flipped value, so callers pass `-pctSmaller`.
const fmtSigned = (p) => `${p > 0 ? "+" : ""}${p.toFixed(0)}%`;
// [min, max] of pct-smaller values; reads correctly even when the range straddles
// zero (one scenario smaller, another larger).
const fmtRange = ([lo, hi]) => {
  if (direction(lo) !== direction(hi))
    return `${Math.abs(lo).toFixed(0)}% ${direction(lo)} to ${Math.abs(hi).toFixed(0)}% ${direction(hi)}`;
  // Same direction: order by magnitude, which is not the order of the raw values
  // when both are negative (candidate larger).
  const [a, b] = [Math.abs(lo), Math.abs(hi)].sort((x, y) => x - y);
  return `${a.toFixed(0)}–${b.toFixed(0)}% ${direction(hi)}`;
};

// Each scenario maps to two fixtures: <key>.baseline.js and <key>.candidate.js
const SCENARIOS = [
  { key: "full", label: "Full SDK (`import * as`)" },
  { key: "rpc-only", label: "RPC only (`/rpc`)" },
  { key: "horizon-classic", label: "Classic Horizon app" },
  { key: "contract", label: "Contract client (`/contract`)" },
];

// If these show up in a narrow import, tree-shaking left something behind.
// (eventsource + smol-toml are Horizon-only; axios/feaxios back the HTTP client;
//  buffer is the polyfill still pending removal.)
const WATCH = ["eventsource", "smol-toml", "axios", "feaxios", "buffer"];

const kb = (bytes) => (bytes / 1024).toFixed(1) + " KB";

async function measure(scenarioKey, role) {
  const entry = join(root, "fixtures", `${scenarioKey}.${role}.js`);
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      metafile: true,
      write: false,
      legalComments: "none",
      logLevel: "silent",
    });
    const out = result.outputFiles[0].contents;
    writeFileSync(
      join(metaDir, `${scenarioKey}.${role}.json`),
      JSON.stringify(result.metafile, null, 2),
    );
    const inputs = Object.keys(result.metafile.inputs);
    const watch = Object.fromEntries(
      // exact package-dir match (`/axios/`), not substring, to avoid e.g.
      // `some-axios-wrapper` registering as `axios`.
      WATCH.map((w) => [w, inputs.some((p) => p.includes(`/${w}/`))]),
    );
    return {
      ok: true,
      raw: out.byteLength,
      gzip: gzipSync(out).byteLength,
      brotli: brotliCompressSync(out).byteLength,
      modules: inputs.length,
      watch,
    };
  } catch (err) {
    return { ok: false, error: err.message?.split("\n")[0] ?? String(err) };
  }
}

// Control: bundle a role's `full` fixture from its SOURCE entry, not a prebuilt
// `browser` UMD. `platform: node` + module/main mainFields skips the browser
// field; node built-ins stay external. This compares baseline source to
// candidate source and separates "the candidate ships less code" from "the
// baseline shipped an un-tree-shakeable UMD bundle".
async function measureSource(scenarioKey, role) {
  const entry = join(root, "fixtures", `${scenarioKey}.${role}.js`);
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "node",
      mainFields: ["module", "main"],
      conditions: ["import", "module", "node", "default"],
      target: "es2022",
      write: false,
      legalComments: "none",
      logLevel: "silent",
    });
    const out = result.outputFiles[0].contents;
    return { ok: true, gzip: gzipSync(out).byteLength, raw: out.byteLength };
  } catch (err) {
    return { ok: false, error: err.message?.split("\n")[0] ?? String(err) };
  }
}

const results = {};
for (const s of SCENARIOS) {
  results[s.key] = {};
  for (const role of ROLES) {
    results[s.key][role] = await measure(s.key, role);
  }
}
const CONTROL_KEYS = ["full", "horizon-classic"];
const control = {};
for (const k of CONTROL_KEYS) {
  control[k] = { baseline: await measureSource(k, "baseline"), candidate: await measureSource(k, "candidate") };
}

// --- Build the markdown report -------------------------------------------

const lines = [];
lines.push(`# Bundle-size report: \`@stellar/stellar-sdk\` ${labels.candidate} vs ${labels.baseline}`);
lines.push("");
const today = new Date().toISOString().slice(0, 10);
lines.push(
  `Generated by \`npm run benchmark\` on ${today} (Node ${process.version}, esbuild ${esbuildVersion}). ` +
    `baseline = \`@stellar/stellar-sdk@${labels.baseline}\`, candidate = \`@stellar/stellar-sdk@${labels.candidate}\`. ` +
    "Sizes are of a production esbuild bundle (minified, ESM, `platform: browser`). " +
    "gzip is the number users download; it is the one to quote.",
);
lines.push("");
lines.push("## Size by scenario");
lines.push("");
lines.push(`| Scenario | ${labels.baseline} gzip | ${labels.candidate} gzip | Δ gzip | candidate brotli | candidate raw |`);
lines.push("| --- | --- | --- | --- | --- | --- |");
for (const s of SCENARIOS) {
  const a = results[s.key].baseline;
  const b = results[s.key].candidate;
  if (!a.ok || !b.ok) {
    const why = !a.ok ? `baseline: ${a.error}` : `candidate: ${b.error}`;
    lines.push(`| ${s.label} | — | — | build failed (${why}) | — | — |`);
    continue;
  }
  const deltaNum = ((b.gzip - a.gzip) / a.gzip) * 100;
  const sign = deltaNum > 0 ? "+" : "";
  lines.push(
    `| ${s.label} | ${kb(a.gzip)} | ${kb(b.gzip)} | ${sign}${deltaNum.toFixed(1)}% | ${kb(b.brotli)} | ${kb(b.raw)} |`,
  );
}
lines.push("");
lines.push(
  "Negative Δ means the candidate is smaller. **These are default-resolution numbers:** each " +
    "version is bundled the way a real bundler would resolve it. " +
    (baselineHasUmdRoot
      ? "The baseline's root import resolves its prebuilt `browser` UMD bundle (which cannot be " +
        "tree-shaken) and the candidate resolves ESM source, so the `full` / `horizon-classic` " +
        "deltas mix a real code-size difference with that build-input difference. The `/rpc` and " +
        "`/contract` rows have the baseline also resolve source. The control below isolates the " +
        "real difference."
      : `The baseline ships no prebuilt \`browser\` root, so both versions resolve ${baselineSourceFormat} ` +
        "source in every scenario. These deltas are a like-for-like code-size comparison; the " +
        "control below is a secondary check under `platform: node`."),
);
lines.push("");

// --- Control: source-to-source -------------------------------------------
const pctSmaller = (a, b) => ((a - b) / a) * 100;
const okScenario = (k) => results[k].baseline.ok && results[k].candidate.ok;
const range = (keys) => {
  const r = keys.filter(okScenario).map((k) => pctSmaller(results[k].baseline.gzip, results[k].candidate.gzip));
  return r.length ? [Math.min(...r), Math.max(...r)] : null;
};
const sub = range(["rpc-only", "contract"]);
const rootR = range(["full", "horizon-classic"]);

lines.push("## Build-input fairness (control: bundle from source)");
lines.push("");
lines.push(
  (baselineHasUmdRoot
    ? "The baseline has no root ESM build, so its default root import resolves a prebuilt `browser` " +
      "UMD bundle that can't be tree-shaken. Re-bundling each version from its **source** entry " +
      `(baseline via ${baselineSourceFormat}, candidate via ESM \`module\`) isolates the real code-size difference. `
    : "Both versions already resolve source by default, so this control mainly re-checks the " +
      "headline numbers under different build settings rather than correcting for a UMD baseline. ") +
    "These control builds use `platform: node` (node built-ins external), so they are NOT " +
    "directly comparable to the `platform: browser` rows above — compare baseline-source to " +
    "candidate-source *within* this table.",
);
lines.push("");
lines.push(
  `| Scenario | baseline default | baseline source (${baselineSourceFormat}) | candidate source (ESM) | Δ gzip (candidate vs baseline source) |`,
);
lines.push("| --- | --- | --- | --- | --- |");
const ctlDelta = {};
for (const k of CONTROL_KEYS) {
  const def = results[k].baseline;
  const c = control[k];
  if (!c.baseline.ok || !c.candidate.ok) {
    lines.push(`| ${k} | ${def?.ok ? kb(def.gzip) : "—"} | control build failed | — | — |`);
    continue;
  }
  ctlDelta[k] = pctSmaller(c.baseline.gzip, c.candidate.gzip);
  // Render with the SAME sign convention as the headline Δ gzip column
  // (positive = candidate is larger). ctlDelta itself stays "percent smaller"
  // because fmtDelta/fmtRange below read it that way.
  lines.push(
    `| ${k} | ${def?.ok ? kb(def.gzip) : "—"} | ${kb(c.baseline.gzip)} | ${kb(c.candidate.gzip)} | ${fmtSigned(-ctlDelta[k])} |`,
  );
}
lines.push("");
lines.push(
  `**Summary:** bundled from source (baseline ${baselineSourceFormat} vs candidate ESM), the candidate is ` +
    `${ctlDelta["full"] != null ? fmtDelta(ctlDelta["full"]) : "n/a"} for the full SDK and ` +
    `${ctlDelta["horizon-classic"] != null ? fmtDelta(ctlDelta["horizon-classic"]) : "n/a"} for a classic Horizon import. ` +
    `Subpath imports (\`/rpc\`, \`/contract\`) show ${sub ? fmtRange(sub) : "n/a"}. ` +
    (baselineHasUmdRoot
      ? `The larger ${rootR ? `~${Math.abs(rootR[1]).toFixed(0)}%` : ""} for default root imports also reflects the baseline ` +
        "shipping a non-tree-shakeable UMD bundle, not only a code-size difference in the candidate."
      : "Both versions resolve source in the default numbers too, so the headline table and this " +
        "control point the same direction."),
);
lines.push("");

lines.push("## Tree-shaking watch");
lines.push("");
lines.push(
  "Does a narrow import still drag in heavy or Horizon-only deps? A ✓ in a " +
    "non-full scenario means tree-shaking left that module in.",
);
lines.push("");
lines.push("| Scenario | version | " + WATCH.join(" | ") + " |");
lines.push("| --- | --- | " + WATCH.map(() => "---").join(" | ") + " |");
for (const s of SCENARIOS) {
  for (const role of ROLES) {
    const r = results[s.key][role];
    if (!r.ok) {
      lines.push(`| ${s.label} | ${labels[role]} | ${WATCH.map(() => "—").join(" | ")} |`);
      continue;
    }
    const cells = WATCH.map((w) => (r.watch[w] ? "✓" : "·")).join(" | ");
    lines.push(`| ${s.label} | ${labels[role]} | ${cells} |`);
  }
}
lines.push("");
// Derive the takeaway from the watch data. Hardcoding it means a module that
// later drops out (or creeps back in) ships as a false claim in the report.
{
  const okScenarios = SCENARIOS.filter((s) => results[s.key].candidate.ok);
  const narrow = okScenarios.filter((s) => s.key !== "full");
  const inEvery = (role, keys) =>
    WATCH.filter((w) => keys.length > 0 && keys.every((s) => results[s.key][role].watch[w]));
  // Present in the widest import but absent from at least one narrower one.
  // `some`, not `every`: a Horizon-only module legitimately stays in the
  // Horizon scenario, and `every` would refuse to credit it anywhere.
  const droppedFromNarrow = WATCH.filter(
    (w) =>
      results.full.candidate.ok &&
      results.full.candidate.watch[w] &&
      narrow.some((s) => !results[s.key].candidate.watch[w]),
  );
  const alwaysPresent = inEvery("candidate", okScenarios);
  const goneVsBaseline = WATCH.filter(
    (w) =>
      okScenarios.length > 0 &&
      okScenarios.every((s) => results[s.key].baseline.ok && results[s.key].baseline.watch[w]) &&
      okScenarios.every((s) => !results[s.key].candidate.watch[w]),
  );
  const list = (xs) => xs.map((x) => `\`${x}\``).join("/");
  const parts = [];
  if (droppedFromNarrow.length)
    parts.push(`${list(droppedFromNarrow)} drop out of narrower imports`);
  if (goneVsBaseline.length)
    parts.push(`${list(goneVsBaseline)} is gone from every candidate bundle, and was in every baseline one`);
  const good = parts.length ? `the candidate's tree-shaking is real (${parts.join("; ")})` : null;
  const bad = alwaysPresent.length
    ? `${list(alwaysPresent)} still rides along in every candidate bundle`
    : null;
  lines.push(
    "Takeaway: " +
      (good && bad
        ? `${good}, but not yet clean — ${bad}.`
        : good
          ? `${good}, and nothing on the watch list rides along in every bundle.`
          : bad
            ? `${bad}.`
            : "nothing on the watch list is present in every candidate bundle."),
  );
}
lines.push("");
lines.push("## Caveats");
lines.push("");
lines.push(
  "- Each version is resolved the way a real bundler would resolve it (default " +
    "export conditions). " +
    (baselineHasUmdRoot
      ? "The candidate resolves ESM source; the baseline's **root** import " +
        "resolves its `browser` field, a prebuilt UMD bundle — which is why the baseline `full` and " +
        "`horizon-classic` are an identical size (no tree-shaking) and the baseline watch row shows " +
        "nothing (esbuild can't see module names inside the prebuilt bundle). Baseline subpaths " +
        "(`/rpc`, `/contract`) have no `browser` field and do resolve source. This is the honest " +
        "user-facing number, not a forced same-entry comparison — but treat the baseline watch " +
        "column as unreliable."
      : "Neither version ships a prebuilt `browser` root, so both resolve source in every " +
        "scenario and the watch column is meaningful for both."),
);
lines.push(
  "- `platform: browser`. A scenario that fails to bundle shows a failure row in the " +
    "size table above, and is itself a finding (it needs polyfills in the browser).",
);
lines.push("");

const report = lines.join("\n") + "\n";
writeFileSync(join(outDir, "bundle-report.md"), report);

// --- Console summary ------------------------------------------------------

console.log("\nBundle-size benchmark\n=====================");
for (const s of SCENARIOS) {
  const a = results[s.key].baseline;
  const b = results[s.key].candidate;
  if (!a.ok || !b.ok) {
    console.log(`${s.label.padEnd(28)} build failed`);
    continue;
  }
  const delta = (((b.gzip - a.gzip) / a.gzip) * 100).toFixed(1);
  console.log(
    `${s.label.padEnd(28)} ${labels.baseline} ${kb(a.gzip).padStart(9)}  ->  ${labels.candidate} ${kb(b.gzip).padStart(9)}  (${delta > 0 ? "+" : ""}${delta}%)`,
  );
}
console.log(
  `\nReport written to ${relative(process.cwd(), join(outDir, "bundle-report.md"))}`,
);
