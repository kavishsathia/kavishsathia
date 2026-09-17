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
  await page.screenshot({ path: testInfo.outputPath("fpga-workspace.png"), fullPage: true });
  expect(errors).toEqual([]);
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
