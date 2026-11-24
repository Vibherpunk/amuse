import { describe, expect, it } from "vitest";
import { hasUntrustedHistory, type HistoryMessage } from "../src/agent/history";
import { toolAllowed, type ConnectedMcpServer, type McpRegistryState } from "../src/agent/mcp";
import { hasActionEvidence } from "../src/agent/robustness";
import { buildPresentedTools, buildSubagentTools, normalizeGoogleArgs, resolveGoogleAccount } from "../src/agent/tools/gateways";
import type { ToolDef } from "../src/agent/tools/types";
import { toInput } from "../src/lib/llm";
import { credentialPlacementError, redactSecretForms } from "../src/lib/vault";

const dummyTool = (name: string): ToolDef => ({
  name,
  skill: name,
  status: name,
  description: name,
  parameters: { type: "object", properties: {} },
  async run() {
    return { ok: true };
  },
});

function makeMcpServer(name: string, tools: string[]): ConnectedMcpServer {
  const infos = tools.map((t) => ({ name: t, description: t, inputSchema: { type: "object", properties: {} } }));
  const defs = tools.map((t) => dummyTool(`mcp__${name}__${t}`));
  return {
    name,
    source: "db",
    allowlist: null,
    client: {} as any,
    offeredInfos: infos,
    discoveredCount: tools.length,
    defs,
    byRawName: new Map(tools.map((t, i) => [t, defs[i]!])),
  };
}

function makeMcpState(entries: ConnectedMcpServer[]): McpRegistryState {
  const servers = new Map(entries.map((s) => [s.name, s]));
  const tools = entries.flatMap((s) => s.defs);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, byName, servers, statuses: [], usingBootstrap: false };
}

