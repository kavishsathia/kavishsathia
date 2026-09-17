import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("default example runs through Icarus and exposes an interactive waveform", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop core-journey coverage");
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tools/fpga");
  await page.getByTestId("run-simulation").click();
  await expect(page.getByTestId("simulation-result")).toContainText("signals", { timeout: 20_000 });
  const surfer = page.frameLocator('[data-testid="surfer-viewer"]');
  await expect(surfer.locator("canvas#the_canvas_id")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("surfer-waveform-loaded")).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "clock edge ›" }).click();
  await expect(page.getByTestId("simulation-result")).not.toContainText("cursor 0");
  const selectedTick = await page.getByTestId("board-time-scrubber").inputValue();
  await expect.poll(() => surfer.locator("html").getAttribute("data-surfer-cursor")).toBe(selectedTick);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "VCD ↓" }).click();
  const download = await downloadPromise;
  const vcd = await readFile((await download.path())!, "utf8");
  expect(vcd).toMatch(/\$var\s+wire\s+4\s+\S+\s+leds\s+\[3:0\]/);
  expect(vcd).toMatch(/#65000[\s\S]*b1\s+\S+/);
  expect(vcd).toMatch(/#125000[\s\S]*b10\s+\S+/);
  await page.screenshot({ path: testInfo.outputPath("fpga-workspace.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("Surfer ignores wrong-origin and foreign-source commands", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop security probe");
  await page.goto("/tools/fpga");
  await page.getByTestId("run-simulation").click();
  await expect(page.getByTestId("surfer-waveform-loaded")).toBeAttached({ timeout: 20_000 });
  const frame = page.frameLocator('[data-testid="surfer-viewer"]');
  await page.getByTestId("board-time-scrubber").fill("15");
  await expect.poll(() => frame.locator("html").getAttribute("data-surfer-cursor")).toBe("15");
  await frame.locator("html").evaluate(() => {
    const command = { command: "InjectMessage", message: JSON.stringify({ CursorSet: 999 }) };
    window.dispatchEvent(new MessageEvent("message", { data: command, origin: window.location.origin, source: window }));
    window.dispatchEvent(new MessageEvent("message", { data: command, origin: "https://attacker.invalid", source: window.parent }));
  });
  await expect(frame.locator("html")).toHaveAttribute("data-surfer-cursor", "15");
});

test("an invalidated old run cannot overwrite empty or replacement state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop race coverage");
  await page.goto("/tools/fpga");
  const testbench = page.getByRole("region", { name: "TESTBENCH.V" }).locator(".cm-content");
  await testbench.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("module tb; reg clk=0; always #1 clk=~clk; initial begin $dumpfile(\"dump.vcd\"); $dumpvars(0,tb); end endmodule");
  await page.getByTestId("run-simulation").click();
  await expect(page.getByText("simulating…")).toBeVisible({ timeout: 20_000 });
  await testbench.click();
  await page.keyboard.type(" ");
  await expect(page.getByText("Run the example to generate a waveform.")).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.getByTestId("diagnostics")).toHaveCount(0);

  await page.getByLabel("Example").selectOption("1");
  await page.getByTestId("run-simulation").click();
  await expect(page.getByTestId("simulation-result")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Simulation failed. Fix the diagnostic and run again.")).toHaveCount(0);
});

test("a real runaway Icarus simulation is terminated after eight seconds", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop deadline coverage");
  test.setTimeout(25_000);
  await page.goto("/tools/fpga");
  const testbench = page.getByRole("region", { name: "TESTBENCH.V" }).locator(".cm-content");
  await testbench.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("module tb; reg clk=0; always #1 clk=~clk; initial begin $dumpfile(\"dump.vcd\"); $dumpvars(0,tb); end endmodule");
  const started = Date.now();
  await page.getByTestId("run-simulation").click();
  await expect(page.getByTestId("diagnostics")).toContainText("Simulation stopped after 8 seconds.", { timeout: 15_000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(7_500);
  expect(Date.now() - started).toBeLessThan(12_000);
  await expect(page.getByText("Simulation failed. Fix the diagnostic and run again.")).toBeVisible();
});

test("a source edit invalidates the completed waveform", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop integration coverage");
  await page.goto("/tools/fpga");
  await page.getByTestId("run-simulation").click();
  await expect(page.getByTestId("simulation-result")).toBeVisible({ timeout: 20_000 });
  const design = page.getByRole("region", { name: "DESIGN.V" }).locator(".cm-content");
  await design.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ");
  await expect(page.getByTestId("simulation-result")).toHaveCount(0);
  await expect(page.getByText("Run the example to generate a waveform.")).toBeVisible();
});

test("syntax errors are causal and leave no stale waveform", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop integration coverage");
  await page.goto("/tools/fpga");
  const design = page.getByRole("region", { name: "DESIGN.V" }).locator(".cm-content");
  await design.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("module broken(input wire clk) this is not verilog endmodule");
  await page.getByTestId("run-simulation").click();
  await expect(page.getByTestId("diagnostics")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("simulation-result")).toHaveCount(0);
  await expect(page.getByText("Simulation failed. Fix the diagnostic and run again.")).toBeVisible();
});

test("real Icarus output preserves bus X and Z values", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop integration coverage");
  await page.goto("/tools/fpga");
  const testbench = page.getByRole("region", { name: "TESTBENCH.V" }).locator(".cm-content");
  await testbench.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(`\`timescale 1ns/1ps
module tb;
  reg [3:0] probe;
  initial begin
    $dumpfile("dump.vcd"); $dumpvars(0, tb);
    probe = 4'bxxxx; #5 probe = 4'b1010; #5 probe = 4'bzzzz; #5 $finish;
  end
endmodule`);
  await page.getByTestId("run-simulation").click();
  await expect(page.getByTestId("surfer-waveform-loaded")).toBeAttached({ timeout: 20_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "VCD ↓" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const vcd = await readFile(path!, "utf8");
  expect(vcd).toMatch(/bx\s+\S+/i);
  expect(vcd).toMatch(/b1010\s+\S+/i);
  expect(vcd).toMatch(/bz\s+\S+/i);
});

test("narrow layout keeps the full journey reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only inspection");
  await page.goto("/tools/fpga");
  const run = page.getByTestId("run-simulation");
  await run.scrollIntoViewIfNeeded();
  await expect(run).toBeInViewport();
  await run.click({ position: { x: 12, y: 12 } });
  await expect(page.getByTestId("simulation-result")).toBeVisible({ timeout: 20_000 });
  await expect(page.frameLocator('[data-testid="surfer-viewer"]').locator("canvas#the_canvas_id")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("surfer-waveform-loaded")).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("fpga-mobile.png"), fullPage: true });
});
