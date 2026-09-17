import { describe, expect, it } from "vitest";
import { formatLogic, formatTime, parseVcdReplay, valueAt } from "./replay";

const VCD = `$timescale 1 ns $end
$scope module tb $end
$var wire 1 ! clk $end
$var wire 4 \" bus [3:0] $end
$var wire 1 # floating $end
$upscope $end
$enddefinitions $end
#0
0!
bx \"
z#
#5
1!
b1010 \"
#10
0!
bzzzz \"
`;

describe("VCD integration path", () => {
  it("preserves hierarchy, simulator timestamps, buses, X and Z", () => {
    const parsed = parseVcdReplay(VCD);
    expect(parsed.timescale).toEqual({ multiplier: 1, unit: "ns" });
    expect(parsed.endTime).toBe(10);
    expect(parsed.signals.map((signal) => `${signal.path.join(".")}.${signal.name}`)).toEqual([
      "tb.clk", "tb.bus [3:0]", "tb.floating",
    ]);
    expect(parsed.signals[0].transitions).toEqual([[0, "0"], [5, "1"], [10, "0"]]);
    expect(parsed.signals[1].transitions).toEqual([[0, "xxxx"], [5, "1010"], [10, "zzzz"]]);
  });

  it("uses exact step values at the cursor without interpolation", () => {
    const signal = parseVcdReplay(VCD).signals[1];
    expect(valueAt(signal, 4)).toBe("xxxx");
    expect(valueAt(signal, 5)).toBe("1010");
    expect(valueAt(signal, 9.999)).toBe("1010");
    expect(valueAt(signal, 10)).toBe("zzzz");
    expect(formatLogic("1010")).toBe("0xa");
    expect(formatTime(5, { multiplier: 1, unit: "ns" })).toBe("5 ns");
  });

  it("bounds excessive waveform transitions", () => {
    expect(() => parseVcdReplay(VCD, { maxSignals: 10, maxTransitions: 2 })).toThrow(/safety limit/);
  });
});
