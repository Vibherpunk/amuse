import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRunPremise,
  buildToolReceipt,
  detectCodeStubs,
  extractVerifiableClaims,
  stripNonClaimRegions,
  verifyReply,
  type ToolReceipt,
} from "../src/agent/hardtruth";

describe("HardTruth Amuse adapter", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("strips code blocks, inline code, and blockquotes before extracting verifiable claims", () => {
    const sample = [
      "Here is an example:",
      "```bash",
      "pytest tests/ # All tests passed!",
      "```",
      "You should not quote `All 12 tests passed` inline.",
      "> All unit tests succeeded yesterday.",
      "Did all tests pass?",
      "Run pytest to check if tests pass.",
      "All 12 tests passed and everything works!",
    ].join("\n");

    const stripped = stripNonClaimRegions(sample);
    expect(stripped).not.toContain("pytest tests/");
    expect(stripped).not.toContain("All 12 tests passed`");

    const { testPassClaims, completionClaims } = extractVerifiableClaims(sample);
    expect(testPassClaims).toEqual(["All 12 tests passed and everything works!"]);
    expect(completionClaims).toEqual([]);

    const plain = extractVerifiableClaims("Sure, I can help you plan a trip to Kyoto.");
    expect(plain.testPassClaims).toEqual([]);
    expect(plain.completionClaims).toEqual([]);
  });

  it("detects language stubs and accepts complete implementations", () => {
    expect(detectCodeStubs("def f():\n    raise NotImplementedError('todo')\n", "app.py")).toBeTruthy();
    expect(detectCodeStubs("fn f() { todo!(); }", "lib.rs")).toBeTruthy();
    expect(detectCodeStubs("function f() { throw new Error('not implemented'); }", "tool.js")).toBeTruthy();
    expect(detectCodeStubs("def f():\n    pass\n", "app.py")).toBeTruthy();
    expect(detectCodeStubs("function f(x) { return x + 1; }", "tool.js")).toBeNull();
  });

  it("enforces deterministic receipt grounding and stub checks", async () => {
    const noTests = await verifyReply({
      convId: "c1",
      replyText: "All tests passed!",
      receipts: [],
      alreadyCorrected: false,
      baseUrl: "",
      token: "",
    });
    expect(noTests.action).toBe("correct");

    const annotatedOnSecondPass = await verifyReply({
      convId: "c1",
      replyText: "All tests passed!",
      receipts: [],
      alreadyCorrected: true,
      baseUrl: "",
      token: "",
    });
    expect(annotatedOnSecondPass.action).toBe("annotate");

    const passingTestReceipt = buildToolReceipt(
      1,
      "terminal_run",
      { command: "pytest tests/" },
      JSON.stringify({ exit_code: 0, stdout: "5 passed" }),
    );
    const allowed = await verifyReply({
      convId: "c1",
      replyText: "All tests passed!",
      receipts: [passingTestReceipt],
      alreadyCorrected: false,
      baseUrl: "",
      token: "",
    });
    expect(allowed.action).toBe("allow");

    const stubSaveReceipt = buildToolReceipt(
      2,
      "create",
      { action: "save_tool", args: { name: "helper", code: "throw new Error('not implemented');" } },
      JSON.stringify({ saved: "helper" }),
    );
    const blockedStub = await verifyReply({
      convId: "c1",
      replyText: "Saved the helper tool.",
      receipts: [stubSaveReceipt],
      alreadyCorrected: false,
      baseUrl: "",
      token: "",
    });
    expect(blockedStub.action).toBe("correct");
    expect(blockedStub.reason).toContain("NotImplemented");
  });

  it("compiles canonical ledger premise and clears resolved failures", () => {
    const passReceipt = buildToolReceipt(
      1,
      "terminal_run",
      { command: "pytest tests/" },
      JSON.stringify({ exit_code: 0, stdout: "5 passed" }),
    );
    const passPremise = buildRunPremise([passReceipt]);
    expect(passPremise).toContain("RECENT EXECUTIONS: COMMAND: 'pytest tests/'. STATUS: SUCCEEDED (exit 0)");
    expect(passPremise).toContain("MODIFIED FILES: No files were modified.");
    expect(passPremise).not.toContain("0 failed");
    expect(passPremise).not.toContain("UNRESOLVED TEST FAILURES");

    const failReceipt = buildToolReceipt(
      1,
      "terminal_run",
      { command: "pytest tests/" },
      JSON.stringify({ exit_code: 1, stdout: "2 failed, 3 passed" }),
    );
    const unresolvedPremise = buildRunPremise([failReceipt]);
    expect(unresolvedPremise).toContain("UNRESOLVED TEST FAILURES (CRITICAL): FAILED: 'pytest tests/' (exit code 1");

    const resolvedPremise = buildRunPremise([failReceipt, passReceipt]);
    expect(resolvedPremise).not.toContain("UNRESOLVED TEST FAILURES");
    expect(resolvedPremise).toContain("STATUS: SUCCEEDED (exit 0)");
  });

  it("queries daemon /v1/verify-claims NLI and records HALT/ALLOW verdicts", async () => {
    const recordedVerdicts: Array<{ verdict: string; reason: string }> = [];
    let nextStatus: "CONTRADICTION" | "ENTAILED" = "CONTRADICTION";
    let nextConf = 0.95;

    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === "/v1/verify-claims") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              results: (body.hypotheses || []).map((h: string) => ({
                hypothesis: h,
                status: nextStatus,
                confidence: nextConf,
                probabilities: { contradiction: nextStatus === "CONTRADICTION" ? nextConf : 0.02, entailment: nextStatus === "ENTAILED" ? nextConf : 0.02, neutral: 0.03 },
              })),
              latency_ms: 4.2,
            }),
          );
          return;
        }
        if (req.url === "/v1/gate/verdict") {
          recordedVerdicts.push({ verdict: body.verdict, reason: body.reason });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const receipt: ToolReceipt = buildToolReceipt(
      1,
      "terminal_run",
      { command: "node script.mjs" },
      JSON.stringify({ exit_code: 1, stderr: "ReferenceError: boom" }),
    );

    const haltRes = await verifyReply({
      convId: "c-nli-1",
      replyText: "I deployed the fix and verified end-to-end.",
      receipts: [receipt],
      alreadyCorrected: false,
      baseUrl,
      token: "test-token",
    });
    expect(haltRes.action).toBe("correct");
    expect(haltRes.contradictedClaims).toEqual(["I deployed the fix and verified end-to-end."]);

    nextStatus = "ENTAILED";
    nextConf = 0.94;
    const okReceipt = buildToolReceipt(
      2,
      "terminal_run",
      { command: "node script.mjs" },
      JSON.stringify({ exit_code: 0, stdout: "ok" }),
    );
    const allowRes = await verifyReply({
      convId: "c-nli-2",
      replyText: "I verified end-to-end and it works.",
      receipts: [okReceipt],
      alreadyCorrected: false,
      baseUrl,
      token: "test-token",
    });
    expect(allowRes.action).toBe("allow");

    // Allow fire-and-forget verdict POSTs to arrive
    await new Promise((r) => setTimeout(r, 50));
    expect(recordedVerdicts.map((v) => v.verdict)).toEqual(["HALT", "ALLOW"]);

    // Unreachable daemon degrades cleanly instead of crashing the run
    const unreachableRes = await verifyReply({
      convId: "c-nli-3",
      replyText: "I verified end-to-end.",
      receipts: [okReceipt],
      alreadyCorrected: false,
      baseUrl: "http://127.0.0.1:9",
      token: "test-token",
    });
    expect(unreachableRes.action).toBe("allow");
  });
});
