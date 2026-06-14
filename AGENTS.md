# AGENTS.md — repository memory for AI agents

Persistent, repo-specific context. Read this before starting work here.

## What this project is
A Slack bot built on **Slack Bolt** (Node.js, ES modules) that answers using **ChatGPT/OpenAI** (or any OpenAI-compatible local LLM via `LLM_API_BASE_URL`). Conversation memory is stored in **Redis via Keyv** (`keyv` + `@keyv/redis`). Image generation uses **Gemini (Nano Banana)** via `@google/genai`.

Entry point: `app.js` — a thin glue layer that wires Bolt event handlers onto pure helpers in `lib/`:
- `lib/responses.js` — pure trigger-word matchers, dance-party RNG, help text, Asimov rules, dad-joke fetch/format
- `lib/chat.js` — `handleMessage`, `cleanLocalLlmResponse` (deps injected)
- `lib/image.js` — `generateImage` (Gemini client + model injected)
- `lib/deps.js` — `buildDeps()` factory and `validateRequiredEnv()`

Tests: `node --test` under `test/`.

## Testing conventions
- **Mocking the external services (OpenAI/ChatGPT, Slack/Bolt) is REQUIRED and strictly necessary here.** They need network access and paid/credentialed calls that cannot run in the sandbox, so unit tests MUST mock those boundaries. This is the justified exception to the general "test real code paths, not mocks" guidance — mock *only* the external clients, and test all real internal logic directly.
- **Tests must pass with no secrets set** (no `SLACK_*` / `OPENAI_API_KEY` required).
- **Redis:** prefer mocking Keyv/Redis in unit tests. If a test genuinely needs a live store, run a **local** Redis only (`redis-server --daemonize yes`, `REDIS_URL=redis://localhost:6379`). **Never** connect to a remote/production Redis.
- Run tests **non-interactively** (`node --test`; never watch mode).
- After editing a source file, verify syntax (`node --check <file>`). Don't leave half-replaced code.
- Every symbol the tests import MUST actually be `export`ed from the source. After writing tests, run the suite and fix failures until green — don't finish on a red or unverified suite.

## Testability conventions
`app.js` only boots the bot when run as the main module (`import.meta.url === \`file://${process.argv[1]}\``); importing it under `node --test` is safe and does **not** read env vars or open a Slack connection.

To add tests for new logic:
- Put pure helpers in `lib/responses.js` (or a new sibling module) and import them directly.
- For anything that touches an external client (ChatGPT, Gemini, Slack), take the client as a `deps` parameter and have tests pass a fake. See `handleMessage(message, { chat, parentIds, isLocalLlm })` and `generateImage(prompt, { client, model })` for the pattern.
- Avoid adding new module-level `new SomeClient(...)` instantiations — extend `buildDeps()` in `lib/deps.js` instead so tests can override.

## Working autonomously
- Work to completion; make reasonable decisions instead of stopping to ask.
- **Escalation:** if you get genuinely stuck — the same step fails ~3 times, or you're not making progress — use the `switch_llm` tool to switch to profile **`qwen3-coder`** (a stronger coding model) and continue, instead of repeating a failing approach. Use it as a real "I'm stuck" lever, not for trivial hiccups.

## Backend note
LLM backend is OpenAI-API-based and already supports OpenAI-compatible local endpoints via `LLM_API_BASE_URL` + `LLM_MODEL` (e.g. `http://kepler.local:11434/v1` running Ollama). Image generation uses Gemini regardless of which LLM backend is configured; the `/image` slash command requires `GEMINI_API_KEY`.
