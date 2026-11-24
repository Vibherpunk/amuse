import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Download,
  FileText,
  PanelRight,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, del, post, put, timeAgo } from "../lib/api";
import type { CollaborativeDoc, DocBlock, DocBlockType, DocSummary } from "../lib/types";
import { usePanel } from "../components/AgentPanel";
import { Button, Empty, Input, cx } from "../components/ui";

const BLOCK_TYPES: { type: DocBlockType; label: string; hint: string }[] = [
  { type: "p", label: "Text", hint: "Plain paragraph" },
  { type: "h1", label: "Heading 1", hint: "Big section title" },
  { type: "h2", label: "Heading 2", hint: "Medium section heading" },
  { type: "h3", label: "Heading 3", hint: "Small subsection" },
  { type: "bullet", label: "Bullet list", hint: "Simple bulleted item" },
  { type: "todo", label: "To-do", hint: "Checkable task" },
  { type: "callout", label: "Callout", hint: "Highlighted note" },
  { type: "quote", label: "Quote", hint: "Blockquote" },
  { type: "code", label: "Code", hint: "Monospace snippet" },
  { type: "divider", label: "Divider", hint: "Horizontal rule" },
];

const EMOJI_PRESETS = ["📝", "📋", "💡", "🚀", "📌", "🧠", "📅", "🏠", "📊", "✨"];

const uid = () => `b_${Math.random().toString(36).slice(2, 8)}`;

function blocksToPlainMarkdown(title: string, blocks: DocBlock[]): string {
  const out = [`# ${title || "Untitled"}`, ""];
  for (const b of blocks) {
    if (b.type === "h1") out.push(`# ${b.text}`, "");
    else if (b.type === "h2") out.push(`## ${b.text}`, "");
    else if (b.type === "h3") out.push(`### ${b.text}`, "");
    else if (b.type === "bullet") out.push(`- ${b.text}`);
    else if (b.type === "todo") out.push(`- [${b.checked ? "x" : " "}] ${b.text}`);
    else if (b.type === "callout") out.push(`> 💡 ${b.text}`, "");
    else if (b.type === "quote") out.push(`> ${b.text}`, "");
    else if (b.type === "code") out.push("```", b.text, "```", "");
    else if (b.type === "divider") out.push("---", "");
    else if (b.text.trim()) out.push(b.text, "");
  }
  return out.join("\n").trim() + "\n";
}

