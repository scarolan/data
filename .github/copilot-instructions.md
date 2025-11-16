# Copilot Instructions for Data Slack Chatbot

## Project Overview
A ChatGPT-powered Slack bot built with Bolt JS. Single-file architecture (`app.js`, ~900 lines) with Redis-backed conversation memory and DALL-E image generation. Uses ES modules and Socket Mode for real-time Slack events.

## Architecture Patterns

### Message Flow Strategy
- **Hubot-style pattern matching**: General `app.message()` listener filters phrases without requiring @mentions (e.g., "danceparty", "rickroll")
- **Direct mentions**: Separate `app.message(directMention())` handler for @botname interactions to prevent duplicate responses
- **Channel types**: DM (`im`), multi-party DM (`mpim`), and channels handled with different logic paths
- **Critical safeguards**: Always check for `message.subtype`, `message.bot_id`, and empty `message.text` to avoid processing system events, bot messages, or malformed data

### Async UX Pattern for Heavy Operations
The `/dalle` slash command demonstrates the project's async pattern for long-running tasks:
1. **Immediate `ack()`** to prevent Slack 3-second timeouts
2. **Ephemeral progress message** via `respond()` 
3. **setTimeout() worker pattern** (100ms delay) for background processing
4. **Direct channel posting** when complete using `files.uploadV2()` with defensive fallback to legacy `files.upload()`

### Conversation Memory Architecture
- Uses `chatgpt` library's ChatGPTAPI with `Keyv`/`KeyvRedis` for persistent `parentMessageId` tracking
- In-memory Map (`userParentMessageIds`) supplements Redis storage
- Configurable TTL (`MEMORY_TTL_HOURS`, default 24h) and advisory max keys (`MEMORY_MAX_KEYS`, default 10000)
- Redis namespace: `chatgpt-slackbot`

### "Thinking" UX Helper
Centralized `postThinking()` / `clearThinking()` pattern used consistently across DM, MPIM, and direct mention handlers:
```javascript
let thinking = await postThinking(say);
// ... do heavy work ...
await clearThinking(message.channel, thinking.ts);
```

## Development Workflows

### Environment Setup
Required env vars validated at startup with `validateRequiredEnv()`:
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_BOT_USER_NAME`, `OPENAI_API_KEY`
- Optional: `BOT_PERSONALITY`, `THINKING_MESSAGE`, `REDIS_URL`, `MEMORY_TTL_HOURS`, `MEMORY_MAX_KEYS`

### Running Locally
```bash
npm install
npm start  # Starts socket mode connection
```

### Testing & Linting
- **Tests**: Node.js native test runner (`node --test`), minimal smoke tests in `test/package.test.js`
- **Linting**: ESLint with Prettier integration (`npm run lint` / `npm run lint:fix`)
- **CI**: GitHub Actions runs install → lint → test → syntax check on PRs and main branch pushes

### Slack App Configuration
- Uses `manifest.yaml` for app setup (socket mode enabled, scopes: `chat:write`, `files:write`, `app_mentions:read`, etc.)
- Bot events: `message.channels`, `message.im`, `message.groups`, `message.mpim`
- Slash command: `/dalle` with `<prompt>` usage hint

## Project-Specific Conventions

### Error Handling Philosophy
- **Fail fast**: Startup validation exits process if env vars missing
- **User-friendly errors**: ChatGPT errors return in-character Data-themed messages ("neural pathways experiencing malfunction")
- **Graceful shutdown**: SIGINT/SIGTERM handlers call `app.stop()` before exit

### Personality System
- Default: Star Trek Data personality (Soong-type Android, USS Enterprise crew)
- Customizable via `BOT_PERSONALITY` env var with fallback to `defaultPersonality` constant
- Image generation requests in natural language redirected to `/dalle` command with usage instructions

### Image Generation Specifics
- Model: `gpt-image-1` via OpenAI SDK (not ChatGPT library)
- Size: Fixed `1024x1024`, n=1, returns `b64_json`
- Size warning logged if image > 5MB
- Upload logic has defensive file ID extraction from various response shapes due to Slack API inconsistencies

### Code Organization
- All logic in single `app.js` file (intentional simplicity per ARCHITECTURE.md goals)
- No TypeScript, no build step—direct Node execution
- ES modules with named imports (`import { App } from '@slack/bolt'`)

## Extension Points

### Adding New Hubot-Style Commands
Add to general `app.message()` handler with pattern match:
```javascript
if (message.text && message.text.match(/your pattern/i)) {
  await say('response');
  return;
}
```

### Adding New @mention Commands  
Add to `app.message(directMention())` handler after help/rules examples.

### Adding New Slash Commands
Follow `/dalle` pattern: immediate `ack()`, ephemeral respond, setTimeout worker for heavy lifting.

### Modifying ChatGPT Behavior
Edit `handleMessage()` function—single point for message preprocessing and ChatGPTAPI interaction.

## Common Pitfalls

1. **Duplicate responses**: Always check for direct mentions in general handler and skip them
2. **Slack timeouts**: Never do heavy work before `ack()` in slash commands
3. **Empty message handling**: Always validate `message.text` exists and has content before processing
4. **Bot loops**: Always filter out `message.bot_id` to prevent bot-to-bot conversations
5. **Upload API instability**: Always implement fallback from `uploadV2` to legacy `upload` method

## Key Files Reference
- `app.js` — entire application logic
- `manifest.yaml` — Slack app configuration (scopes, events, commands)
- `ARCHITECTURE.md` — high-level component overview and rationale
- `test/package.test.js` — minimal smoke tests for package.json validation
- `.github/workflows/ci.yml` — CI pipeline (Node 18, lint, test, syntax check)
