import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks, slugifyDoc } from "../src/agent/docs";

describe("collaborative docs helpers", () => {
  it("slugifies titles safely", () => {
    expect(slugifyDoc("Q4 Acme Operations Plan!")).toBe("q4-acme-operations-plan");
    expect(slugifyDoc("   ")).toBe("untitled");
  });

  it("parses markdown into structured Notion-style blocks and round-trips", () => {
    const md = [
      "# Project Kickoff",
      "",
      "## Goals",
      "",
      "- Ship collaborative docs",
      "- [x] Wire Postgres schema",
      "- [ ] Test Ask Amuse",
      "",
      "> 💡 Keep blocks small and editable.",
      "",
      "```",
      "const ok = true;",
      "```",
      "",
      "---",
    ].join("\n");

    const blocks = markdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["h1", "h2", "bullet", "todo", "todo", "callout", "code", "divider"]);
    expect(blocks[3]?.checked).toBe(true);
    expect(blocks[4]?.checked).toBe(false);
    expect(blocks[6]?.text).toBe("const ok = true;");

    const rendered = blocksToMarkdown("Kickoff", blocks);
    expect(rendered).toContain("# Kickoff");
    expect(rendered).toContain("- [x] Wire Postgres schema");
    expect(rendered).toContain("- [ ] Test Ask Amuse");
    expect(rendered).toContain("```");
    expect(rendered).toContain("---");
  });
});
