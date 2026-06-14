# CLAUDE.md

## Project Overview

**Data** is an LLM-powered Slack chatbot with a Star Trek personality (Lt. Commander Data). It uses the Slack Bolt framework with ChatGPT (or any OpenAI-compatible local LLM) for conversations and Gemini (Nano Banana 2) for image generation.

## Quick Reference

```bash
npm install      # Install dependencies
npm start        # Run the bot
npm test         # Run tests (node --test)
npm run lint     # Check code style
npm run lint:fix # Auto-fix linting issues
npm run format   # Format with Prettier
```

## Architecture

- **`app.js` is a thin glue layer** (~300 lines) that wires Bolt handlers onto pure helpers in `lib/`
- **Socket Mode**: no public URL required; uses WebSocket connection
- **Persistence**: Redis-backed via Keyv for conversation context
- **Node.js 18+** (CI matrices on 18, 20, 22; production runs 18 but it's EOL)
- ESM modules throughout

## Layout

```
app.js                  # Bolt handler wiring + start() (~300 lines)
lib/
  responses.js          # Pure trigger-word matchers, help text, dad joke, Asimov rules
  chat.js               # handleMessage, cleanLocalLlmResponse (deps injected)
  image.js              # generateImage via Gemini (client + model injected)
  deps.js               # buildDeps() factory, validateRequiredEnv()
test/
  responses.test.js     # Matcher + helper coverage
  chat.test.js          # handleMessage with mocked ChatGPT
  image.test.js         # generateImage with mocked Gemini
  app.test.js           # Import-safety smoke test
  package.test.js       # package.json sanity checks
manifest.yaml           # Slack app configuration
package.json            # Dependencies and scripts
.env.example            # Environment variable template
ARCHITECTURE.md         # Detailed architecture documentation
AGENTS.md               # Conventions for AI agents working in this repo
.github/workflows/ci.yml  # Lint + tests + syntax check + audit on Node 18/20/22
```

## Key Exports

`app.js` only boots the bot when run as the main module (`import.meta.url === \`file://${process.argv[1]}\``); importing it from tests is safe. It re-exports the unit-testable functions from `lib/`:

| Export | Source | Purpose |
|--------|--------|---------|
| `handleMessage(msg, { chat, parentIds, isLocalLlm })` | `lib/chat.js` | Route Slack message through ChatGPT, threading per-user context |
| `generateImage(prompt, { client, model })` | `lib/image.js` | Call Gemini and return a PNG `Buffer` |
| `cleanLocalLlmResponse(text, isLocalLlm)` | `lib/chat.js` | Strip Llama/Gemma tokenizer artifacts |
| `registerHandlers(deps)` | `app.js` | Attach all Bolt listeners to `deps.app` |
| `start(deps)` | `app.js` | Wire signals + register handlers + `app.start()` |

## Message Handlers

1. **General messages** (`app.message()`) — DMs, channel messages, MPIM
2. **Direct mentions** (`app.message(directMention())`) — `@Data` mentions
3. **Slash commands** (`app.command('/image')`) — Image generation via Gemini

## Environment Variables

Loaded from `.env` via dotenv (see `.env.example`).

**Required:**
- `SLACK_BOT_TOKEN` — Bot OAuth token (`xoxb-...`)
- `SLACK_APP_TOKEN` — App-level token for Socket Mode (`xapp-...`)
- `SLACK_BOT_USER_NAME` — Bot's display name in Slack
- `OPENAI_API_KEY` — required unless using a local LLM (see `LLM_API_BASE_URL`)
- `GEMINI_API_KEY` — required for the `/image` slash command

**Optional:**
- `LLM_API_BASE_URL` — point at an OpenAI-compatible local endpoint (e.g. `http://kepler.local:11434/v1` for Ollama)
- `LLM_MODEL` — model name for the chat backend (default: `gpt-4o`)
- `GEMINI_IMAGE_MODEL` — override the default image model (default: `gemini-3.1-flash-image`)
- `BOT_PERSONALITY` — Custom system prompt for ChatGPT
- `THINKING_MESSAGE` — Custom processing indicator text
- `REDIS_URL` — Redis connection (default: `redis://localhost:6379`)
- `MEMORY_TTL_HOURS` — Conversation memory lifetime (default: 24)
- `MEMORY_MAX_KEYS` — Max stored message IDs (default: 10000)

## Code Style

- ESM modules (`import`/`export`)
- Prettier: 2-space indent, 100 char width, trailing commas (ES5)
- ESLint with Prettier integration
- Async/await for all async operations

## External APIs

- **Slack** (Bolt SDK) — Messaging, file uploads, events
- **OpenAI ChatGPT** (`gpt-4o`) — Conversations via `chatgpt` package; the same package transparently talks to any OpenAI-compatible endpoint when `LLM_API_BASE_URL` is set
- **Google Gemini** (`gemini-3.1-flash-image`, "Nano Banana 2") — Image generation via `@google/genai`
- **icanhazdadjoke.com** — Dad jokes endpoint
- **Redis** — Conversation context persistence

## Canned Responses

Pattern matchers live in `lib/responses.js` as pure functions; the Bolt handlers in `app.js` are thin shims that call `say()` with the result:

- `"i love you"` → `"I know."`
- `"open the pod bay door"` → HAL 9000 reference
- `"danceparty"` → Emoji celebration
- `"rickroll"` / `"tiktok"` → button to external page
- `"help"` (when @-mentioned) → command list
- `"the rules"` (when @-mentioned) → Asimov's laws
- `"dad joke"` (when @-mentioned) → fetched from icanhazdadjoke.com

## Testing

- Uses Node.js built-in test runner (`node --test`)
- Tests live under `test/` — one `*.test.js` per source module
- **Tests must not require any env vars or external services.** Mock the external clients (Slack/Bolt, ChatGPT, Gemini, fetch) at the boundary; test real internal logic directly. See `test/chat.test.js` for the deps-injection pattern.
- CI: lint → tests → syntax-check `app.js` and every `lib/*.js` → `npm audit --omit=dev --audit-level=high` (non-blocking)

## Common Tasks

**Adding a new canned response:** Add a matcher + helper to `lib/responses.js`, write a unit test for it in `test/responses.test.js`, then add a thin call site inside `registerHandlers()` in `app.js`.

**Modifying bot personality:** Set `BOT_PERSONALITY` env var, or edit the default in `buildDeps()` in `lib/deps.js`.

**Adding a new slash command:** Register with `app.command('/commandname')` inside `registerHandlers()` in `app.js`, and add the entry to `manifest.yaml`. Remember to re-sync the manifest to the Slack app and reinstall before Slack will route the new command.

**Adding a function that calls an external API:** Don't instantiate the client at module scope. Add it to `buildDeps()` in `lib/deps.js`, pass it through `deps`, and accept the client as a parameter on the function so tests can inject a fake (see `generateImage` for the pattern).
