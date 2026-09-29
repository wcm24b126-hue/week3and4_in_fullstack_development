// Shared bootstrap for the KnightRider test suite.
//
// The tests drive the *compiled* output in out/ against a stubbed `vscode`
// module, so they exercise the same code that ships in the VSIX. Run
// `npm run compile` first.
const Module = require("module");
const path = require("path");
const fs = require("fs");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "out");
const MEDIA = path.join(ROOT, "media");

if (!fs.existsSync(path.join(OUT, "extension.js"))) {
  console.error("out/ is missing. Run: npm run compile");
  process.exit(1);
}

// Intercept `require("vscode")` and return the stub, preserving object identity
// so the extension can mutate it exactly as it would the real module.
//
// Tests that need a richer surface (activate, e2e) set NR_VSCODE_STUB to a
// module that re-exports their own object.
const STUB = process.env.NR_VSCODE_STUB
  ? path.resolve(__dirname, process.env.NR_VSCODE_STUB)
  : path.join(HERE, "stub-vscode.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") {
    return STUB;
  }
  return origResolve.call(this, request, ...args);
};

let pass = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL ${name}  ${detail}`);
  }
}

function report(label) {
  console.log(`\n${label}: ${pass} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("failed: " + failures.join(", "));
  }
  return failed === 0 ? 0 : 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { OUT, ROOT, MEDIA, HERE, check, report, sleep };
