import PDFDocument from "pdfkit";
import { artifactsTable, db } from "@amuse/db";
import { MODELS, imageOpenai, speechSeconds, synthesizeSpeech, textCompletion } from "../../lib/ai";

import { obj, str, num, type ToolDef } from "./types";

/** Join PCM WAV segments (same format) into one WAV: a single header over the concatenated data chunks. */
function joinWavSegments(buffers: Buffer[]): Buffer {
  const isWav = (b: Buffer) => b.length > 44 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE";
  if (!buffers.length || !buffers.every(isWav)) return Buffer.concat(buffers);
  const chunkData = (b: Buffer, want: string): Buffer | null => {
    let off = 12;
    while (off + 8 <= b.length) {
      const id = b.toString("ascii", off, off + 4);
      const size = b.readUInt32LE(off + 4);
      if (id === want) return b.subarray(off + 8, off + 8 + size);
      off += 8 + size + (size % 2);
    }
    return null;
  };
  const fmt = chunkData(buffers[0], "fmt ");
  const parts = buffers.map((b) => chunkData(b, "data")).filter((d): d is Buffer => d !== null);
  if (!fmt || !parts.length) return Buffer.concat(buffers);
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(28 + fmt.length);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(fmt.length, 16);
  fmt.copy(header, 20);
  header.write("data", 20 + fmt.length, "ascii");
  header.writeUInt32LE(data.length, 24 + fmt.length);
  return Buffer.concat([header, data]);
}

function markdownToPdf(title: string, md: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.font("Helvetica-Bold").fontSize(22).text(title, { paragraphGap: 12 });
    for (const raw of md.split("\n")) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");
      if (/^#{1,2} /.test(line)) doc.moveDown(0.5).font("Helvetica-Bold").fontSize(16).text(line.replace(/^#+ /, ""), { paragraphGap: 6 });
      else if (/^#{3,} /.test(line)) doc.moveDown(0.3).font("Helvetica-Bold").fontSize(13).text(line.replace(/^#+ /, ""), { paragraphGap: 4 });
      else if (/^\s*[-*] /.test(line))
        doc
          .font("Helvetica")
          .fontSize(11)
          .text("•  " + line.replace(/^\s*[-*] /, ""), { indent: 12, paragraphGap: 2 });
      else if (/^\|/.test(line)) {
        if (/^\|[\s:-]+\|/.test(line.replace(/[^|:\-\s]/g, "")) && !/[a-z0-9]/i.test(line)) continue;
        doc
          .font("Courier")
          .fontSize(9.5)
          .text(
            line
              .split("|")
              .filter(Boolean)
              .map((c) => c.trim())
              .join("  |  "),
            { paragraphGap: 2 },
          );
      } else if (!line.trim()) doc.moveDown(0.4);
      else doc.font("Helvetica").fontSize(11).text(line, { paragraphGap: 4, lineGap: 1.5 });
    }
    doc.end();
  });
}

