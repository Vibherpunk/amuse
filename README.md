# Amuse

Self-hosted personal AI agent: it researches the web, uses a live browser you can watch and take
over, runs reminders and background checks, tracks goals and builds small apps you keep using, and
asks before it sends, submits or pays for anything. Amuse runs on your own computer for one person.
It needs an OpenAI API key and PostgreSQL. No account, hosted service or other API key is required.

## How this fork differs from upstream

This repo is a public snapshot of a privately run, customized build of Amuse. The main differences from replit/amuse:

- **Proactive engine** - scheduled background checks and a heartbeat that track topics over time and only surface what matters.
- **Collaborative documents** - documents that live inside the app and are edited by the owner and the agent together: the agent drafts and revises in place, alongside the owner's own edits, instead of handing files back and forth.
- **MCP gateways with per-server tool allowlists** - MCP tool servers connect through a gateway layer, and each server exposes only an approved subset of its tools, enforced in code rather than by prompting. In the running build, an automation server that ships 68 tools is cut to 4 operator verbs (list, run a flow, run a script, read a result - builder operations excluded), and a device-management server that ships 47 tools is cut to 10 (seven reads plus start/stop/restart, approval-gated). A small proof MCP server is included for testing new integrations before they are trusted.
- **Multi-account Google gateways** - Gmail and Calendar access routed per account through an external connection broker, so the agent can work across several mailboxes without holding their credentials.
- **Host terminal executor** - shell commands run on the host through a separate executor service, with per-command approval prompts.
- **Lean local voice** - speech synthesis and transcription run on local services instead of cloud voice APIs.
- **Provider and model changes for local inference** - upstream assumes a single hosted API. This fork generalizes the provider layer: local OpenAI-compatible servers (oMLX, LM Studio) are first-class providers alongside cloud ones, over both the Responses API and Chat Completions, and model calls can route through a local redacting egress gate on the way out. Requests to the gate use a plain HTTP client because the gate rejects browser-style request headers.
- **Compaction fallback** - when summarizing an over-long chat history fails, the run falls back to trimming the history instead of failing.

### Models this build has been run and tested on

- Qwen3.6-35B-A3B at 3-bit (MoE, roughly 3B active parameters per token), served locally by oMLX
- Gemma 4 MoE, served locally
- Qwen3.8-27B, served locally by oMLX
- Muse Spark 1.3 (contributor), via OpenCode Go through the egress gate

### Why the small-active-parameter route works here

- **Tool calling holds up:** in an 18-case tool-caller benchmark, the local Gemma MoE scored 18/18, ahead of Qwen3-4B (15/18) and Qwen3-8B (11/18) - the agent picks and calls the right tools, including the live browser: web research, form-filling, and shopping all run through it.
- **Low token usage per turn:** memory is retrieved on demand instead of being carried in every prompt, so a full day of half-hourly heartbeat checks plus active chats on the paid Spark route cost a few cents in total.
- **Cheap to keep loaded:** a 35B MoE with ~3B active parameters does the work at a fraction of the memory and compute of the large dense models most open-source personal agents load, while still driving tools, browsing, and background work reliably.

The snapshot is code only: configuration, credentials, and personal data are excluded.

## Features

- Chat with an agent you name and shape, with side chats for separate topics
- Web research with sources, using OpenAI web search
- A live browser in the chat that fills forms and navigates sites, which you can watch, take over or stop
- Reminders, monitors and a background heartbeat that only message you when something matters
- Goals turned into step-by-step plans that the agent keeps working on
- Documents, PDFs, images, podcasts and spaces: small apps with saved data
- Memory you can read and edit, stored as plain workspace files
- Approval cards for sends, form submissions, payments and new schedules, with once, task, site or always scopes
- An encrypted vault for logins and API keys; the model only sees stand-in tokens
- Voice mode with transcription and spoken replies

