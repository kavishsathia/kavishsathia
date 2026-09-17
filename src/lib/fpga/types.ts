export type LogicValue = string;

export type WaveTransition = readonly [time: number, value: LogicValue];

export type WaveSignal = {
  id: string;
  name: string;
  path: string[];
  width: number;
  kind: string;
  transitions: WaveTransition[];
};

export type WaveData = {
  timescale: { multiplier: number; unit: "s" | "ms" | "us" | "ns" | "ps" | "fs" } | null;
  endTime: number;
  signals: WaveSignal[];
};

export type SimulationDiagnostic = {
  file: "design.v" | "testbench.v" | "engine";
  line?: number;
  message: string;
  severity: "error" | "warning";
};

export type SimulationResult = {
  vcd: string | null;
  stdout: string;
  diagnostics: SimulationDiagnostic[];
  elapsedMs: number;
};

export type WorkerRequest = {
  id: number;
  type: "run";
  design: string;
  testbench: string;
  generation: "2005" | "2009" | "2012";
};

export type WorkerResponse =
  | { id: number; type: "stage"; stage: "preprocessing" | "compiling" | "simulating" }
  | { id: number; type: "result"; result: SimulationResult }
  | { id: number; type: "error"; message: string };
