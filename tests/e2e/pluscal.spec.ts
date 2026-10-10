import { expect, test, type Page } from "@playwright/test";

// One page for the whole file: the JVM boots once, as it would for a visitor,
// and every run after the first must start TLC from a clean slate.
test.describe.configure({ mode: "serial" });

let page: Page;
const errors: string[] = [];
const offsite: string[] = [];

test.beforeAll(async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop core-journey coverage");
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    // Same origin, and CheerpJ's runtime CDN; nothing else (no telemetry).
    if (host !== "127.0.0.1" && host !== "cjrtnc.leaningtech.com") offsite.push(r.url());
  });
  await page.goto("/tools/pluscal");
});

test.afterAll(async () => {
  await page?.close();
});

const verdict = () => page.getByTestId("pluscal-verdict");
const editorText = () => page.getByTestId("pluscal-editor").locator(".cm-content").innerText();

async function runExample(id: string) {
  await page.getByTestId(`pluscal-example-${id}`).click();
  await page.getByTestId("pluscal-check").click();
  await expect(page.getByTestId("pluscal-check")).toBeEnabled({ timeout: 90_000 });
}

test("Peterson: translates, then TLC checks safety and liveness", async () => {
  test.setTimeout(120_000);
  await runExample("peterson");
  await expect(verdict()).toContainText("no errors: every reachable state checked");
  await expect(page.getByTestId("pluscal-stats")).toContainText("42");
  expect(await editorText()).toContain("BEGIN TRANSLATION");
});

test("a missing await: invariant violation with a 7-state trace", async () => {
  test.setTimeout(60_000);
  await runExample("peterson-broken");
  await expect(verdict()).toContainText("invariant MutualExclusion violated");
  const trace = page.getByTestId("pluscal-trace");
  await expect(trace).toContainText("7 states");
  await expect(trace.locator("li").last()).toContainText('(0 :> "cs" @@ 1 :> "cs")');
  // Clicking a step selects its action in the source.
  await trace.getByRole("button", { name: /a3\(1\)/ }).click();
  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selection).toContain("turn' = 1 - self");
});

test("Die Hard: the counterexample is the puzzle's solution", async () => {
  test.setTimeout(60_000);
  await runExample("diehard");
  await expect(verdict()).toContainText("invariant NotSolved violated");
  await expect(page.getByTestId("pluscal-trace").locator("li").last()).toContainText(/big\s*4/);
});

test("liveness without fairness: a stuttering counterexample", async () => {
  test.setTimeout(60_000);
  await runExample("unfair");
  await expect(verdict()).toContainText("temporal property ReachesThree violated");
  await expect(page.getByTestId("pluscal-trace")).toContainText("stutters forever");
});

test("Community Modules: insertion sort holds on every input", async () => {
  test.setTimeout(60_000);
  await runExample("sort");
  await expect(verdict()).toContainText("no errors");
  await expect(page.getByTestId("pluscal-stats")).toContainText("189");
});

test("a PlusCal syntax error is located in the editor", async () => {
  test.setTimeout(60_000);
  await page.getByTestId("pluscal-example-unfair").click();
  const content = page.getByTestId("pluscal-editor").locator(".cm-content");
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    "---- MODULE Bad ----\nEXTENDS Naturals\n(* --algorithm Bad\nvariable x = 0;\nbegin\n  L: while x < 3 do x := x + 1; end whilst;\nend algorithm; *)\n====\n",
  );
  await page.getByTestId("pluscal-check").click();
  await expect(verdict()).toContainText("didn't translate", { timeout: 60_000 });
  await expect(page.getByTestId("pluscal-errors")).toContainText('Expected "while" but found "whilst"');
  await expect(page.getByTestId("pluscal-editor").locator(".cm-lintRange-error")).toHaveCount(1);
});

test("a TLA+ semantic error is reported by SANY, located", async () => {
  test.setTimeout(60_000);
  const content = page.getByTestId("pluscal-editor").locator(".cm-content");
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("---- MODULE Sem ----\nVARIABLE x\nInit == x = nope\nNext == x' = x\n====\n");
  await page.locator("#pluscal-cfg").fill("INIT Init\nNEXT Next\n");
  await page.getByTestId("pluscal-check").click();
  await expect(verdict()).toContainText("didn't parse", { timeout: 60_000 });
  await expect(page.getByTestId("pluscal-errors")).toContainText("Unknown operator: `nope'");
  await expect(page.getByTestId("pluscal-errors")).toContainText("Sem 3:13");
});

test("stop ends a long run, and the page stays responsive", async () => {
  test.setTimeout(120_000);
  const content = page.getByTestId("pluscal-editor").locator(".cm-content");
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    "---- MODULE Big ----\nEXTENDS Naturals\nVARIABLES x, y, z\nInit == x = 0 /\\ y = 0 /\\ z = 0\nNext == \\/ x' = (x + 1) % 1000 /\\ UNCHANGED <<y, z>>\n        \\/ y' = (y + 1) % 1000 /\\ UNCHANGED <<x, z>>\n        \\/ z' = (z + 1) % 1000 /\\ UNCHANGED <<x, y>>\nSpec == Init /\\ [][Next]_<<x, y, z>>\n====\n",
  );
  await page.locator("#pluscal-cfg").fill("SPECIFICATION Spec\n");
  await page.getByTestId("pluscal-check").click();
  // Live progress arrives while TLC runs.
  await expect
    .poll(async () => Number(((await page.getByTestId("pluscal-stats").innerText()).match(/distinct\s+([\d,]+)/)?.[1] ?? "0").replace(/,/g, "")), {
      timeout: 60_000,
    })
    .toBeGreaterThan(1000);
  const gap = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = performance.now();
        let worst = 0;
        let n = 0;
        const tick = () => {
          const now = performance.now();
          worst = Math.max(worst, now - last);
          last = now;
          if (++n < 60) setTimeout(tick, 0);
          else resolve(worst);
        };
        setTimeout(tick, 0);
      }),
  );
  expect(gap).toBeLessThan(250);
  await page.getByTestId("pluscal-stop").click();
  await expect(verdict()).toContainText("stopped", { timeout: 10_000 });
});

test("nothing was sent anywhere, and nothing threw", async () => {
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});
