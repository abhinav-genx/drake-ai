# DRAKE·AI

DRAKE·AI is a **browser-agent orchestrator**. You give it a high-level goal in
natural language (e.g. _"check my Gmail for the latest invoice and reply that
I'll pay it Friday"_) and it plans the work, spins up autonomous browser
sub-agents that actually drive a real cloud browser to do it, and streams the
progress back to you live.

It is built on **Next.js 16 (App Router)** with a planning LLM served through
[OpenRouter](https://openrouter.ai) and browser automation powered by
[Stagehand](https://github.com/browserbase/stagehand) running on
[Browserbase](https://browserbase.com).

🔗 **Live demo:** [drake-ai-three.vercel.app](https://drake-ai-three.vercel.app/)

---

## How it works

```mermaid
flowchart TD
    U[User goal] --> O[Orchestrator LLM]
    O -->|plans via XML tags| P{Decision}
    P -->|SUB_AGENTS| B[Spawn browser sub-agents]
    B --> R[Run in parallel on Browserbase]
    R -->|SUB_AGENTS_RESULTS| O
    P -->|FINISH / RESPONSE| U
```

1. **Orchestrator LLM** (`src/provider/openrouter.ts`, prompt in
   `src/prompts.ts`) reasons about the goal and emits structured XML tags —
   `<SUB_AGENTS>`, `<SUB_AGENT>`, `<FINISH>`, `<RESPONSE>`, `<LOG>`.
2. **Agent loop** (`src/agent/index.ts`) parses those tags, batches the
   requested sub-agents, and runs them. `MAX_ITERATIONS = 8`,
   `MAX_DEPTH = 3`.
3. **Browser sub-agent** (`src/utils/do-browser-task.ts`) is a single
   Stagehand *hybrid* agent run against a real browser session. Each sub-agent
   gets a **goal**, not a click script, and figures out the steps itself.
4. Results are folded back into a `<SUB_AGENTS_RESULTS>` block (with per-agent
   `<STATUS>` and `<SUMMARY>`) so the orchestrator can retry only what failed
   and decide the next step.

### Per-user login persistence

Every user gets their **own** Browserbase Context so their cookies and
localStorage (Gmail, WhatsApp, etc.) are isolated and never shared.

- `src/utils/browser-context.ts` — resolves/creates a user's context.
- `src/utils/context-lock.ts` — sub-agents that log in run **one-at-a-time**
  (persist writes are serialized) so they never clobber each other's session.
  Read-only sub-agents still run fully in parallel.

---

## Tech stack

| Concern            | Choice                                             |
| ------------------ | -------------------------------------------------- |
| Framework          | Next.js 16 (App Router), React 19                  |
| Language           | TypeScript                                         |
| Styling            | Tailwind CSS v4                                     |
| Planning LLM       | OpenRouter                                         |
| Browser automation | Stagehand `3.7.1` (hybrid agent API) + Browserbase |
| Database / ORM     | PostgreSQL + Prisma                                |
| Auth               | Email + password (bcrypt), JWT sessions via `jose` |
| Validation         | Zod                                                |

> **Note:** Stagehand is pinned to `3.7.1`. Stagehand v4 removed the
> `agent()` / hybrid API this project relies on.

---

## Project structure

```
src/
  prompts.ts                 # Orchestrator system prompt
  agent/index.ts             # Agent class: reasoning loop + sub-agent orchestration
  provider/openrouter.ts     # LLM client (OpenRouter)
  utils/
    do-browser-task.ts       # One Stagehand hybrid browser sub-agent run
    browser-context.ts       # Per-user Browserbase context
    context-lock.ts          # Serializes persist:true sessions
    xml-parser.ts            # Parses the orchestrator's XML tags
  lib/
    auth.ts                  # Session / JWT helpers
    prisma.ts                # Prisma client singleton
  app/
    page.tsx                 # Chat UI (SSE stream of AgentEvents)
    api/
      agent/route.ts         # SSE endpoint that runs the agent
      auth/                  # login / logout / me / register
      browser-login/route.ts # Kick off an interactive browser login flow
prisma/
  schema.prisma             # User, BrowserContext, Conversation, Message
```

---

## Data model

- **User** — account; owns one `BrowserContext` and many `Conversation`s.
- **BrowserContext** — the user's isolated Browserbase context id.
- **Conversation** / **Message** — persisted chat history (`user` /
  `assistant` roles).

---

## Getting started

### 1. Prerequisites

- Node.js 20+
- A PostgreSQL database
- API keys for OpenRouter and Browserbase (and optionally Anthropic)

### 2. Install

```bash
npm install
```

### 3. Configure environment

Create a `.env` file:

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/drake"

# LLM (planning) — OpenRouter
OPENROUTER_API_KEY="sk-or-..."

# Browserbase
BROWSERBASE_API_KEY="bb_..."
BROWSERBASE_PROJECT_ID="..."

# Browser sub-agent model creds.
# Prefer a native Anthropic key; otherwise the OpenRouter key is used
# (proxying anthropic/ model slugs through https://openrouter.ai/api/v1).
ANTHROPIC_API_KEY="sk-ant-..."        # optional if using OpenRouter fallback
STAGEHAND_MODEL="anthropic/claude-haiku-4-5-20251001"

# Auth
JWT_SECRET="a-long-random-secret"
```

### 4. Set up the database

```bash
npm run db:migrate      # apply migrations
# npm run db:studio     # optional: open Prisma Studio
```

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Scripts

| Script               | Description                              |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Start the Next.js dev server             |
| `npm run build`      | `prisma generate` + production build     |
| `npm run start`      | Start the production server              |
| `npm run lint`       | Run ESLint                               |
| `npm run db:migrate` | Apply Prisma migrations (`migrate dev`)  |
| `npm run db:studio`  | Open Prisma Studio                       |

---

## How a request flows

1. User submits a goal from the chat UI (`src/app/page.tsx`).
2. `POST /api/agent` opens a **Server-Sent Events** stream and constructs the
   `Agent`.
3. The orchestrator LLM plans, emitting `response` / `log` /
   `sub_agents_spawned` events as it goes.
4. Sub-agents run on Browserbase; their results feed back into the loop.
5. The agent finishes with a final response, streamed live to the UI.
