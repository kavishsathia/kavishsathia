import { describe, expect, it, vi } from "vitest";
import { boundedLines, readBounded } from "../../../public/fpga/worker-limits.js";

describe("worker artifact limits", () => {
  it("rejects an oversized MEMFS artifact before converting or copying it", () => {
    const readFile = vi.fn();
    const runtime = { FS: { stat: () => ({ size: 11 }), readFile } };
    expect(() => readBounded(runtime, "/dump.vcd", 10, "Waveform", { encoding: "utf8" })).toThrow(/limit/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("captures console output with a running length bound", () => {
    const output = boundedLines(5);
    output.push("abc"); output.push("def"); output.push("ignored");
    expect(output.text()).toBe("abc\nd");
    expect(output.length).toBe(5);
  });
});