export const mediaTools: ToolDef[] = [
  {
    name: "generate_image",
    skill: "Image generation",
    status: "Making an image",
    description: "Generate an image from a detailed prompt. The image is shown to the person.",
    parameters: obj({ prompt: str("Detailed visual description"), shape: { type: "string", enum: ["square", "portrait", "landscape"] } }, ["prompt"]),
    async run({ prompt, shape }, ctx) {
      await ctx.setStatus("Making an image");
      const size = shape === "portrait" ? "1024x1536" : shape === "landscape" ? "1536x1024" : "1024x1024";
      const res = await imageOpenai.images.generate({
        model: MODELS.image,
        prompt,
        size: size as any,
        quality: "medium" as any,
        output_format: "jpeg" as any,
        n: 1,
      } as any);
      const b64 = (res.data?.[0] as any)?.b64_json as string | undefined;
      const url = b64 ? `data:image/jpeg;base64,${b64}` : ((res.data?.[0] as any)?.url as string | undefined);
      await ctx.usage({ images: 1 });
      if (!url) return { error: "Image generation failed" };
      const [a] = await db
        .insert(artifactsTable)
        .values({ userId: ctx.userId, chatId: ctx.chatId, kind: "image", title: String(prompt).slice(0, 80), content: url, meta: { prompt, size } })
        .returning();
      ctx.addParts([{ type: "image", artifactId: a!.id, title: a!.title }]);
      await ctx.activity("skill", `Generated an image: ${String(prompt).slice(0, 60)}`, { artifactId: a!.id }, "Image generation");
      return { artifact_id: a!.id, shown_to_person: true };
    },
  },
  {
    name: "create_pdf",
    skill: "Documents",
    status: "Making a PDF",
    description: "Create a downloadable PDF document from Markdown (headings, bullets, tables, paragraphs).",
    parameters: obj({ title: str("Document title"), markdown: str("Document body in Markdown") }, ["title", "markdown"]),
    async run({ title, markdown }, ctx) {
      await ctx.setStatus("Making a PDF");
      const buf = await markdownToPdf(title, markdown);
      const [a] = await db
        .insert(artifactsTable)
        .values({
          userId: ctx.userId,
          chatId: ctx.chatId,
          kind: "pdf",
          title,
          content: `data:application/pdf;base64,${buf.toString("base64")}`,
          meta: { markdown, bytes: buf.length },
        })
        .returning();
      ctx.addParts([{ type: "artifact", artifactId: a!.id, kind: "pdf", title }]);
      await ctx.activity("skill", `Created a PDF: ${title}`, { artifactId: a!.id }, "Documents");
      return { artifact_id: a!.id, shown_to_person: true };
    },
  },
  {
    name: "create_podcast",
    skill: "Audio generation",
    status: "Recording a podcast",
    description: "Create a short two-host audio podcast episode on a topic. Research first (web_search) when facts matter, then pass your notes.",
    parameters: obj({ topic: str("Episode topic"), notes: str("Research notes / key facts to cover"), minutes: num("Target length 1-5 minutes") }, ["topic"]),
    async run({ topic, notes, minutes }, ctx) {
      await ctx.setStatus("Writing the script");
      const mins = Math.min(5, Math.max(1, Number(minutes ?? 2)));
      const words = Math.round(mins * 150);
      const script = await textCompletion(
        "Write a lively, accurate two-host podcast script. Hosts: AVA and LEO. Format strictly as lines 'AVA: ...' or 'LEO: ...'. No stage directions.",
        `Topic: ${topic}\nTarget length: about ${words} words.\nNotes:\n${notes ?? "(use general knowledge)"}`,
      );
      await ctx.usage({ tokensIn: script.tokensIn, tokensOut: script.tokensOut });
      const lines = script.text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^(AVA|LEO):/.test(l));
      await ctx.setStatus("Recording a podcast");
      // Two voices, voiced a few lines at a time; WAV segments are joined into a single file.
      const turns = lines.slice(0, 60).map((l) => ({ voice: l.startsWith("AVA") ? "coral" : "ash", text: l.replace(/^(AVA|LEO):\s*/, "") }));
      const audio: Buffer[] = new Array(turns.length);
      for (let i = 0; i < turns.length && !ctx.signal.stopped; i += 6) {
        await Promise.all(turns.slice(i, i + 6).map(async (t, j) => (audio[i + j] = await synthesizeSpeech(t.text, t.voice))));
      }
      const wav = joinWavSegments(audio.filter(Boolean));
      if (!wav.length) return { error: "Recording was stopped before any audio was made." };
      const seconds = turns.reduce((n, t) => n + speechSeconds(t.text), 0);
      await ctx.usage({ audioSeconds: seconds });
      const [a] = await db
        .insert(artifactsTable)
        .values({
          userId: ctx.userId,
          chatId: ctx.chatId,
          kind: "audio",
          title: `Podcast: ${topic}`,
          content: `data:audio/wav;base64,${wav.toString("base64")}`,
          meta: { script: lines.join("\n"), seconds },
        })
        .returning();
      ctx.addParts([{ type: "audio", artifactId: a!.id, title: a!.title }]);
      await ctx.activity("skill", `Recorded a podcast about ${topic}`, { artifactId: a!.id }, "Audio generation");
      return { artifact_id: a!.id, shown_to_person: true, approx_seconds: seconds };
    },
  },
];
