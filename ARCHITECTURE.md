# Architecture Overview — Data Slack Chatbot

This document explains the high-level architecture of the `data` Slack chatbot and documents the main components, runtime flows, and extension points for contributors.

## Goals
- Keep the bot simple and easy to understand for new developers.
- Provide a single source of truth for message flows, storage, and third-party integrations.
- Document where to change behavior safely (handlers, image generation, persistence).

## Components
- app.js — single entrypoint. Creates the Bolt `App`, registers event handlers, and wires third-party clients.
- Slack (Bolt JS) — receives events in socket mode and invokes the handlers in `app.message(...)` and `app.command(...)`.
- ChatGPT client (`chatgpt` ChatGPTAPI) — used for conversational responses with a persistent message store.
- Persistence (Keyv + KeyvRedis) — stores conversation state (parent message ids) and is backed by Redis when `REDIS_URL` is provided.
- OpenAI (official SDK) — used for image generation (model: `gpt-image-1`) via `openaiClient.images.generate()`.
- Upload flow — preferrs Slack `files.uploadV2()` and falls back to `files.upload()` when needed.
- Tests — minimal tests live in `test/package.test.js` and run with Node's built-in test runner.
- CI — GitHub Actions workflow runs install, lint, tests, and a node syntax check.

## Message flows

1. Incoming message arrives via Bolt socket mode.
2. Handlers in `app.message(...)` run:
   - General messages (hubot-style): simple pattern matches (danceparty, rickroll, etc.).
   - DM (`message.channel_type === 'im'`): forwarded to `handleMessage()` which calls ChatGPT; a "thinking" message is posted while processing.
   - MPIM: same as DM, but for multi-party DMs.
   - Direct mentions (using `directMention()`): shows help, special commands, or forwards to ChatGPT with the same thinking UX.
3. Slash command `/dalle`:
   - Immediately `ack()` the command to avoid Slack timeouts.
   - Respond with an ephemeral progress message.
   - Generate the image asynchronously via OpenAI, then upload to the channel with `files.uploadV2()`.

## Concurrency & UX
- Heavy work (image generation) is done asynchronously (setTimeout/worker-style) after an immediate ack/respond so Slack isn't blocked.
- A small thinking helper (`postThinking` / `clearThinking`) centralizes posting & deleting progress messages.

## Persistence & Conversation Context
- The bot stores parent message ids per user in `Keyv` (backed by `KeyvRedis` when `REDIS_URL` is set) so follow-up messages stay in conversation context.
- TTL and advisory `max` keys are configurable via `MEMORY_TTL_HOURS` and `MEMORY_MAX_KEYS`.

## Error handling & observability
- The app logs important lifecycle events and errors with `console` calls. Consider adding a structured logger (pino/winston) for production.
- There is an early env validation step that fails fast when required env vars are missing.
- Graceful shutdown handlers call `app.stop()` on SIGINT/SIGTERM.

## Security & secrets
- All secrets are passed via environment variables. Use the provided `.env.example` as a template.
- Do not check actual `.env` files into Git. Add them to `.gitignore` (already present).
- Consider using a secrets manager for production deployments (GitHub Secrets, cloud secret stores).

## Extension points
- Conversation logic: `handleMessage()` — change how messages are preprocessed or how the ChatGPT client is called.
- New Slack commands: add `app.command('/yourcommand', ...)` handlers.
- Image processing: `generateImage()` encapsulates the OpenAI image flow and is the single place to swap providers or add post-processing.
- Uploads: `files.uploadV2()` usage is centralized in `/dalle` upload flow; adjust extraction logic if Slack SDK changes.

## Local development & testing
- Use `.env.example` to create a local `.env` for development.
- Run `npm install` then `npm start` to run the bot locally (requires valid Slack & OpenAI tokens).
- Run tests via `npm test`.
- Lint & format with `npm run lint` and `npm run format`.

## Deployment
- The app uses socket mode; host it on any Node-capable environment (VM, container, Heroku, etc.).
- CI is configured to run lint/tests before merging (see `.github/workflows/ci.yml`).

## Notes and future improvements
- Replace console logging with structured logging and optional remote export.
- Consider wiring an explicit Redis client and passing it to KeyvRedis to control connection lifecycle more explicitly.
- Add richer tests (unit tests for helpers and integration tests for the upload flow — can be mocked).
