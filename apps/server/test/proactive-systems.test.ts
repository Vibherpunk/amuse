import { describe, expect, it } from "vitest";
import {
  CLUE_TTL_DAYS,
  eventStateHash,
  formatMeetingSessionMarkdown,
  isQuietHour,
  mergeCluesAndPromote,
  nextLocalTimeUtc,
  parseQuietWindow,
  PROACTIVE_PLAYBOOKS,
  renderLearnedRulesIntoPreferences,
  slugifyTitle,
} from "../src/agent/proactive";
import { reciprocalRankFusion } from "../src/agent/tools/memory";
import { buildPresentedTools } from "../src/agent/tools/gateways";
import { ALL_TOOLS } from "../src/agent/loop";

describe("proactive guardrails & quiet hours", () => {
  it("parses active window from PROACTIVE_PREFERENCES.md into quiet hours", () => {
    expect(parseQuietWindow("Default window: 09:00 to 21:30 America/Los_Angeles")).toEqual({ startHour: 21, endHour: 9 });
    expect(parseQuietWindow("No window specified")).toEqual({ startHour: 22, endHour: 8 });
  });

  it("evaluates quiet hours in target timezone", () => {
    // 2026-11-22T11:00:00Z = 03:00 PST (quiet)
    expect(isQuietHour(new Date("2026-11-22T11:00:00Z"), "America/Los_Angeles")).toBe(true);
    // 2026-11-22T20:00:00Z = 12:00 PST (active)
    expect(isQuietHour(new Date("2026-11-22T20:00:00Z"), "America/Los_Angeles")).toBe(false);
  });

  it("produces deterministic event state hashes", () => {
    expect(eventStateHash({ id: "1", subject: "Hello" })).toBe(eventStateHash({ id: "1", subject: "Hello" }));
    expect(eventStateHash({ id: "1", subject: "Hello" })).not.toBe(eventStateHash({ id: "1", subject: "Updated" }));
  });
});

describe("reciprocal rank fusion & playbooks", () => {
  it("fuses FTS and literal result lists without duplicates", () => {
    const fts = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const lit = [{ id: "b" }, { id: "d" }, { id: "a" }];
    const fused = reciprocalRankFusion([fts, lit], (x) => x.id);
    expect(fused.map((x) => x.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("includes all 4 proactive scenario playbooks", () => {
    expect(Object.keys(PROACTIVE_PLAYBOOKS).sort()).toEqual([
      "skills/proactive/commitments.md",
      "skills/proactive/meetings.md",
      "skills/proactive/occasions.md",
      "skills/proactive/travel.md",
    ]);
  });
});

describe("proactive dreaming clues & rules", () => {
  it("drops stale clues past TTL and promotes seen >= 2 clues to rules", () => {
    const now = new Date("2026-11-22T10:00:00Z");
    const staleDate = new Date(now.getTime() - (CLUE_TTL_DAYS + 2) * 86400_000);
    const recentDate = new Date(now.getTime() - 2 * 86400_000);
    const res = mergeCluesAndPromote(
      [
        { matter: "old", kind: "stale_kind", timeWindow: null, leaning: "stay_silent", seen: 1, lastSeenAt: staleDate },
        { matter: "AWS invoice", kind: "vendor invoices", timeWindow: null, leaning: "tell_now", seen: 1, lastSeenAt: recentDate },
      ],
      [{ matter: "Figma invoice", kind: "vendor invoices", timeWindow: null, leaning: "tell_now" }],
      [],
      now,
    );
    expect(res.clues.find((c) => c.kind === "stale_kind")).toBeUndefined();
    expect(res.promoted).toEqual(["vendor invoices -> Tell now"]);
    expect(res.rules).toEqual(["vendor invoices -> Tell now"]);
  });

  it("renders Learned Rules into PROACTIVE_PREFERENCES.md without losing existing sections", () => {
    const prefs = "# PROACTIVE_PREFERENCES.md\n\n## Tell me about\n- Deadlines\n\n## When\n- 09:00 to 21:30\n";
    const out = renderLearnedRulesIntoPreferences(prefs, ["vendor invoices -> Tell now"]);
    expect(out).toContain("## Tell me about\n- Deadlines");
    expect(out).toContain("## Learned Rules\n- vendor invoices -> Tell now");

    const updated = renderLearnedRulesIntoPreferences(out, ["vendor invoices -> Tell now", "newsletters -> Stay silent"]);
    expect(updated).toContain("- newsletters -> Stay silent");
    expect(updated.match(/## Learned Rules/g)?.length).toBe(1);
  });

  it("schedules 02:30 in target timezone instead of container UTC", () => {
    // 2026-11-22 19:00 UTC is 11:00 PST; next 02:30 PST is 2026-11-23 10:30 UTC
    const next = nextLocalTimeUtc(2, 30, "America/Los_Angeles", new Date("2026-11-22T19:00:00Z"));
    expect(next.toISOString()).toBe("2026-11-23T10:30:00.000Z");
  });
});

describe("meeting formatting & gateway tool count", () => {
  it("formats meeting session markdown and slugs cleanly", () => {
    expect(slugifyTitle("Acme Q4 Budget & Staffing!")).toBe("acme-q4-budget-staffing");
    const md = formatMeetingSessionMarkdown({
      date: "2026-11-22",
      title: "Acme Sync",
      summary: "Aligned on payroll.",
      topics: ["Payroll"],
      decisions: ["Mari approves Fridays"],
      actionItems: ["Send updated roster"],
      transcript: "Adam: Let's finalize Friday.",
    });
    expect(md).toContain("# Acme Sync");
    expect(md).toContain("- [ ] Send updated roster");
    expect(md).toContain("## Change Log");
  });

  it("keeps presented tool menu <= 9 tools while exposing tracking actions in workspace", () => {
    const subagentTool = ALL_TOOLS.find((t) => t.name === "spawn_subagents")!;
    const notifyTool = { ...subagentTool, name: "notify" };
    const menu = buildPresentedTools({
      background: false,
      mcpState: { tools: [], byName: new Map(), servers: new Map(), statuses: [], usingBootstrap: false },
      subagentTool,
      notifyTool,
    });
    expect(menu.length).toBeLessThanOrEqual(9);
    const ws = menu.find((t) => t.name === "workspace")!;
    const actions = (ws.parameters as any).properties.action.enum as string[];
    expect(actions).toContain("tracking_list");
    expect(actions).toContain("tracking_upsert");
    expect(actions).toContain("tracking_done");
  });
});
