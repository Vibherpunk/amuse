# Upstream Proposal: Proactive Engine, Collaborative Docs, Lean Voice & Local MoE Support for Amuse

This proposal summarizes a set of tested, modular enhancements built on top of `replit/amuse` to turn Amuse into a **zero-programming proactive personal assistant** with **Notion-style collaborative docs**, **low-RAM streaming voice**, and **reliable support for fast local MoE models** (e.g., 35B-A3B).

---

## 1. Zero-Programming Proactive Engine

**Problem:** Scheduled tasks alone act as stateless timers—there is no tracking ledger, event deduplication, delivery pacing, or feedback loop.

**Proposed Design:**
- **Postgres Schema (`tracking_items`, `proactive_events`, `proactive_deliveries`, `proactive_clues`, `proactive_rule_versions` + `scheduled_tasks.tracking_item_id`):**
  - Track open commitments, questions, and upcoming meetings/trips with idempotency keys (`tracking_upsert`, `tracking_list`, `tracking_done` inside the `workspace` gateway).
  - Auto-schedule a `prep` task (`2h` or `18h` prior) when a meeting is tracked >2 hours ahead, and cascade-disable linked tasks when marked `done`.
- **Deterministic Poller & Guardrails:**
  - Poll external connectors (mail/calendar) on a lightweight interval (`10m`) using SHA-256 `state_hash` deduplication in TypeScript so the LLM is **never woken up** unless external state actually changed.
  - Enforce **quiet hours** (parsed from `PROACTIVE_PREFERENCES.md`), a **3-minute quiet-chat gate** (defer background wakes while the user is actively chatting), and a **daily proactive cap** (e.g., 5/day).
  - Trigger a periodic **chat review** (every 20 user/assistant messages) to capture unlogged promises/deadlines into `tracking_items`.
- **On-Demand Scenario Playbooks (`skills/proactive/`):**
  - Lightweight Markdown playbooks for `meetings.md`, `occasions.md`, `travel.md`, and `commitments.md` loaded only when relevant, keeping the base prompt small.

---

## 2. Local Personal Wiki, Dual-List RRF Search, Flashback & Nightly Dreaming

**Problem:** `MEMORY.md` grows unwieldy over time, while simple `ILIKE` search misses multi-term queries and mixes derived summaries with raw chat logs.

**Proposed Design:**
- **Postgres GIN FTS + Reciprocal Rank Fusion (`memory_search`):**
  - Index `workspace_files.content` and `messages.content` with `pg_trgm`/GIN `tsvector` indexes (`websearch_to_tsquery` + `ts_rank_cd`, with `ILIKE` fallback) and merge ranked hits via RRF into `files`, `wiki_and_reports`, and `messages`.
- **`<live_state>` Flashback (Prefix-Cache-Safe):**
  - On each user turn, run a fast (`<15 ms`) FTS lookup over `wiki/`, `reports/`, and `MEMORY.md` plus open `tracking_items`, injecting them into the **dynamic `<live_state>` tail** rather than the static system prefix—preserving KV prefix caching on local inference servers (`oMLX`, `vLLM`, `llama.cpp`).
- **Nightly Consolidation & Dreaming (`02:30`):**
  - Write daily summaries to `reports/daily/YYYY-MM-DD.md` and update entity pages under `wiki/{clients,contacts,projects,topics}/` with a `## Change Log`.
  - Read `proactive_deliveries` and user reactions to extract `proactive_clues` (14-day TTL, max 20). When a pattern reaches `seen >= 2`, promote it into `PROACTIVE_PREFERENCES.md` and record a versioned snapshot in `proactive_rule_versions`.

---

## 3. Native Notion-Style Collaborative Docs (`/docs`)

**Problem:** Markdown artifacts are read-only previews; users cannot co-edit block-by-block with the assistant or leave inline comments on a specific paragraph.

**Proposed Design:**
- **Structured Block Storage (`documents` table):** Store `DocBlock[]` (`p`, `h1`–`h3`, `bullet`, `todo`, `callout`, `quote`, `code`, `divider`, inline `comments[]`) in Postgres and automatically mirror each doc to `workspace_files` (`docs/<id>-<slug>.md`) so `memory_search` and Flashback index it automatically.
- **Block Editor UI (`/docs` & `/docs/:id`):** Slash `/` command menu, auto-save, `.md` export, live SSE refresh, and per-block **Ask Amuse** (`POST /api/docs/:id/ask`) that opens an inline comment thread and targets only that `blockId`.
- **`workspace` Gateway Actions:** `doc_list`, `doc_get`, `doc_create`, `doc_update_block` (surgical single-block edit), `doc_append_blocks`, and `doc_comment_reply`.

---

## 4. Local Meeting Ingest Pipeline (`POST /api/meetings/ingest`)

- Accept either a transcript or base64 audio (transcribed via the local Speaches Whisper container), extract structured summary/topics/decisions/action items, write `wiki/sessions/YYYY-MM-DD-<slug>.md`, auto-create `tracking_items`, and post a summary card to Main chat.

---

## 5. Lean Streaming Voice (`<1 GB` RAM, Overlapped Clause TTS)

**Problem:** Heavy neural TTS models consume 2.5–7 GB RAM each, and turn-based TTS waits for the entire LLM response before synthesizing audio.

**Proposed Design:**
- **Single-Container Lean Speech (`Speaches` CPU):** Pair `Systran/faster-whisper-base` (STT) with `speaches-ai/Kokoro-82M-v1.0-ONNX` (natural non-robotic TTS) inside one container (~690 MB RAM, ~290 ms warm synthesis latency).
- **Overlapped Clause-by-Clause Streaming in `VoiceMode.tsx`:** Listen to `delta` SSE chunks during generation, dispatch `/api/voice/speak` as soon as each sentence/clause completes (`>= 20` chars), and drain decoded `AudioBuffer`s sequentially—cutting time-to-first-audio dramatically without needing WebRTC/LiveKit infrastructure. Tighten VAD silence endpointing to `750 ms`.

---

## 6. Small Local MoE Ergonomics & Prompt Discipline

- **Compact Gateway Tool Menu (`<= 9` tools):** Grouping actions into typed gateways (`workspace`, `google`, `create`, `connectors`, etc.) keeps small local MoE models (e.g., 35B-A3B) reliable without tool-schema confusion.
- **Thinking-Token & Reasoning Discipline:** Support `AMUSE_REASONING_EFFORT=low` and strip `<think>` blocks cleanly before TTS or message persistence.
- **Grounding & Safety Rules:**
  - Verify mutable facts (times, roles, deadlines, completion status) in live sources before stating them as current.
  - Treat uncertain external writes (timeout/error on send/post/delete) as unknown—never silently retry without checking sent state.
  - Halt immediately on first error when explicitly instructed to stop on error.
