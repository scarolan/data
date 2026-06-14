///////////////////////////////////////////////////////////////
// A bolt.js Slack chatbot augmented with OpenAI ChatGPT
// Requires a running Redis instance to persist the bot's memory
//
// Load environment variables from .env file (must be first)
import 'dotenv/config';
//
// Make sure you set the required environment variables in .env:
// SLACK_BOT_TOKEN - under the OAuth Permissions page on api.slack.com
// SLACK_APP_TOKEN - under your app's Basic Information page on api.slack.com
// SLACK_BOT_USER_NAME - must match the short name of your bot user
// OPENAI_API_KEY - get from here: https://platform.openai.com/account/api-keys
// BOT_PERSONALITY - (optional) customize the bot's character and behavior
// THINKING_MESSAGE - (optional) customize the "thinking" message
//
// Note: The /image slash command uses an asynchronous approach to handle
// Slack timeout limitations, generating the image in the background and
// posting directly to the channel when complete.
///////////////////////////////////////////////////////////////

import { directMention } from '@slack/bolt';
import fetch from 'node-fetch';

import { buildDeps, validateRequiredEnv } from './lib/deps.js';
import { cleanLocalLlmResponse, handleMessage } from './lib/chat.js';
import { generateImage } from './lib/image.js';
import {
  ASIMOV_RULES,
  IMAGE_REQUEST_GUIDANCE,
  RICKROLL_BLOCKS,
  TIKTOK_BLOCKS,
  buildDancePartyMessage,
  buildHelpText,
  fetchDadJoke,
  formatDadJoke,
  formatPodBayResponse,
  isDanceParty,
  isImageRequest,
  isLoveYou,
  isPodBayDoor,
  isRickroll,
  isTikTok,
} from './lib/responses.js';

export { cleanLocalLlmResponse, generateImage, handleMessage };

const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

// Post a "thinking" indicator. Returns the say() result so caller can later delete it.
async function postThinking(say, thinkingMessage, visibleText = thinkingMessage) {
  try {
    return await say({
      text: visibleText,
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: thinkingMessage }],
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to post thinking message:', err && err.message ? err.message : err);
    return null;
  }
}

async function clearThinking(app, channel, ts) {
  if (!ts) return;
  try {
    await app.client.chat.delete({ channel, ts });
  } catch (err) {
    console.log('Error deleting thinking message:', err && err.message ? err.message : err);
  }
}

