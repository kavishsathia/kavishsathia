import type { SimulationResult, WorkerRequest, WorkerResponse } from "./types";

const SOURCE_LIMIT = 256 * 1024;
export const RUN_TIMEOUT_MS = 8_000;

export class SimulationLimitError extends Error {}

export type SimulationStage = "preprocessing" | "compiling" | "simulating";

export function runSimulation(
  design: string,
  testbench: string,
  generation: WorkerRequest["generation"] = "2012",
  onStage?: (stage: SimulationStage) => void,
): { promise: Promise<SimulationResult>; stop: () => void } {
  if (new TextEncoder().encode(design).byteLength + new TextEncoder().encode(testbench).byteLength > SOURCE_LIMIT) {
    return {
      promise: Promise.reject(new SimulationLimitError("Combined source exceeds the 256 KiB limit.")),
      stop: () => {},
    };
  }

  const worker = new Worker("/fpga/fpga-worker.js", { type: "module", name: "icarus-verilog" });
  const id = Date.now();
  let settled = false;
  let rejectPromise: (error: Error) => void = () => {};
  const finish = () => {
    settled = true;
    window.clearTimeout(timer);
    worker.terminate();
  };
  const promise = new Promise<SimulationResult>((resolve, reject) => {
    rejectPromise = reject;
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The Icarus worker failed to load."));
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.type === "stage") onStage?.(event.data.stage);
      if (event.data.type === "result") {
        finish();
        resolve(event.data.result);
      }
      if (event.data.type === "error") {
        finish();
        reject(new Error(event.data.message));
      }
    };
    worker.postMessage({ id, type: "run", design, testbench, generation } satisfies WorkerRequest);
  });
  const timer = window.setTimeout(() => {
    if (settled) return;
    finish();
    rejectPromise(new SimulationLimitError(`Simulation stopped after ${RUN_TIMEOUT_MS / 1000} seconds.`));
  }, RUN_TIMEOUT_MS);

  return {
    promise,
    stop: () => {
      if (settled) return;
      finish();
      rejectPromise(new SimulationLimitError("Simulation stopped by user."));
    },
  };
}
