// Bundle a workspace entry into a single deployable file (Catalyst needs self-contained functions).
import { build } from "esbuild";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
const [entry, out] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "..");

// The Catalyst SDK ships an optional, pre-minified Site24x7 APM module that throws when bundled
// ("txnNormalizationRegex is not defined": sloppy-mode implicit globals). The SDK only wraps one request call
// with it, so replace it with a pass-through.
const stubApm = {
  name: "stub-apminsight",
  setup(b) {
    b.onResolve({ filter: /apminsight$/ }, args => (args.importer.includes("zcatalyst-sdk-node") ? { path: "apminsight-stub", namespace: "stub" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "module.exports = { __esModule: true, default: { startTracker: (_a, _b, fn) => fn() } };",
      loader: "js",
    }));
  },
};

// The SDK loads its service modules through `const requireModule = require; requireModule("./cache/cache")`, which a bundler
// cannot follow (the deployed function then fails with "Cannot find module"). Make those requires static.
const staticSdkRequires = {
  name: "static-sdk-requires",
  setup(b) {
    b.onLoad({ filter: /zcatalyst-sdk-node[\\/]lib[\\/]catalyst-app[.]js$/ }, args => ({
      contents: readFileSync(args.path, "utf8").replace("const requireModule = require;", "").split("requireModule(").join("require("),
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [resolve(root, entry)],
  outfile: resolve(root, out),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  footer: { js: "module.exports = module.exports.default || module.exports;" },
  plugins: [stubApm, staticSdkRequires],
  logLevel: "info",
});

// A relative require left in the output cannot be resolved once deployed (this is exactly how the SDK broke in the cloud).
const built = readFileSync(resolve(root, out), "utf8");
const stray = built.split("\n").filter(l => !l.trim().startsWith("//")).join("\n").match(/[^_a-zA-Z]require\(["']\.{1,2}\/[^"']*["']\)/g);
if (stray) { console.error("Unbundled relative requires:", [...new Set(stray)].slice(0, 5)); process.exit(1); }
