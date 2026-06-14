# AGENTS.md — repository memory for AI agents

Persistent, repo-specific context. Read this before starting work here.

## What this project is
A Slack bot built on **Slack Bolt** (Node.js, ES modules) that answers using **ChatGPT/OpenAI**. Conversation memory is stored in **Redis via Keyv** (`keyv` + `@keyv/redis`). Entry point: `app.js`. Tests: `node --test` under `test/`.

## Testing conventions
- **Mocking the external services (OpenAI/ChatGPT, Slack/Bolt) is REQUIRED and strictly necessary here.** They need network access and paid/credentialed calls that cannot run in the sandbox, so unit tests MUST mock those boundaries. This is the justified exception to the general "test real code paths, not mocks" guidance — mock *only* the external clients, and test all real internal logic directly.
- **Tests must pass with no secrets set** (no `SLACK_*` / `OPENAI_API_KEY` required).
- **Redis:** prefer mocking Keyv/Redis in unit tests. If a test genuinely needs a live store, run a **local** Redis only (`redis-server --daemonize yes`, `REDIS_URL=redis://localhost:6379`). **Never** connect to a remote/production Redis.
- Run tests **non-interactively** (`node --test`; never watch mode).
- After editing a source file, verify syntax (`node --check <file>`). Don't leave half-replaced code.
- Every symbol the tests import MUST actually be `export`ed from the source. After writing tests, run the suite and fix failures until green — don't finish on a red or unverified suite.

## Testability gotcha (important)
`app.js` starts the bot at module load via a top-level `(async () => { ... await app.start() })()` IIFE. **Guard startup behind a main-module check** so the module can be imported by tests without booting the bot or requiring env vars.

## Working autonomously
- Work to completion; make reasonable decisions instead of stopping to ask.
- **Escalation:** if you get genuinely stuck — the same step fails ~3 times, or you're not making progress — use the `switch_llm` tool to switch to profile **`qwen3-coder`** (a stronger coding model) and continue, instead of repeating a failing approach. Use it as a real "I'm stuck" lever, not for trivial hiccups.

## Backend note
The LLM backend is OpenAI-API-based. There's a stale `feature/llama-backend` branch that made it OpenAI-compatible/switchable (`LLM_API_BASE_URL` + `LLM_MODEL` env) to point at a local model — re-apply that idea onto current `main` rather than merging the old branch if local-LLM support is wanted (e.g. `http://kepler.local:11434/v1`).
