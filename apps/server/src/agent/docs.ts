import { and, eq, like } from "drizzle-orm";
import { db, workspaceFilesTable, type DocBlock } from "@amuse/db";
import { writeFile } from "./workspace";

export function makeBlockId(): string {
  return `b_${Math.random().toString(36).slice(2, 8)}`;
}

export function slugifyDoc(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "untitled";
}

export function markdownToBlocks(md: string): DocBlock[] {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let paraLines: string[] = [];

  const flushPara = () => {
    const text = paraLines.join("\n").trim();
    paraLines = [];
    if (text) blocks.push({ id: makeBlockId(), type: "p", text });
  };

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      flushPara();
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        inCode = false;
        blocks.push({ id: makeBlockId(), type: "code", text: codeLines.join("\n") });
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      flushPara();
      blocks.push({ id: makeBlockId(), type: "divider", text: "" });
      continue;
    }
    if (/^###\s+/.test(trimmed)) {
      flushPara();
      blocks.push({ id: makeBlockId(), type: "h3", text: trimmed.replace(/^###\s+/, "") });
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      flushPara();
      blocks.push({ id: makeBlockId(), type: "h2", text: trimmed.replace(/^##\s+/, "") });
      continue;
    }
    if (/^#\s+/.test(trimmed)) {
      flushPara();
      blocks.push({ id: makeBlockId(), type: "h1", text: trimmed.replace(/^#\s+/, "") });
      continue;
    }
    const todoMatch = trimmed.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (todoMatch) {
      flushPara();
      blocks.push({
        id: makeBlockId(),
        type: "todo",
        text: todoMatch[2] ?? "",
        checked: (todoMatch[1] ?? " ").toLowerCase() === "x",
      });
      continue;
    }
    const bulletMatch = trimmed.match(/^(?:[-*•])\s+(.*)$/);
    if (bulletMatch) {
      flushPara();
      blocks.push({ id: makeBlockId(), type: "bullet", text: bulletMatch[1] ?? "" });
      continue;
    }
    if (/^>\s*/.test(trimmed)) {
      flushPara();
      const body = trimmed.replace(/^>\s?/, "");
      const isCallout = /^💡\s*|^\[!NOTE\]\s*/i.test(body);
      blocks.push({
        id: makeBlockId(),
        type: isCallout ? "callout" : "quote",
        text: body.replace(/^\[!NOTE\]\s*/i, ""),
      });
      continue;
    }
    paraLines.push(line);
  }
  if (inCode && codeLines.length) {
    blocks.push({ id: makeBlockId(), type: "code", text: codeLines.join("\n") });
  }
  flushPara();
  if (!blocks.length) {
    blocks.push({ id: makeBlockId(), type: "p", text: "" });
  }
  return blocks;
}

export function blocksToMarkdown(title: string, blocks: DocBlock[]): string {
  const out: string[] = [`# ${title || "Untitled"}`, ""];
  for (const b of blocks) {
    const t = b.text ?? "";
    switch (b.type) {
      case "h1":
        out.push(`# ${t}`, "");
        break;
      case "h2":
        out.push(`## ${t}`, "");
        break;
      case "h3":
        out.push(`### ${t}`, "");
        break;
      case "bullet":
        out.push(`- ${t}`);
        break;
      case "todo":
        out.push(`- [${b.checked ? "x" : " "}] ${t}`);
        break;
      case "callout":
        out.push(`> 💡 ${t}`, "");
        break;
      case "quote":
        out.push(`> ${t}`, "");
        break;
      case "code":
        out.push("```", t, "```", "");
        break;
      case "divider":
        out.push("---", "");
        break;
      default:
        if (t.trim()) out.push(t, "");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export async function syncDocToWorkspace(
  userId: string,
  doc: { id: number; title: string; slug: string; blocks: DocBlock[] },
): Promise<void> {
  await deleteDocWorkspaceFile(userId, doc.id);
  const path = `docs/${doc.id}-${doc.slug}.md`;
  const md = blocksToMarkdown(doc.title, doc.blocks);
  await writeFile(userId, path, md);
}

export async function deleteDocWorkspaceFile(userId: string, docId: number): Promise<void> {
  await db
    .delete(workspaceFilesTable)
    .where(and(eq(workspaceFilesTable.userId, userId), like(workspaceFilesTable.path, `docs/${docId}-%`)));
}
