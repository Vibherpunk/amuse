import { check } from "../sentinel";
import { conversationIdForRun, isHardTruthEnabled } from "../hardtruth";
import { terminalBaseUrl, terminalToken } from "../../lib/config";
import { obj, str, num, type ToolDef } from "./types";

/**
 * Terminal on the person's Mac. The Amuse container is a sandbox, so commands are run by a
 * small executor service on the host (operator-configured URL, like the image shim). Every
 * command is proposed to the sentinel with forceAsk: the person sees the exact command on an
 * approval card (once/deny only — no standing grants) before anything executes.
 */
export const terminalTools: ToolDef[] = [
  {
    name: "terminal_run",
    skill: "Terminal",
    status: "Running a command on your Mac",
    description:
      "Run a shell command on the person's Mac (the host machine, as their own user, zsh login shell). Use it to inspect the system, files, projects and services on their Mac. The person must approve each exact command before it runs — expect them to read it, so keep commands single-purpose and unsurprising. Runs in their home directory unless cwd is given. Output is truncated; long-running commands are killed at the timeout.",
    parameters: obj(
      {
        command: str("The shell command to run"),
        cwd: str("Absolute working directory (default: their home directory)"),
        timeout_seconds: num("Kill after this many seconds (default 60, max 300)"),
      },
      ["command"],
    ),
    async run(a, ctx) {
      if (!terminalBaseUrl) return { error: "The terminal isn't configured on this install (AMUSE_TERMINAL_URL is not set)." };
      const command = String(a.command ?? "").trim();
      if (!command) return { error: "Empty command" };
      const timeout = Math.min(Math.max(Number(a.timeout_seconds ?? 60) || 60, 1), 300);
      const ok = await check({
        userId: ctx.userId,
        runId: ctx.runId,
        chatId: ctx.chatId,
        toolName: "terminal_run",
        actionClass: "write",
        target: "mac-host",
        purpose: `Run on your Mac: ${command.slice(0, 300)}`,
        details: { command, cwd: a.cwd ?? null, timeout_seconds: timeout },
        forceAsk: true,
      });
      if (ok === "deny") return { error: "The person denied this command. Do not retry it or a close variant without asking them in chat first." };
      await ctx.setStatus("Running a command on your Mac");
      let out: any;
      try {
        const res = await fetch(`${terminalBaseUrl.replace(/\/$/, "")}/exec`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-amuse-terminal-token": terminalToken },
          body: JSON.stringify({
            command,
            cwd: a.cwd,
            timeout_seconds: timeout,
            conversation_id: conversationIdForRun(ctx.chatId, ctx.runId),
            record_ledger: !isHardTruthEnabled(),
          }),
          signal: AbortSignal.timeout((timeout + 20) * 1000),
        });
        out = await res.json();
        if (!res.ok) {
          if (res.status === 403 && out?.blocked_by === "hardtruth") {
            return { error: `HardTruth blocked this command: ${out.error}` };
          }
          return { error: `Terminal executor error (${res.status}): ${out?.error ?? "unknown"}` };
        }
      } catch (e) {
        return { error: `Terminal executor unreachable: ${(e as Error).message}` };
      }
      await ctx.activity("tool", `Terminal: ${command.slice(0, 120)} → exit ${out.exit_code ?? "?"}`, { command, exit_code: out.exit_code, cwd: out.cwd }, "Terminal");
      return { untrusted_data: true, ...out };
    },
  },
];
