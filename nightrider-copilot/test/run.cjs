// Runs every *.test.cjs in this directory as a child process so one crash
// cannot take down the rest of the suite.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const files = fs.readdirSync(HERE).filter((f) => f.endsWith(".test.cjs")).sort();

let totalPassed = 0;
let totalFailed = 0;
let crashed = 0;
const broken = [];

for (const file of files) {
  const res = spawnSync(process.execPath, [path.join(HERE, file)], { encoding: "utf8" });
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (res.status === 0 && m) {
    totalPassed += Number(m[1]);
    totalFailed += Number(m[2]);
    console.log(`  ok   ${file.padEnd(24)} ${m[1]} passed`);
    if (out.includes("FAIL")) {
      // report() already counted them; surface the names for convenience
      for (const line of out.split("\n").filter((l) => l.startsWith("FAIL"))) {
        console.log(`         ${line.trim()}`);
      }
    }
  } else {
    crashed += 1;
    broken.push(file);
    console.log(`  FAIL ${file.padEnd(24)} ${res.status === 0 ? "assertions failed" : "crashed"}`);
    const first = out.split("\n").filter((l) => l.startsWith("FAIL") || l.startsWith("CRASH")).slice(0, 5);
    for (const line of first) {
      console.log(`         ${line.trim()}`);
    }
  }
}

console.log(`\n${files.length} files: ${totalPassed} passed, ${totalFailed} failed, ${crashed} crashed`);
if (crashed > 0) {
  console.log("crashed: " + broken.join(", "));
}
process.exit(totalFailed === 0 && crashed === 0 ? 0 : 1);
