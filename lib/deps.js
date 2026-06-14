// Dependency factory. Production calls buildDeps() with no args during start().
// Tests pass overrides for any clients they want to fake.

import pkg from '@slack/bolt';
const { App } = pkg;
import { ChatGPTAPI } from 'chatgpt';
import { GoogleGenAI } from '@google/genai';
import Keyv from 'keyv';
import KeyvRedis from '@keyv/redis';

export function validateRequiredEnv(env = process.env, exit = process.exit) {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_BOT_USER_NAME'];
  if (!env.LLM_API_BASE_URL) required.push('OPENAI_API_KEY');
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('Please set them (see .env.example) and restart the process.');
    exit(1);
  }
}

export function buildDeps(overrides = {}, env = process.env) {
  const personalityPrompt =
    env.BOT_PERSONALITY ||
    `You are a Soong type Android named ${env.SLACK_BOT_USER_NAME}. You are a member of the crew of the USS Enterprise. You are a member of the science division. You respond to all inquiries in character as if you were Lieutenant Commander Data from Star Trek: The Next Generation. Reply only with spoken dialogue. Do not include third-person narration, stage directions, or parenthetical descriptions of your actions, expressions, or movements.`;

  const thinkingMessage =
    env.THINKING_MESSAGE || ':brain: _Accessing neural network pathways... Processing query..._';

  const redisUrl = env.REDIS_URL || 'redis://localhost:6379';
  const memoryTtlHours = parseInt(env.MEMORY_TTL_HOURS || '24', 10);
  const memoryMaxKeys = parseInt(env.MEMORY_MAX_KEYS || '10000', 10);
  const memoryTtlSeconds = Math.max(60, memoryTtlHours * 60 * 60);

  const llmApiBaseUrl = env.LLM_API_BASE_URL;
  const llmModel = env.LLM_MODEL || 'gpt-4o';
  const llmApiKey = env.OPENAI_API_KEY || 'not-needed';
  const isLocalLlm = !!llmApiBaseUrl;

  const geminiImageModel = env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

  const app =
    overrides.app ||
    new App({
      token: env.SLACK_BOT_TOKEN,
      socketMode: true,
      appToken: env.SLACK_APP_TOKEN,
    });

  let messageStore = overrides.messageStore;
  if (!messageStore) {
    const store = new KeyvRedis(redisUrl, {
      namespace: 'chatgpt-slackbot',
      ttl: memoryTtlSeconds,
      max: memoryMaxKeys,
    });
    messageStore = new Keyv({ store, namespace: 'chatgpt-slackbot' });
    console.log(
      `Keyv/Redis configured: REDIS_URL=${redisUrl}, MEMORY_TTL_HOURS=${memoryTtlHours}, MEMORY_MAX_KEYS=${memoryMaxKeys}`
    );
  }

  const chat =
    overrides.chat ||
    new ChatGPTAPI({
      apiKey: llmApiKey,
      messageStore,
      systemMessage: personalityPrompt,
      completionParams: { model: llmModel },
      ...(llmApiBaseUrl ? { apiBaseUrl: llmApiBaseUrl } : {}),
    });

  if (!overrides.chat) {
    if (llmApiBaseUrl) {
      console.log(`Using custom LLM endpoint: ${llmApiBaseUrl} with model: ${llmModel}`);
    } else {
      console.log(`Using OpenAI API with model: ${llmModel}`);
    }
  }

  const geminiClient =
    overrides.geminiClient !== undefined
      ? overrides.geminiClient
      : env.GEMINI_API_KEY
      ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })
      : null;

  return {
    app,
    chat,
    geminiClient,
    geminiImageModel,
    isLocalLlm,
    botName: env.SLACK_BOT_USER_NAME,
    botToken: env.SLACK_BOT_TOKEN,
    thinkingMessage,
    parentIds: new Map(),
  };
}
