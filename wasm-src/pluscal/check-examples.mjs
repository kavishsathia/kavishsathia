// Runs every example in src/lib/pluscal/examples.ts through the shipped
// jars on a real JVM — pcal.trans, then TLC exactly as the page invokes it —
// and checks TLC's exit status against the example's expectation.
//
//   node wasm-src/pluscal/check-examples.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { examples } from "../../src/lib/pluscal/examples.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "../../public/pluscal");
const cp = join(pub, "tla2tools.jar");
const work = join(here, ".work/examples");
const home = join(here, ".work/jvm-home");
rmSync(work, { recursive: true, force: true });

let failed = 0;
for (const ex of examples) {
  const name = /MODULE\s+(\w+)/.exec(ex.tla)[1];
  const dir = join(work, ex.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.tla`), ex.tla);
  if (/--(?:fair\s+)?algorithm/.test(ex.tla)) {
    execFileSync("java", [`-Duser.home=${home}`, "-cp", cp, "pcal.trans", "-nocfg", `${name}.tla`], { cwd: dir, stdio: "pipe" });
  }
  writeFileSync(join(dir, `${name}.cfg`), ex.cfg);
  const t0 = Date.now();
  const r = spawnSync(
    "java",
    [`-Duser.home=${home}`, "-XX:+UseParallelGC", "-cp", cp, "tlc2.TLC", "-tool", "-workers", "1", "-noGenerateSpecTE",
     "-config", `${name}.cfg`, "-metadir", "states", `${name}.tla`],
    { cwd: dir, encoding: "utf8" },
  );
  const ok = r.status === ex.expectStatus;
  if (!ok) failed++;
  const states = /([\d,]+) distinct states found/.exec(r.stdout ?? "")?.[1] ?? "?";
  console.log(`${ok ? "  ok  " : "  FAIL"} ${ex.id.padEnd(16)} exit ${r.status} (want ${ex.expectStatus}), ${states} distinct states, ${Date.now() - t0} ms`);
  if (!ok) console.log(r.stdout.split("\n").filter((l) => !l.startsWith("@!@!@")).join("\n"));
}
if (failed) {
  console.log(`${failed} example(s) failed`);
  process.exit(1);
}
console.log("all examples behave as labelled");