describe("sub-10 gateway menu assembly", () => {
  const subagent = dummyTool("spawn_subagents");
  const notify = dummyTool("notify");

  it("presents 6 core tools when no MCP servers are connected", () => {
    const menu = buildPresentedTools({
      background: false,
      mcpState: makeMcpState([]),
      subagentTool: subagent,
      notifyTool: notify,
      fullMenu: false,
    });
    expect(menu.map((t) => t.name)).toEqual(["terminal_run", "files", "web", "connectors", "workspace", "create"]);
    expect(menu.length).toBeLessThan(10);
  });

  it("presents 7 tools with Windmill only and respects allowlisted actions", () => {
    const wm = makeMcpServer("windmill", ["list_workspace_items", "run_flow", "get_run"]);
    const menu = buildPresentedTools({
      background: false,
      mcpState: makeMcpState([wm]),
      subagentTool: subagent,
      notifyTool: notify,
      fullMenu: false,
    });
    expect(menu.map((t) => t.name)).toEqual(["terminal_run", "files", "web", "windmill", "connectors", "workspace", "create"]);
    const wmTool = menu.find((t) => t.name === "windmill")!;
    expect((wmTool.parameters as any).properties.action.enum).toEqual(["list", "run_flow", "get_run"]);
    expect(menu.length).toBeLessThan(10);
  });

  it("presents 8 tools with Composio and Windmill connected", () => {
    const comp = makeMcpServer("composio", ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"]);
    const wm = makeMcpServer("windmill", ["list_workspace_items", "run_flow", "run_script", "get_run"]);
    const menu = buildPresentedTools({
      background: true,
      mcpState: makeMcpState([comp, wm]),
      subagentTool: subagent,
      notifyTool: notify,
      fullMenu: false,
    });
    expect(menu.map((t) => t.name)).toEqual(["terminal_run", "files", "web", "google", "windmill", "connectors", "workspace", "create"]);
    expect(menu.length).toBe(8);
    expect(menu.length).toBeLessThan(10);
    const wsTool = menu.find((t) => t.name === "workspace")!;
    expect((wsTool.parameters as any).properties.action.enum).toContain("notify");
  });

  it("presents 9 tools (still < 10) when an extra non-Composio/non-Windmill MCP server is connected", () => {
    const comp = makeMcpServer("composio", ["COMPOSIO_SEARCH_TOOLS"]);
    const wm = makeMcpServer("windmill", ["list_workspace_items"]);
    const extra = makeMcpServer("proof", ["echo", "add"]);
    const menu = buildPresentedTools({
      background: false,
      mcpState: makeMcpState([comp, wm, extra]),
      subagentTool: subagent,
      notifyTool: notify,
      fullMenu: false,
    });
    expect(menu.map((t) => t.name)).toEqual(["terminal_run", "files", "web", "google", "windmill", "connectors", "workspace", "create", "mcp"]);
    expect(menu.length).toBe(9);
    expect(menu.length).toBeLessThan(10);
  });

  it("compacts large extra MCP servers (e.g. 47-tool umbrel) inside the 9th mcp gateway and lists all tools", async () => {
    const comp = makeMcpServer("composio", ["COMPOSIO_SEARCH_TOOLS"]);
    const wm = makeMcpServer("windmill", ["list_workspace_items", "run_flow", "run_script", "get_run"]);
    const umbrelTools = Array.from({ length: 47 }, (_, i) => `umbrel_tool_${i + 1}`);
    const umbrel = makeMcpServer("umbrel", umbrelTools);
    const menu = buildPresentedTools({
      background: false,
      mcpState: makeMcpState([comp, wm, umbrel]),
      subagentTool: subagent,
      notifyTool: notify,
      fullMenu: false,
    });
    expect(menu.map((t) => t.name)).toEqual(["terminal_run", "files", "web", "google", "windmill", "connectors", "workspace", "create", "mcp"]);
    expect(menu.length).toBe(9);
    expect(menu.length).toBeLessThan(10);
    const mcpGateway = menu.find((t) => t.name === "mcp")!;
    expect(mcpGateway.description.length).toBeLessThan(600);
    expect(mcpGateway.description).toContain("umbrel");
    expect(mcpGateway.description).toContain("47 tools");
    const listed = (await mcpGateway.run({ action: "list" }, {} as any)) as any;
    expect(listed.servers).toHaveLength(1);
    expect(listed.servers[0].tools).toHaveLength(47);
  });

  it("restores the full ungrouped menu when fullMenu flag is true", () => {
    const comp = makeMcpServer("composio", ["COMPOSIO_SEARCH_TOOLS"]);
    const wm = makeMcpServer("windmill", ["list_workspace_items"]);
    const menu = buildPresentedTools({
      background: false,
      mcpState: makeMcpState([comp, wm]),
      subagentTool: subagent,
      notifyTool: notify,
      fullMenu: true,
    });
    expect(menu.length).toBeGreaterThan(40);
    expect(menu.some((t) => t.name === "mcp__composio__COMPOSIO_SEARCH_TOOLS")).toBe(true);
    expect(menu.some((t) => t.name === "mcp__windmill__list_workspace_items")).toBe(true);
  });

  it("presents sub-10 subagent gateway tools", () => {
    const sub = buildSubagentTools(false);
    expect(sub.map((t) => t.name)).toEqual(["files", "web", "create"]);
  });

  it("keeps all gateway tool schemas flat without nested object properties or nested additionalProperties", () => {
    const comp = makeMcpServer("composio", ["COMPOSIO_SEARCH_TOOLS"]);
    const wm = makeMcpServer("windmill", ["list_workspace_items", "run_flow", "run_script", "get_run"]);
    const extra = makeMcpServer("proof", ["echo", "add"]);
    const menus = [
      buildPresentedTools({ background: false, mcpState: makeMcpState([]), subagentTool: subagent, notifyTool: notify, fullMenu: false }),
      buildPresentedTools({ background: true, mcpState: makeMcpState([comp, wm, extra]), subagentTool: subagent, notifyTool: notify, fullMenu: false }),
      buildSubagentTools(false),
    ];
    for (const menu of menus) {
      for (const tool of menu) {
        const props = ((tool.parameters as any)?.properties ?? {}) as Record<string, any>;
        for (const [key, schema] of Object.entries(props)) {
          expect(schema.type, `${tool.name}.${key} type`).not.toBe("object");
          expect(schema.additionalProperties, `${tool.name}.${key} additionalProperties`).toBeUndefined();
          if (schema.items) {
            expect(schema.items.type, `${tool.name}.${key}.items.type`).not.toBe("object");
            expect(schema.items.additionalProperties, `${tool.name}.${key}.items.additionalProperties`).toBeUndefined();
          }
        }
      }
    }
  });
});

describe("toInput user turn coalescing for Gemma 4 template", () => {
  it("coalesces consecutive user turns and json instruction into a single user turn", () => {
    const res = toInput(
      [
        { role: "system", content: "Sys" },
        { role: "user", content: "First message" },
        { role: "user", content: "Second message" },
      ],
      true,
    );
    expect(res.input).toEqual([
      { role: "user", content: "First message\n\nSecond message\n\nRespond with a single valid JSON object only." },
    ]);
  });
});

describe("MCP allowlist matching", () => {
  it("supports exact names, trailing wildcards, and unfiltered null/undefined", () => {
    expect(toolAllowed(undefined, "anything")).toBe(true);
    expect(toolAllowed(null, "anything")).toBe(true);
    expect(toolAllowed(["list_workspace_items", "run_*"], "list_workspace_items")).toBe(true);
    expect(toolAllowed(["list_workspace_items", "run_*"], "run_flow")).toBe(true);
    expect(toolAllowed(["list_workspace_items", "run_*"], "delete_script")).toBe(false);
  });
});

describe("gateway tainting, recovery evidence, and vault invariants", () => {
  const msgFor = (name: string): HistoryMessage[] => [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "data" },
  ];

  it("taints external gateways and leaves local gateways untainted", () => {
    for (const ext of ["web", "google", "windmill", "connectors", "mcp"]) {
      expect(hasUntrustedHistory([{ parts: [{ type: "tool_history", messages: msgFor(ext) }] }])).toBe(true);
    }
    for (const local of ["files", "workspace", "create"]) {
      expect(hasUntrustedHistory([{ parts: [{ type: "tool_history", messages: msgFor(local) }] }])).toBe(false);
    }
  });

  it("detects external action evidence for gateway tools", () => {
    for (const name of ["connectors", "google", "windmill", "mcp"]) {
      expect(hasActionEvidence([], [], [name])).toBe(true);
    }
  });

  it("preserves surrogate placement and secret redaction fences", () => {
    const secret = "VaultTestSecret_987654";
    expect(redactSecretForms(`Header: Bearer ${secret}`, secret, "amuse_sur_x")).toBe("Header: Bearer amuse_sur_x");
    expect(credentialPlacementError("https://api.example.com/?t=amuse_sur_x", undefined, {})).toMatch(/never URLs/);
  });
});