// Wire all the Bolt event listeners onto `deps.app`. Pure: takes deps, registers handlers.
export function registerHandlers(deps) {
  const {
    app,
    chat,
    geminiClient,
    geminiImageModel,
    isLocalLlm,
    botName,
    botToken,
    thinkingMessage,
    parentIds,
  } = deps;

  app.message(async ({ message, say, context }) => {
    if (!message) {
      console.log('Received undefined message');
      return;
    }
    if (context.botUserId && message.text && message.text.includes(`<@${context.botUserId}>`)) {
      return;
    }
    if (message.subtype) return;
    if (message.bot_id) return;

    if (isLoveYou(message.text)) {
      await say('I know.');
      return;
    }

    if (isPodBayDoor(message.text)) {
      const userInfo = await app.client.users.info({ token: botToken, user: message.user });
      const displayName = userInfo.user.profile.display_name || userInfo.user.real_name;
      await say(formatPodBayResponse(displayName));
      return;
    }

    if (isDanceParty(message.text)) {
      await say(buildDancePartyMessage());
      return;
    }

    if (isTikTok(message.text)) {
      await say(TIKTOK_BLOCKS);
      return;
    }

    if (isRickroll(message.text)) {
      await say(RICKROLL_BLOCKS);
      return;
    }

    const channelType = message.channel_type;
    if (channelType !== 'im' && channelType !== 'mpim') return;

    if (!message.text || message.text.trim() === '') return;
    if (message.edited || message.subtype) return;

    let thinking = null;
    try {
      thinking = await postThinking(say, thinkingMessage);
      const responseText = await handleMessage(message, { chat, parentIds, isLocalLlm });
      if (thinking && thinking.ts) await clearThinking(app, message.channel, thinking.ts);
      await say(responseText);
    } catch (error) {
      console.error(`Error in ${channelType} message processing:`, error);
      if (thinking && thinking.ts) await clearThinking(app, message.channel, thinking.ts);
      await say(GENERIC_ERROR_TEXT);
    }
  });

  app.message(directMention(), async ({ message, say }) => {
    if (!message) return;
    if (message.subtype) return;

    if (message.text && message.text.toLowerCase().includes('help')) {
      await say(buildHelpText(botName));
      return;
    }

    if (message.text && message.text.toLowerCase().includes('the rules')) {
      await say(ASIMOV_RULES);
      return;
    }

    if (message.text && message.text.toLowerCase().includes('dad joke')) {
      try {
        const joke = await fetchDadJoke(fetch);
        const { joke: jokeText, zinger } = formatDadJoke(joke);
        await say(jokeText);
        if (zinger) {
          await new Promise((resolve) => setTimeout(resolve, 10000));
          await say(zinger);
        }
      } catch (error) {
        console.error(error);
        await say(`Encountered an error :( ${error}`);
      }
      return;
    }

    if (!message.text || message.text.trim() === '') return;
    if (
      message.edited ||
      message.thread_ts ||
      message.parent_user_id ||
      message.bot_profile ||
      message.bot_id
    ) {
      return;
    }

    if (isImageRequest(message.text)) {
      await say(IMAGE_REQUEST_GUIDANCE);
      return;
    }

    let thinking = null;
    try {
      thinking = await postThinking(say, thinkingMessage);
      const responseText = await handleMessage(message, { chat, parentIds, isLocalLlm });
      if (thinking && thinking.ts) await clearThinking(app, message.channel, thinking.ts);
      await say(responseText);
    } catch (error) {
      console.error('Error in direct mention processing:', error);
      if (thinking && thinking.ts) await clearThinking(app, message.channel, thinking.ts);
      await say(GENERIC_ERROR_TEXT);
    }
  });

  app.command('/image', async ({ command, ack, respond, client }) => {
    try {
      await ack();

      if (!command.text || command.text.trim() === '') {
        await respond({
          text: 'I need a description to generate an image. Please provide a prompt after the /image command.',
          response_type: 'ephemeral',
        });
        return;
      }

      const prompt = command.text;
      await respond({
        text: `:art: Generating image for prompt: "${prompt}"...`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `:art: *Generating image with Gemini*` },
          },
          { type: 'section', text: { type: 'mrkdwn', text: `> ${prompt}` } },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: ':hourglass_flowing_sand: _This may take a few moments..._' },
            ],
          },
        ],
        response_type: 'ephemeral',
      });

      queueMicrotask(async () => {
        try {
          const imageBuffer = await generateImage(prompt, {
            client: geminiClient,
            model: geminiImageModel,
          });
          await client.files.uploadV2({
            token: botToken,
            channel_id: command.channel_id,
            file: imageBuffer,
            filename: 'gemini-image.png',
            title: prompt,
            initial_comment: `Here's the Gemini image for: "${prompt}"`,
            alt_text: `Gemini generated image for: ${prompt}`,
          });
        } catch (error) {
          console.error('Error in async image generation:', error);
          await respond({
            text: `❌ Image generation failed: ${error.message}`,
            response_type: 'ephemeral',
            replace_original: false,
          });
        }
      });
    } catch (error) {
      console.error('Error in initial /image command handling:', error);
      try {
        await respond({
          text: `❌ Error processing command: ${error.message}`,
          response_type: 'ephemeral',
        });
      } catch (respondError) {
        console.error('Failed to send error response:', respondError);
      }
    }
  });
}

export async function start(deps = buildDeps()) {
  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`Received ${signal}, stopping app...`);
    try {
      await deps.app.stop();
    } catch (err) {
      console.error('Error while stopping app:', err && err.message ? err.message : err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err && err.stack ? err.stack : err);
    shutdown('uncaughtException');
  });

  registerHandlers(deps);
  await deps.app.start(process.env.PORT || 3000);
  console.log(`${deps.botName} is alive!`);
}

// Only boot the bot when this module is run directly. This is what lets the
// test suite import app.js without triggering env validation or Slack connect.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  validateRequiredEnv();
  start();
}
