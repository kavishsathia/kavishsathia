export type FpgaExample = { name: string; label: string; design: string; testbench: string; outputs: string[] };

export const FPGA_EXAMPLES: FpgaExample[] = [
  {
    name: "counter",
    label: "clock divider + counter",
    outputs: ["tb.leds [3:0]"],
    design: `module fpga_top(
  input  wire       clk,
  input  wire       reset,
  output reg  [3:0] leds
);
  reg divided_clk;
  reg [1:0] divider;

  always @(posedge clk or posedge reset) begin
    if (reset) begin
      divider <= 0;
      divided_clk <= 0;
    end else if (divider == 2) begin
      divider <= 0;
      divided_clk <= ~divided_clk;
    end else begin
      divider <= divider + 1'b1;
    end
  end

  always @(posedge divided_clk or posedge reset)
    if (reset) leds <= 0;
    else leds <= leds + 1'b1;
endmodule`,
    testbench: `\`timescale 1ns/1ps
module tb;
  reg clk = 0;
  reg reset = 1;
  wire [3:0] leds;
  fpga_top dut(.clk(clk), .reset(reset), .leds(leds));

  always #5 clk = ~clk;
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
    #12 reset = 0;
    #220 $finish;
  end
endmodule`,
  },
  {
    name: "pwm",
    label: "4-bit PWM",
    outputs: ["tb.pwm", "tb.dut.phase [3:0]"],
    design: `module pwm4(input wire clk, input wire reset, input wire [3:0] duty, output wire pwm);
  reg [3:0] phase;
  always @(posedge clk or posedge reset)
    if (reset) phase <= 0;
    else phase <= phase + 1'b1;
  assign pwm = phase < duty;
endmodule`,
    testbench: `\`timescale 1ns/1ps
module tb;
  reg clk = 0, reset = 1;
  reg [3:0] duty = 4'd4;
  wire pwm;
  pwm4 dut(.clk(clk), .reset(reset), .duty(duty), .pwm(pwm));
  always #2 clk = ~clk;
  initial begin
    $dumpfile("dump.vcd"); $dumpvars(0, tb);
    #5 reset = 0; #64 duty = 4'd12; #64 $finish;
  end
endmodule`,
  },
  {
    name: "traffic",
    label: "traffic-light FSM",
    outputs: ["tb.red", "tb.amber", "tb.green"],
    design: `module traffic(input wire clk, input wire reset, output reg red, amber, green);
  reg [1:0] state;
  always @(posedge clk or posedge reset)
    if (reset) state <= 0;
    else if (state == 2) state <= 0;
    else state <= state + 1'b1;
  always @* begin
    red = state == 0; amber = state == 1; green = state == 2;
  end
endmodule`,
    testbench: `\`timescale 1ns/1ps
module tb;
  reg clk = 0, reset = 1;
  wire red, amber, green;
  traffic dut(.clk(clk), .reset(reset), .red(red), .amber(amber), .green(green));
  always #5 clk = ~clk;
  initial begin
    $dumpfile("dump.vcd"); $dumpvars(0, tb);
    #7 reset = 0; #70 $finish;
  end
endmodule`,
  },
];