describe("google calendar recurrence and extra_json passthrough", () => {
  it("preserves recurrence array on calendar_create", () => {
    const res = normalizeGoogleArgs(
      "calendar_create",
      {
        summary: "Saturday Hiking Club",
        start_datetime: "2026-11-28T09:30:00-08:00",
        end_datetime: "2026-11-28T11:00:00-08:00",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=SA"],
      },
      "America/Los_Angeles",
    );
    expect(res.error).toBeUndefined();
    expect(res.args?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=SA"]);
  });

  it("normalizes bare RRULE string on calendar_update", () => {
    const res = normalizeGoogleArgs(
      "calendar_update",
      {
        event_id: "evt_123",
        recurrence: "FREQ=WEEKLY;BYDAY=TU",
      },
      "America/Los_Angeles",
    );
    expect(res.error).toBeUndefined();
    expect(res.args?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU"]);
  });

  it("forwards extra_json fields like color_id, visibility, and custom keys", () => {
    const res = normalizeGoogleArgs(
      "calendar_update",
      {
        event_id: "evt_123",
        color_id: "5",
        visibility: "private",
        guests_can_modify: true,
      },
      "America/Los_Angeles",
    );
    expect(res.error).toBeUndefined();
    expect(res.args?.color_id).toBe("5");
    expect(res.args?.visibility).toBe("private");
    expect(res.args?.guests_can_modify).toBe(true);
  });

  it("forwards extra_json fields on gmail_search and calendar_list", () => {
    const g = normalizeGoogleArgs("gmail_search", { query: "invoice", user_id: "me", custom_flag: 1 }, "America/Los_Angeles");
    expect(g.args?.user_id).toBe("me");
    expect(g.args?.custom_flag).toBe(1);

    const c = normalizeGoogleArgs("calendar_list", { showDeleted: true, calendar_id: "primary" }, "America/Los_Angeles");
    expect(c.args?.showDeleted).toBe(true);
    expect(c.args?.calendarId).toBe("primary");
  });

  it("resolves Google account aliases even when Composio returns empty alias strings", () => {
    const accounts = [
      { alias: "", id: "gmail_test1", email: "accounting@property.example.com", name: null, status: "ACTIVE", is_default: false },
      { alias: "", id: "gmail_test2", email: "admissions@school.example.com", name: null, status: "ACTIVE", is_default: false },
      { alias: "", id: "gmail_test3", email: "leo@property.example.com", name: null, status: "ACTIVE", is_default: false },
      { alias: "", id: "gmail_test4", email: "owner@school.example.com", name: null, status: "ACTIVE", is_default: false },
      { alias: "", id: "gmail_test5", email: "office@school.example.com", name: null, status: "ACTIVE", is_default: false },
      { alias: "", id: "gmail_test6", email: "owner@property.example.com", name: null, status: "ACTIVE", is_default: false },
      { alias: "", id: "gmail_test7", email: "owner@example.com", name: null, status: "ACTIVE", is_default: false },
    ];
    expect(resolveGoogleAccount("harwell", accounts, "gmail").account?.id).toBe("gmail_har");
    expect(resolveGoogleAccount("personal", accounts, "gmail").account?.id).toBe("gmail_per");
    expect(resolveGoogleAccount("inception", accounts, "gmail").account?.id).toBe("gmail_inc");
    expect(resolveGoogleAccount("friday", accounts, "gmail").account?.id).toBe("gmail_fri");
    expect(resolveGoogleAccount("admissions", accounts, "gmail").account?.id).toBe("gmail_adm");
    expect(resolveGoogleAccount("accounting", accounts, "gmail").account?.id).toBe("gmail_test8");
    expect(resolveGoogleAccount("leo", accounts, "gmail").account?.id).toBe("gmail_leo");
    expect(resolveGoogleAccount(undefined, accounts, "gmail").account?.id).toBe("gmail_inc");
  });
});
