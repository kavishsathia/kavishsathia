declare module "../../../public/fpga/worker-limits.js" {
  export function boundedLines(limit?: number): { push(line: unknown): void; text(): string; readonly length: number; readonly exceeded: boolean };
  export function readBounded(runtime: { FS: { stat(path: string): { size: number }; readFile(path: string, options?: unknown): unknown } }, path: string, maximum: number, label: string, options?: unknown): unknown;
}
