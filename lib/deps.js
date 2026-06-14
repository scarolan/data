// Dependency factory. Production calls buildDeps() with no args during start().
// Tests pass overrides for any clients they want to fake.

import pkg from '@slack/bolt';
const { App } = pkg;
import { GoogleGenAI } from '@google/genai';
import Keyv from 'keyv';
import KeyvRedis from '@keyv/redis';

import { makeOllamaChat, makeGeminiChat } from './chat-backends.js';

const DEFAULT_OLLAMA_MODEL = 'llama3.1';

// OLLAMA_THINK accepts: "true"/"false", "high"/"medium"/"low", or unset.
// Anything else is treated as unset (silently — keeps the surface forgiving).
function parseThink(raw) {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return undefined;
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return undefined;
}
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-3-flash-latest';
const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_CHAT_BACKEND = 'ollama';

export function validateRequiredEnv(env = process.env, exit = process.exit) {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_BOT_USER_NAME'];
  const backend = (env.CHAT_BACKEND || DEFAULT_CHAT_BACKEND).toLowerCase();
  if (backend === 'gemini') required.push('GEMINI_API_KEY');
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('Please set them (see .env.example) and restart the process.');
    exit(1);
  }
}

export function buildDeps(overrides = {}, env = process.env) {
  const systemMessage =
    env.BOT_PERSONALITY ||
    `You are a Soong type Android named ${env.SLACK_BOT_USER_NAME}. You are a member of the crew of the USS Enterprise. You are a member of the science division. You respond to all inquiries in character as if you were Lieutenant Commander Data from Star Trek: The Next Generation. Reply only with spoken dialogue. Do not include third-person narration, stage directions, or parenthetical descriptions of your actions, expressions, or movements.`;

  const thinkingMessage =
    env.THINKING_MESSAGE || ':brain: _Accessing neural network pathways... Processing query..._';

  const redisUrl = env.REDIS_URL || 'redis://localhost:6379';
  const memoryTtlHours = parseInt(env.MEMORY_TTL_HOURS || '24', 10);
  const memoryTtlMs = Math.max(60_000, memoryTtlHours * 60 * 60 * 1000);

  const backend = (env.CHAT_BACKEND || DEFAULT_CHAT_BACKEND).toLowerCase();
  const ollamaHost = env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
  const ollamaModel = env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  const ollamaThink = parseThink(env.OLLAMA_THINK);
  const geminiChatModel = env.GEMINI_CHAT_MODEL || DEFAULT_GEMINI_CHAT_MODEL;
  const geminiImageModel = env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;

  const app =
    overrides.app ||
    new App({
      token: env.SLACK_BOT_TOKEN,
      socketMode: true,
      appToken: env.SLACK_APP_TOKEN,
    });

  let convoStore = overrides.convoStore;
  if (!convoStore) {
    const store = new KeyvRedis(redisUrl);
    convoStore = new Keyv({ store, namespace: 'data-slackbot', ttl: memoryTtlMs });
    console.log(
      `Keyv/Redis configured for conversation history: REDIS_URL=${redisUrl}, MEMORY_TTL_HOURS=${memoryTtlHours}`
    );
  }

  const geminiClient =
    overrides.geminiClient !== undefined
      ? overrides.geminiClient
      : env.GEMINI_API_KEY
      ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })
      : null;

  let chat = overrides.chat;
  if (!chat) {
    if (backend === 'gemini') {
      chat = makeGeminiChat({ client: geminiClient, model: geminiChatModel, systemMessage });
      console.log(`Chat backend: gemini (model: ${geminiChatModel})`);
    } else if (backend === 'ollama') {
      chat = makeOllamaChat({
        host: ollamaHost,
        model: ollamaModel,
        systemMessage,
        think: ollamaThink,
      });
      const thinkSuffix = ollamaThink ? `, think=${ollamaThink}` : '';
      console.log(`Chat backend: ollama @ ${ollamaHost} (model: ${ollamaModel}${thinkSuffix})`);
    } else {
      throw new Error(
        `Unknown CHAT_BACKEND="${backend}". Supported values: "ollama" (default), "gemini".`
      );
    }
  }

  return {
    app,
    chat,
    convoStore,
    geminiClient,
    geminiImageModel,
    botName: env.SLACK_BOT_USER_NAME,
    botToken: env.SLACK_BOT_TOKEN,
    thinkingMessage,
  };
}
