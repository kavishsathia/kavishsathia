import { dotnet } from './_framework/dotnet.js';
import { initZ3Glue, createContext, evalSmtlib, disposeContext } from './z3glue.js';

const status = (msg) => {
  document.getElementById('status').textContent = msg;
  console.log('[dafny-wasm]', msg);
};

try {
  status('starting z3…');
  await initZ3Glue();

  status('starting dotnet…');
  const { getAssemblyExports, getConfig, setModuleImports, runMain } = await dotnet.create();
  let evalCount = 0;
  const loggedEval = async (id, smt) => {
    const n = ++evalCount;
    const tail = smt.trimEnd().split('\n').pop();
    console.log(`[smt#${n}>] ${smt.length}ch last=${tail.slice(0, 120)}`);
    const out = await evalSmtlib(id, smt);
    console.log(`[smt#${n}<] ${out.slice(0, 200)}`);
    return out;
  };
  setModuleImports('main.js', {
    z3: { createContext, evalSmtlib: loggedEval, disposeContext },
  });
  const exports = await getAssemblyExports(getConfig().mainAssemblyName);
  await runMain();

  window.dafnyCheck = (src) => exports.DafnyWasm.DafnyHost.Check(src);
  window.dafnyVerify = (src) => exports.DafnyWasm.DafnyHost.Verify(src);
  window.dafnyDebugParse = (args) => exports.DafnyWasm.DafnyHost.DebugParseAsync(args);
  status('ready');
} catch (e) {
  status('failed: ' + e);
  console.error(e);
}
