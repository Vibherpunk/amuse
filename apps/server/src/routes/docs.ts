import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { agentsTable, chatsTable, db, documentsTable, messagesTable, type DocBlock, type DocComment } from "@amuse/db";
import { publish } from "../agent/bus";
import { blocksToMarkdown, deleteDocWorkspaceFile, makeBlockId, markdownToBlocks, slugifyDoc, syncDocToWorkspace } from "../agent/docs";
import { activeRunFor, startRun, steer } from "../agent/loop";
import { idParam, requireAuth, uid } from "./helpers";

const router: IRouter = Router();
router.use(requireAuth);

function summarizeDoc(doc: typeof documentsTable.$inferSelect) {
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const preview = blocks
    .map((b) => b.text?.trim())
    .filter(Boolean)
    .join(" · ")
    .slice(0, 140);
  return {
    id: doc.id,
    title: doc.title,
    emoji: doc.emoji,
    slug: doc.slug,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    blockCount: blocks.length,
    preview,
  };
}

function normalizeBlocks(raw: unknown): DocBlock[] {
  if (!Array.isArray(raw)) return [{ id: makeBlockId(), type: "p", text: "" }];
  const validTypes = new Set(["p", "h1", "h2", "h3", "bullet", "todo", "callout", "quote", "code", "divider"]);
  const out = raw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .map((b) => {
      const type = validTypes.has(String(b.type)) ? (String(b.type) as DocBlock["type"]) : "p";
      const comments = Array.isArray(b.comments)
        ? b.comments
            .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
            .map((c) => ({
              id: String(c.id || makeBlockId()),
              author: (c.author === "agent" ? "agent" : "user") as "user" | "agent",
              text: String(c.text ?? ""),
              ...(c.selection ? { selection: String(c.selection) } : {}),
              createdAt: String(c.createdAt || new Date().toISOString()),
              ...(c.resolved ? { resolved: true } : {}),
            }))
        : undefined;
      return {
        id: String(b.id || makeBlockId()),
        type,
        text: String(b.text ?? ""),
        ...(type === "todo" ? { checked: Boolean(b.checked) } : {}),
        ...(comments && comments.length ? { comments } : {}),
      };
    });
  return out.length ? out : [{ id: makeBlockId(), type: "p", text: "" }];
}

router.get("/docs", async (req, res) => {
  const rows = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.userId, uid(req)))
    .orderBy(desc(documentsTable.updatedAt));
  res.json({ docs: rows.map(summarizeDoc) });
});

router.post("/docs", async (req, res) => {
  const userId = uid(req);
  const title = String(req.body?.title ?? "Untitled").trim().slice(0, 160) || "Untitled";
  const emoji = String(req.body?.emoji ?? "📝").trim().slice(0, 16) || "📝";
  const blocks: DocBlock[] = Array.isArray(req.body?.blocks)
    ? normalizeBlocks(req.body.blocks)
    : typeof req.body?.markdown === "string"
      ? markdownToBlocks(req.body.markdown)
      : [{ id: makeBlockId(), type: "p", text: "" }];
  const slug = slugifyDoc(title);
  const [doc] = await db
    .insert(documentsTable)
    .values({ userId, title, emoji, slug, blocks })
    .returning();
  await syncDocToWorkspace(userId, doc!);
  publish(userId, { type: "refresh", what: "docs" });
  res.json({ doc });
});

router.get("/docs/:id", async (req, res) => {
  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, idParam(req)), eq(documentsTable.userId, uid(req))));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json({ doc });
});

router.put("/docs/:id", async (req, res) => {
  const userId = uid(req);
  const id = idParam(req);
  const [existing] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.userId, userId)));
  if (!existing) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const title = req.body?.title !== undefined ? String(req.body.title).trim().slice(0, 160) || "Untitled" : existing.title;
  const emoji = req.body?.emoji !== undefined ? String(req.body.emoji).trim().slice(0, 16) || "📝" : existing.emoji;
  const blocks = req.body?.blocks !== undefined ? normalizeBlocks(req.body.blocks) : existing.blocks;
  const slug = slugifyDoc(title);
  const [doc] = await db
    .update(documentsTable)
    .set({ title, emoji, slug, blocks, updatedAt: new Date() })
    .where(and(eq(documentsTable.id, id), eq(documentsTable.userId, userId)))
    .returning();
  await syncDocToWorkspace(userId, doc!);
  publish(userId, { type: "refresh", what: "docs" });
  res.json({ doc });
});

router.delete("/docs/:id", async (req, res) => {
  const userId = uid(req);
  const id = idParam(req);
  const [deleted] = await db
    .delete(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.userId, userId)))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  await deleteDocWorkspaceFile(userId, id);
  publish(userId, { type: "refresh", what: "docs" });
  res.json({ ok: true });
});

router.get("/docs/:id/export.md", async (req, res) => {
  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, idParam(req)), eq(documentsTable.userId, uid(req))));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const md = blocksToMarkdown(doc.title, Array.isArray(doc.blocks) ? doc.blocks : []);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${doc.slug || "document"}.md"`);
  res.send(md);
});

router.post("/docs/:id/ask", async (req, res) => {
  const userId = uid(req);
  const id = idParam(req);
  const blockId = String(req.body?.blockId ?? "").trim();
  const selection = String(req.body?.selection ?? "").trim().slice(0, 1000);
  const instruction = String(req.body?.instruction ?? "").trim().slice(0, 2000);
  if (!blockId || !instruction) {
    res.status(400).json({ error: "blockId and instruction are required" });
    return;
  }
  const [existing] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.userId, userId)));
  if (!existing) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const blocks = [...(Array.isArray(existing.blocks) ? existing.blocks : [])];
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) {
    res.status(404).json({ error: "Block not found" });
    return;
  }

  const comment: DocComment = {
    id: `c_${Math.random().toString(36).slice(2, 8)}`,
    author: "user",
    text: instruction,
    ...(selection ? { selection } : {}),
    createdAt: new Date().toISOString(),
  };
  const targetBlock = blocks[idx]!;
  blocks[idx] = {
    ...targetBlock,
    comments: [...(targetBlock.comments ?? []), comment],
  };

  const [doc] = await db
    .update(documentsTable)
    .set({ blocks, updatedAt: new Date() })
    .where(and(eq(documentsTable.id, id), eq(documentsTable.userId, userId)))
    .returning();
  await syncDocToWorkspace(userId, doc!);

  const [mainChat] = await db
    .select()
    .from(chatsTable)
    .where(and(eq(chatsTable.userId, userId), eq(chatsTable.kind, "main")));
  const chatId = mainChat?.id;
  if (!chatId) {
    res.status(400).json({ error: "Main chat not found" });
    return;
  }

  const prompt = [
    `[Doc #${doc!.id} "${doc!.title}" · block ${blockId}]`,
    selection ? `Selected text: "${selection}"` : `Current block (${targetBlock.type}): "${targetBlock.text}"`,
    `Instruction: ${instruction}`,
    ``,
    `Use workspace action "doc_get" (doc_id: ${doc!.id}) if you need surrounding context, then update ONLY block "${blockId}" via workspace action "doc_update_block" (and optionally leave a brief note via "doc_comment_reply").`,
  ].join("\n");

  await db.insert(messagesTable).values({ userId, chatId, role: "user", content: prompt });
  if (activeRunFor(chatId)) steer(chatId, prompt);
  else await startRun({ userId, chatId, trigger: "user" });

  publish(userId, { type: "refresh", what: "docs" });
  res.json({ ok: true, doc, chatId });
});

export default router;