function AutoTextarea({
  value,
  onChange,
  onKeyDown,
  onSelect,
  placeholder,
  className,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect?: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
  inputRef?: (el: HTMLTextAreaElement | null) => void;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 24)}px`;
  }, []);
  useEffect(() => {
    resize();
  }, [value, resize]);
  return (
    <textarea
      ref={(el) => {
        localRef.current = el;
        inputRef?.(el);
      }}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onSelect={onSelect}
      placeholder={placeholder}
      className={cx("w-full resize-none overflow-hidden bg-transparent outline-none", className)}
    />
  );
}

export function DocsPage({ activeId }: { activeId?: number }) {
  const qc = useQueryClient();
  const [, nav] = useLocation();
  const { open: panelOpen, setOpen: setPanelOpen } = usePanel();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);

  const { data: listData } = useQuery({
    queryKey: ["docs"],
    queryFn: () => api<{ docs: DocSummary[] }>("/docs"),
  });
  const docs = listData?.docs ?? [];
  const selectedId = activeId ?? docs[0]?.id ?? null;

  const { data: docData } = useQuery({
    queryKey: ["doc", selectedId],
    queryFn: () => api<{ doc: CollaborativeDoc }>(`/docs/${selectedId}`),
    enabled: selectedId != null,
  });

  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState("📝");
  const [blocks, setBlocks] = useState<DocBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [slashBlockId, setSlashBlockId] = useState<string | null>(null);
  const [askBlockId, setAskBlockId] = useState<string | null>(null);
  const [askSelection, setAskSelection] = useState("");
  const [askPrompt, setAskPrompt] = useState("");
  const [asking, setAsking] = useState(false);

  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Sync incoming server doc into editor state when not mid-edit
  useEffect(() => {
    const d = docData?.doc;
    if (!d) return;
    if (!dirtyRef.current) {
      setTitle(d.title);
      setEmoji(d.emoji || "📝");
      setBlocks(Array.isArray(d.blocks) && d.blocks.length ? d.blocks : [{ id: uid(), type: "p", text: "" }]);
    }
  }, [docData?.doc]);

  // Reset dirty state when switching documents
  useEffect(() => {
    setDirty(false);
    setAskBlockId(null);
    setSlashBlockId(null);
    setShowEmojiPicker(false);
  }, [selectedId]);

  // Debounced auto-save
  useEffect(() => {
    if (!dirty || selectedId == null) return;
    const t = setTimeout(async () => {
      setSaving(true);
      try {
        await put(`/docs/${selectedId}`, { title, emoji, blocks });
        setDirty(false);
        void qc.invalidateQueries({ queryKey: ["docs"] });
      } finally {
        setSaving(false);
      }
    }, 550);
    return () => clearTimeout(t);
  }, [dirty, selectedId, title, emoji, blocks, qc]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.title.toLowerCase().includes(q) || d.preview.toLowerCase().includes(q));
  }, [docs, filter]);

  const createNewDoc = async () => {
    setCreating(true);
    try {
      const res = await post<{ doc: CollaborativeDoc }>("/docs", {
        title: "Untitled",
        emoji: "📝",
        blocks: [{ id: uid(), type: "p", text: "" }],
      });
      await qc.invalidateQueries({ queryKey: ["docs"] });
      nav(`/docs/${res.doc.id}`);
    } finally {
      setCreating(false);
    }
  };

  const removeDoc = async (id: number) => {
    if (!confirm("Delete this document?")) return;
    await del(`/docs/${id}`);
    await qc.invalidateQueries({ queryKey: ["docs"] });
    if (selectedId === id) nav("/docs");
  };

  const updateBlocks = (fn: (prev: DocBlock[]) => DocBlock[]) => {
    setBlocks((prev) => fn(prev));
    setDirty(true);
  };

  const focusBlock = (id: string) => {
    requestAnimationFrame(() => refs.current[id]?.focus());
  };

  const insertAfter = (afterId: string, type: DocBlockType = "p") => {
    const newBlock: DocBlock = { id: uid(), type, text: "", ...(type === "todo" ? { checked: false } : {}) };
    updateBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === afterId);
      const next = [...prev];
      next.splice(idx === -1 ? next.length : idx + 1, 0, newBlock);
      return next;
    });
    focusBlock(newBlock.id);
  };

  const moveBlock = (id: string, dir: -1 | 1) => {
    updateBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      const target = idx + dir;
      if (idx === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item!);
      return next;
    });
  };

  const deleteBlock = (id: string) => {
    updateBlocks((prev) => {
      if (prev.length <= 1) return [{ id: prev[0]?.id ?? uid(), type: "p", text: "" }];
      const idx = prev.findIndex((b) => b.id === id);
      const prevId = prev[Math.max(0, idx - 1)]?.id;
      if (prevId && prevId !== id) focusBlock(prevId);
      return prev.filter((b) => b.id !== id);
    });
  };

  const submitAsk = async (blockId: string) => {
    if (!askPrompt.trim() || selectedId == null) return;
    setAsking(true);
    try {
      if (dirty) {
        await put(`/docs/${selectedId}`, { title, emoji, blocks });
        setDirty(false);
      }
      const res = await post<{ doc: CollaborativeDoc }>(`/docs/${selectedId}/ask`, {
        blockId,
        selection: askSelection || undefined,
        instruction: askPrompt.trim(),
      });
      setBlocks(res.doc.blocks);
      setAskPrompt("");
      setAskSelection("");
      setAskBlockId(null);
      setPanelOpen(true);
      void qc.invalidateQueries({ queryKey: ["doc", selectedId] });
      void qc.invalidateQueries({ queryKey: ["docs"] });
    } finally {
      setAsking(false);
    }
  };

  const toggleResolve = (blockId: string) => {
    updateBlocks((prev) =>
      prev.map((b) =>
        b.id !== blockId
          ? b
          : {
              ...b,
              comments: (b.comments ?? []).map((c) => ({ ...c, resolved: !c.resolved })),
            },
      ),
    );
  };

  const copyMarkdown = async () => {
    await navigator.clipboard.writeText(blocksToPlainMarkdown(title, blocks));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full min-h-0 bg-[var(--bg)] text-[var(--ink)]">
      {/* Left Document List */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--side)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <FileText size={16} />
            <span>Docs</span>
          </div>
          <Button size="sm" onClick={() => void createNewDoc()} disabled={creating} data-testid="new-doc">
            <Plus size={14} /> New
          </Button>
        </div>
        <div className="p-2.5">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-[var(--muted)]" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter docs…"
              className="pl-7 text-xs"
            />
          </div>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {filtered.map((d) => {
            const active = d.id === selectedId;
            return (
              <div
                key={d.id}
                onClick={() => nav(`/docs/${d.id}`)}
                className={cx(
                  "group flex cursor-pointer items-start justify-between gap-2 rounded-xl px-2.5 py-2 transition",
                  active ? "bg-[var(--card)] text-[var(--ink)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-sm font-medium text-[var(--ink)]">
                    <span>{d.emoji}</span>
                    <span className="truncate">{d.title || "Untitled"}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[var(--muted)]">
                    {d.blockCount} blocks · {timeAgo(d.updatedAt)}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeDoc(d.id);
                  }}
                  title="Delete doc"
                  className="rounded p-1 text-[var(--muted)] opacity-0 hover:bg-[var(--hover)] hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-[var(--muted)]">No matching docs</div>
          )}
        </div>
      </aside>

      {/* Main Editor Canvas */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedId == null ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <Empty
              icon="📝"
              title="Collaborative Docs"
              body="Notion-style block documents you and Amuse co-edit together. Highlight any block to ask Amuse to rewrite, expand, or fact-check it."
              action={
                <Button onClick={() => void createNewDoc()} disabled={creating}>
                  <Plus size={14} /> Create your first doc
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <span>{saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
                <span>·</span>
                <span>Type / for blocks</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="soft" onClick={() => void copyMarkdown()}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copied" : "Copy MD"}
                </Button>
                <a href={`/api/docs/${selectedId}/export.md`} download>
                  <Button size="sm" variant="soft">
                    <Download size={13} /> .md
                  </Button>
                </a>
                <Button size="sm" variant={panelOpen ? "primary" : "soft"} onClick={() => setPanelOpen(!panelOpen)}>
                  <PanelRight size={13} /> Amuse
                </Button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-8 md:px-12">
              <div className="mx-auto max-w-3xl">
                {/* Doc Emoji & Title */}
                <div className="relative mb-6 flex items-center gap-3">
                  <button
                    onClick={() => setShowEmojiPicker((v) => !v)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--card)] text-2xl hover:bg-[var(--hover)]"
                    title="Change icon"
                  >
                    {emoji}
                  </button>
                  {showEmojiPicker && (
                    <div className="absolute left-0 top-13 z-30 flex gap-1 rounded-xl border border-[var(--line)] bg-[#202020] p-2 shadow-xl">
                      {EMOJI_PRESETS.map((em) => (
                        <button
                          key={em}
                          onClick={() => {
                            setEmoji(em);
                            setDirty(true);
                            setShowEmojiPicker(false);
                          }}
                          className="rounded-lg p-1.5 text-lg hover:bg-[var(--hover)]"
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="Untitled"
                    className="w-full bg-transparent font-display text-3xl font-bold outline-none placeholder:text-[var(--muted)]"
                  />
                </div>

                {/* Block List */}
                <div className="space-y-1.5">
                  {blocks.map((b) => {
                    const comments = b.comments ?? [];
                    const hasOpenComments = comments.some((c) => !c.resolved);
                    return (
                      <div key={b.id} className="group relative rounded-xl px-2 py-1 hover:bg-[var(--card)]/40">
                        <div className="flex items-start gap-2">
                          {/* Left Gutter */}
                          <div className="mt-1 flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                            <button
                              onClick={() => insertAfter(b.id, "p")}
                              title="Add block below"
                              className="rounded p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                            >
                              <Plus size={13} />
                            </button>
                            <select
                              value={b.type}
                              onChange={(e) =>
                                updateBlocks((prev) =>
                                  prev.map((x) =>
                                    x.id === b.id ? { ...x, type: e.target.value as DocBlockType } : x,
                                  ),
                                )
                              }
                              aria-label="Block type"
                              className="rounded bg-transparent px-1 py-0.5 text-[11px] text-[var(--muted)] outline-none hover:bg-[var(--hover)]"
                            >
                              {BLOCK_TYPES.map((t) => (
                                <option key={t.type} value={t.type} className="bg-[#202020] text-[var(--ink)]">
                                  {t.label}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => moveBlock(b.id, -1)}
                              title="Move up"
                              className="rounded p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                            >
                              <ArrowUp size={12} />
                            </button>
                            <button
                              onClick={() => moveBlock(b.id, 1)}
                              title="Move down"
                              className="rounded p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                            >
                              <ArrowDown size={12} />
                            </button>
                          </div>

                          {/* Block Content */}
                          <div
                            className={cx(
                              "min-w-0 flex-1",
                              b.type === "callout" && "rounded-xl border border-[var(--line)] bg-[var(--card)] px-3.5 py-2.5",
                              b.type === "quote" && "border-l-2 border-[var(--muted)] pl-3 italic text-[var(--muted)]",
                              b.type === "code" && "rounded-xl border border-[var(--line)] bg-black/30 px-3 py-2 font-mono text-xs",
                            )}
                          >
                            {b.type === "divider" ? (
                              <hr className="my-3 border-[var(--line)]" />
                            ) : (
                              <div className="flex items-start gap-2">
                                {b.type === "bullet" && <span className="mt-1 select-none text-[var(--muted)]">•</span>}
                                {b.type === "todo" && (
                                  <input
                                    type="checkbox"
                                    checked={Boolean(b.checked)}
                                    onChange={(e) =>
                                      updateBlocks((prev) =>
                                        prev.map((x) => (x.id === b.id ? { ...x, checked: e.target.checked } : x)),
                                      )
                                    }
                                    className="mt-1.5 h-4 w-4 accent-[var(--ink)]"
                                  />
                                )}
                                <AutoTextarea
                                  inputRef={(el) => {
                                    refs.current[b.id] = el;
                                  }}
                                  value={b.text}
                                  onChange={(val) => {
                                    if (val === "/") setSlashBlockId(b.id);
                                    else if (slashBlockId === b.id && !val.startsWith("/")) setSlashBlockId(null);
                                    updateBlocks((prev) => prev.map((x) => (x.id === b.id ? { ...x, text: val } : x)));
                                  }}
                                  onSelect={(e) => {
                                    const el = e.currentTarget;
                                    const sel = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim();
                                    if (sel && askBlockId === b.id) setAskSelection(sel);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey && b.type !== "code") {
                                      e.preventDefault();
                                      setSlashBlockId(null);
                                      insertAfter(b.id, b.type === "bullet" || b.type === "todo" ? b.type : "p");
                                    } else if (e.key === "Backspace" && !b.text && blocks.length > 1) {
                                      e.preventDefault();
                                      deleteBlock(b.id);
                                    } else if (e.key === "Escape") {
                                      setSlashBlockId(null);
                                      setAskBlockId(null);
                                    }
                                  }}
                                  placeholder={b.type === "p" ? "Write, or press / for commands…" : `${b.type.toUpperCase()}…`}
                                  className={cx(
                                    b.type === "h1" && "text-2xl font-bold",
                                    b.type === "h2" && "text-xl font-semibold",
                                    b.type === "h3" && "text-base font-semibold",
                                    b.type === "todo" && b.checked && "line-through text-[var(--muted)]",
                                    b.type === "p" && "text-[15px] leading-relaxed",
                                  )}
                                />
                              </div>
                            )}
                          </div>

                          {/* Right Actions: Ask Amuse & Delete */}
                          <div className="mt-1 flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                            <button
                              onClick={() => {
                                const el = refs.current[b.id];
                                const sel = el ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim() : "";
                                setAskSelection(sel);
                                setAskBlockId(askBlockId === b.id ? null : b.id);
                              }}
                              className="flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--card)] px-2 py-0.5 text-[11px] text-[var(--ink)] hover:bg-[var(--hover)]"
                              title="Ask Amuse to edit or comment on this block"
                            >
                              <Sparkles size={11} /> Ask
                            </button>
                            <button
                              onClick={() => deleteBlock(b.id)}
                              className="rounded p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-red-400"
                              title="Delete block"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>

                        {/* Slash Command Menu */}
                        {slashBlockId === b.id && (
                          <div className="ml-16 mt-1 w-64 rounded-xl border border-[var(--line)] bg-[#202020] p-1.5 shadow-2xl">
                            {BLOCK_TYPES.map((t) => (
                              <button
                                key={t.type}
                                onClick={() => {
                                  updateBlocks((prev) =>
                                    prev.map((x) =>
                                      x.id === b.id
                                        ? { ...x, type: t.type, text: x.text === "/" ? "" : x.text.replace(/^\//, "") }
                                        : x,
                                    ),
                                  );
                                  setSlashBlockId(null);
                                  focusBlock(b.id);
                                }}
                                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--hover)]"
                              >
                                <span className="font-medium text-[var(--ink)]">{t.label}</span>
                                <span className="text-[11px] text-[var(--muted)]">{t.hint}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Inline Ask Amuse Box */}
                        {askBlockId === b.id && (
                          <div className="ml-16 mt-2 rounded-xl border border-[var(--line)] bg-[var(--card)] p-2.5">
                            {askSelection && (
                              <div className="mb-1.5 truncate text-[11px] text-[var(--muted)]">
                                Selection: “{askSelection}”
                              </div>
                            )}
                            <div className="flex gap-2">
                              <Input
                                value={askPrompt}
                                onChange={(e) => setAskPrompt(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void submitAsk(b.id);
                                  }
                                }}
                                placeholder="Ask Amuse to rewrite, tighten, expand, or fact-check this block…"
                                className="text-xs"
                              />
                              <Button size="sm" onClick={() => void submitAsk(b.id)} disabled={asking || !askPrompt.trim()}>
                                {asking ? "Sending…" : "Ask"}
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* Inline Comments Thread */}
                        {comments.length > 0 && (
                          <div className="ml-16 mt-2 space-y-1.5 rounded-xl border border-[var(--line)] bg-[var(--side)]/70 p-2.5">
                            <div className="flex items-center justify-between text-[11px] text-[var(--muted)]">
                              <span>{hasOpenComments ? "Comment thread" : "Resolved thread"}</span>
                              <button onClick={() => toggleResolve(b.id)} className="hover:text-[var(--ink)]">
                                {hasOpenComments ? "Resolve" : "Reopen"}
                              </button>
                            </div>
                            {comments.map((c) => (
                              <div key={c.id} className={cx("text-xs", c.resolved && "opacity-50")}>
                                <span className="font-semibold text-[var(--ink)]">
                                  {c.author === "agent" ? "Amuse" : "You"}:
                                </span>{" "}
                                <span className="text-[var(--muted)]">{c.text}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button
                  onClick={() => {
                    const last = blocks[blocks.length - 1];
                    insertAfter(last?.id ?? "", "p");
                  }}
                  className="mt-4 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                >
                  <Plus size={13} /> Add block
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
