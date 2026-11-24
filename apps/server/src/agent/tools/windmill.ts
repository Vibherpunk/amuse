import { check, markUntrustedRead } from "../sentinel";
import { windmillBaseUrl, windmillToken, windmillWorkspace } from "../../lib/config";
import { obj, str, type ToolDef } from "./types";

/**
 * Windmill on the person's own instance (operator-configured base URL + scoped token).
 * The instance lives on their LAN/tailnet, which the public egress guard rightly refuses
 * for agent-chosen URLs — so this is a dedicated client, like the audio/image clients:
 * the agent supplies only a flow path and arguments, never a destination. The workspace
 * always comes from config, never from the model.
 */

function configured() {
  return !!(windmillBaseUrl && windmillWorkspace && windmillToken);
}

async function wm(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${windmillBaseUrl!.replace(/\/$/, "")}/api/w/${windmillWorkspace}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${windmillToken}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`Windmill ${res.status}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const NOT_CONFIGURED = { error: "Windmill isn't configured on this install (AMUSE_WINDMILL_* env is incomplete)." };

export const windmillTools: ToolDef[] = [
  {
    name: "windmill_list_flows",
    skill: "Windmill",
    status: "Listing your Windmill flows",
    subagentSafe: true,
    description: "List the flows in the person's Windmill workspace (path + summary). Read-only.",
    parameters: obj({}),
    async run(_a, ctx) {
      if (!configured()) return NOT_CONFIGURED;
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "windmill_list_flows",
        actionClass: "read",
        target: "windmill",
        purpose: "List your Windmill flows",
        connectorMode: "some",
      });
      if (ok === "deny") return { error: "Denied" };
      markUntrustedRead(ctx.runId);
      const rows = await wm("/flows/list");
      const flows = (Array.isArray(rows) ? rows : []).slice(0, 100).map((f: any) => ({ path: f.path, summary: f.summary ?? "", edited_by: f.edited_by ?? undefined }));
      await ctx.activity("connector", `Listed ${flows.length} Windmill flows`, {}, "Windmill");
      return { untrusted_data: true, workspace: windmillWorkspace, flows };
    },
  },
  {
    name: "windmill_list_scripts",
    skill: "Windmill",
    status: "Listing your Windmill scripts",
    subagentSafe: true,
    description: "List the scripts in the person's Windmill workspace (path + summary + language). Read-only.",
    parameters: obj({}),
    async run(_a, ctx) {
      if (!configured()) return NOT_CONFIGURED;
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "windmill_list_scripts",
        actionClass: "read",
        target: "windmill",
        purpose: "List your Windmill scripts",
        connectorMode: "some",
      });
      if (ok === "deny") return { error: "Denied" };
      markUntrustedRead(ctx.runId);
      const rows = await wm("/scripts/list");
      const scripts = (Array.isArray(rows) ? rows : []).slice(0, 100).map((s: any) => ({ path: s.path, summary: s.summary ?? "", language: s.language ?? undefined }));
      await ctx.activity("connector", `Listed ${scripts.length} Windmill scripts`, {}, "Windmill");
      return { untrusted_data: true, workspace: windmillWorkspace, scripts };
    },
  },
  {
    name: "windmill_run_flow",
    skill: "Windmill",
    status: "Starting a Windmill flow",
    description:
      "Run a flow in the person's Windmill workspace and return the job id. This starts real automation, so the person approves each run first. Use windmill_job_result with the returned job id to fetch the outcome.",
    parameters: obj({ path: str("Flow path, e.g. f/folder/my_flow"), args: { type: "object", additionalProperties: true, description: "Flow arguments" } }, ["path"]),
    async run(a, ctx) {
      if (!configured()) return NOT_CONFIGURED;
      const flowPath = String(a.path ?? "").replace(/^\//, "");
      if (!flowPath) return { error: "Missing flow path" };
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "windmill_run_flow",
        actionClass: "write",
        target: `windmill:${flowPath}`,
        purpose: `Run Windmill flow ${flowPath}`,
        details: { path: flowPath, args: a.args ?? {} },
        connectorMode: "some",
      });
      if (ok === "deny") return { error: "The person denied this run." };
      const jobId = await wm(`/jobs/run/f/${flowPath.split("/").map(encodeURIComponent).join("/")}`, {
        method: "POST",
        body: JSON.stringify(a.args ?? {}),
      });
      await ctx.activity("connector", `Started Windmill flow ${flowPath} (job ${String(jobId).slice(0, 60)})`, { path: flowPath, job: jobId }, "Windmill");
      return { untrusted_data: true, job_id: jobId, path: flowPath };
    },
  },
  {
    name: "windmill_job_result",
    skill: "Windmill",
    status: "Checking a Windmill job",
    subagentSafe: true,
    description: "Get the outcome of a Windmill job started earlier. Optionally wait a few seconds for it to finish.",
    parameters: obj({ job_id: str("Job id returned by windmill_run_flow"), wait_seconds: { type: "number", description: "Wait up to this long for completion (default 0, max 25)" } }, ["job_id"]),
    async run(a, ctx) {
      if (!configured()) return NOT_CONFIGURED;
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "windmill_job_result",
        actionClass: "read",
        target: "windmill",
        purpose: "Read a Windmill job result",
        connectorMode: "some",
      });
      if (ok === "deny") return { error: "Denied" };
      markUntrustedRead(ctx.runId);
      const wait = Math.min(Math.max(Number(a.wait_seconds ?? 0) || 0, 0), 25);
      const deadline = Date.now() + wait * 1000;
      for (;;) {
        try {
          const job = await wm(`/jobs_u/completed/${encodeURIComponent(String(a.job_id))}`);
          return {
            untrusted_data: true,
            completed: true,
            success: job?.success ?? undefined,
            result: job?.result ?? null,
            canceled: job?.canceled ?? false,
          };
        } catch (e) {
          if (Date.now() >= deadline) return { untrusted_data: true, completed: false, note: `Job not completed yet (${(e as Error).message.slice(0, 160)})` };
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    },
  },
];