| Hatch your agent                     | Ask for an app, get a working one            |
| ------------------------------------ | -------------------------------------------- |
| ![Hatch](docs/media/hatch.gif)       | ![Build an app](docs/media/build-an-app.gif) |
| **It browses the web for you, live** | **Talk to it, and it talks back**            |
| ![Browser](docs/media/browser.gif)   | ![Voice mode](docs/media/voice.gif)          |

## Quick start with Docker Compose

Requirements: Docker Engine with the Compose plugin, Git, and an OpenAI API key.

```sh
git clone https://github.com/replit/amuse
cd amuse
cp .env.example .env    # then set OPENAI_API_KEY
docker compose up -d --build
```

Open **http://localhost:3000** and hatch your agent. Compose starts PostgreSQL alongside Amuse and
publishes the app on `127.0.0.1` only.

## From source

Use Node.js **22.9+**, pnpm **10.26.1** and PostgreSQL **14+**.

```sh
corepack enable
corepack prepare pnpm@10.26.1 --activate
pnpm install --frozen-lockfile
pnpm setup:browser      # downloads Chromium for the agent's live browser
cp .env.example .env    # set OPENAI_API_KEY and DATABASE_URL
pnpm build
pnpm start
```

Open **http://localhost:3000**. The server migrates its schema automatically before listening.

## Your OpenAI key

The agent (`gpt-6.2-sol`, with `gpt-6-luna` for quick steps), web search, image generation
(`gpt-image-2`), transcription and spoken replies all run on your OpenAI key. Set a spend limit on
your OpenAI project. Amuse also stops for the day at `AMUSE_DAILY_LIMIT` usage units (2,000 by
default) and pauses background jobs until the next day. Models and every other setting are in
[`.env.example`](.env.example).

Besides OpenAI, Amuse only contacts the sites the agent visits for you and, for weather questions,
the free [Open-Meteo](https://open-meteo.com/) API (weather data by Open-Meteo.com, CC BY 4.0). Fonts
and every other asset are served locally.

## Scope

Amuse is deliberately small. It's a web app for one person on one computer, it uses OpenAI models
only, and it connects to services through API keys and its live browser rather than MCP servers.
Notifications appear while an Amuse tab is open; there's no push to your phone yet.

## Security model

Amuse is built for one person on their own computer, so it has **no login**. It listens on
`127.0.0.1` only and refuses changes from other sites. Don't expose it to a network or the internet.
The agent can only reach public internet addresses, saved credentials are only sent to the site you
confirmed, and consequential actions ask you first. See [SECURITY.md](SECURITY.md) for the full model
and [docs/AUDIT.md](docs/AUDIT.md) for licenses and checks.

With Docker Compose, the browser runs without Chromium's own sandbox, and the container is the
isolation boundary.

Expect approval cards: the agent asks before it opens sites you did not name, before payments, and
before it changes memory after it reads web content.

The encryption key for saved credentials is created on first run in `.data/secret.key` (or the
`amuse-data` Docker volume). Back it up together with your database; without it, saved credentials
can't be read.

## Development

```sh
pnpm dev                # API on :3000 and the web app with hot reload on http://localhost:5173
pnpm typecheck
pnpm test               # server unit tests; no database, network or API key needed
pnpm format             # Prettier
```

The end-to-end suite (`pnpm test:e2e`) drives a real browser through every flow against a fresh
database. It makes real model calls, so it spends API credits; see [CONTRIBUTING.md](CONTRIBUTING.md).

The code is a pnpm monorepo: `apps/server` (Express API and the agent), `apps/web` (React and Vite),
`lib/db` (Drizzle schema and migrations) and `tests/e2e` (Playwright).

CI (`.github/workflows/ci.yml`) runs the format check, typechecks, unit tests, a dependency audit, the
build, a Docker build and a secrets scan on every pull request.

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md) and the [Changelog](CHANGELOG.md).

## Acknowledgements

The workspace-file layout (`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`,
`HEARTBEAT.md`, `BOOTSTRAP.md` and daily `memory/YYYY-MM-DD.md` notes) follows
[OpenClaw](https://github.com/openclaw/openclaw) (MIT).

## License

[Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses.
Amuse is an independent project, not affiliated with or endorsed by OpenAI.
