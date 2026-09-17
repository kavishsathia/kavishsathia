/*
 * Browser orchestration for the Icarus Verilog WASM port published by VeriSim.
 * Upstream: https://github.com/senolgulgonul/verisim (a275a9ac28c59db1130505973644c9a3754ec1d7)
 * Engine: Icarus Verilog 14.0-dev (c7530db), GPL-2.0-or-later.
 * This worker intentionally contains no HDL semantics; it connects ivlpp -> ivl -> vvp.
 */
import initIvlpp from "./ivlpp.js";
import initIvl from "./ivl.js";
import initVvp from "./vvp.js";
import { boundedLines, readBounded, MAX_COMPILED_BYTES, MAX_PREPROCESSED_BYTES, MAX_VCD_BYTES } from "./worker-limits.js";

function sanitize(source) {
  return source
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

function config(generation) {
  return `basedir:/
module:system.vpi
generation:${generation}
generation:no-specify
out:/out.vvp
iwidth:32
widthcap:65536
functor:cprop
functor:nodangle
flag:DLL=vvp.tgt
`;
}

async function preprocess(files) {
  const output = boundedLines(MAX_PREPROCESSED_BYTES);
  const errors = boundedLines();
  const runtime = await initIvlpp({ print: (line) => output.push(line), printErr: (line) => errors.push(line) });
  const args = ["-L"];
  for (const file of files) {
    runtime.FS.writeFile(`/${file.name}`, file.source.endsWith("\n") ? file.source : `${file.source}\n`);
    args.push(`/${file.name}`);
  }
  runtime.callMain(args);
  if (output.exceeded) throw new Error("Preprocessed source exceeded the 2 MiB limit.");
  return { source: `${output.text()}\n`, errors: errors.text() };
}

async function compile(source, generation) {
  const errors = boundedLines();
  const runtime = await initIvl({ print: () => {}, printErr: (line) => errors.push(line) });
  runtime.FS.writeFile("/ivl.conf", config(generation));
  runtime.FS.writeFile("/src.v", source);
  runtime.callMain(["-C/ivl.conf", "--", "/src.v"]);
  let program = null;
  try { program = readBounded(runtime, "/out.vvp", MAX_COMPILED_BYTES, "Compiled program"); } catch (error) {
    if (error instanceof Error && /exceeded/.test(error.message)) throw error;
  }
  return { program, errors: errors.text() };
}

async function simulate(program) {
  const output = boundedLines();
  const runtimeErrors = boundedLines();
  const runtime = await initVvp({ print: (line) => output.push(line), printErr: (line) => runtimeErrors.push(line) });
  runtime.FS.writeFile("/sim.vvp", program);
  runtime.callMain(["/sim.vvp"]);
  let vcd = null;
  try { vcd = readBounded(runtime, "/dump.vcd", MAX_VCD_BYTES, "Waveform", { encoding: "utf8" }); } catch (error) {
    if (error instanceof Error && /exceeded/.test(error.message)) throw error;
  }
  return { stdout: output.text(), runtimeErrors: runtimeErrors.text(), vcd };
}

function cleanEngineNoise(text) {
  return text.split("\n").filter((line) => !/system\.vpi|dynamic linking not enabled/.test(line)).join("\n").trim();
}

function runtimeFailures(text) {
  return text.split("\n").filter((line) => /^(?:ERROR|FATAL):\s+\/?(?:design|testbench)\.v:\d+:/i.test(line.trim())).join("\n");
}

function diagnostics(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const match = line.match(/\/?(design|testbench)\.v:(\d+):?\s*(.*)/);
    const severity = /warning/i.test(line) ? "warning" : "error";
    return match
      ? { file: `${match[1]}.v`, line: Number(match[2]), message: match[3] || line, severity }
      : { file: "engine", message: line, severity };
  });
}

self.onmessage = async (event) => {
  const request = event.data;
  if (!request || request.type !== "run") return;
  const started = performance.now();
  const stage = (value) => self.postMessage({ id: request.id, type: "stage", stage: value });
  try {
    stage("preprocessing");
    const preprocessed = await preprocess([
      { name: "design.v", source: sanitize(request.design) },
      { name: "testbench.v", source: sanitize(request.testbench) },
    ]);
    stage("compiling");
    const compiled = await compile(preprocessed.source, request.generation);
    const compilerOutput = cleanEngineNoise([preprocessed.errors, compiled.errors].filter(Boolean).join("\n"));
    if (!compiled.program) {
      self.postMessage({ id: request.id, type: "result", result: {
        vcd: null, stdout: compilerOutput, diagnostics: diagnostics(compilerOutput || "Compilation failed."), elapsedMs: performance.now() - started,
      } });
      return;
    }
    stage("simulating");
    const simulation = await simulate(compiled.program);
    const runtimeOutput = cleanEngineNoise(simulation.runtimeErrors);
    const runtimeFailureOutput = [runtimeOutput, runtimeFailures(simulation.stdout)].filter(Boolean).join("\n");
    self.postMessage({ id: request.id, type: "result", result: {
      ...simulation,
      stdout: [compilerOutput, simulation.stdout, runtimeOutput].filter(Boolean).join("\n"),
      diagnostics: diagnostics([compilerOutput, runtimeFailureOutput].filter(Boolean).join("\n")),
      elapsedMs: performance.now() - started,
    } });
  } catch (error) {
    self.postMessage({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
