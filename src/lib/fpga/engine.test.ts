import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_TIMEOUT_MS, SimulationLimitError, runSimulation } from "./engine";

class SilentWorker {
  static instances: SilentWorker[] = [];
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  terminated = false;

  constructor() { SilentWorker.instances.push(this); }
  postMessage() {}
  terminate() { this.terminated = true; }
}

describe("simulation process bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    SilentWorker.instances = [];
  });

  it("terminates the worker and rejects a runaway simulation at the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Worker", SilentWorker);
    const operation = runSimulation("module d; endmodule", "module tb; endmodule");
    const rejection = expect(operation.promise).rejects.toBeInstanceOf(SimulationLimitError);
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS);
    await rejection;
    expect(SilentWorker.instances[0].terminated).toBe(true);
  });

  it("terminates immediately when the user stops a run", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Worker", SilentWorker);
    const operation = runSimulation("module d; endmodule", "module tb; endmodule");
    operation.stop();
    await expect(operation.promise).rejects.toThrow("stopped by user");
    expect(SilentWorker.instances[0].terminated).toBe(true);
  });

  it("applies the source limit to encoded bytes rather than UTF-16 characters", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Worker", SilentWorker);
    const operation = runSimulation("é".repeat(140 * 1024), "module tb; endmodule");
    await expect(operation.promise).rejects.toThrow("256 KiB");
    expect(SilentWorker.instances).toHaveLength(0);
  });
});
