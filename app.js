///////////////////////////////////////////////////////////////
// A bolt.js Slack chatbot. Wires Bolt event handlers onto pure
// helpers in lib/. Conversation goes through native Ollama or
// Gemini SDKs; tool calls are dispatched inside lib/chat.js.
///////////////////////////////////////////////////////////////

import 'dotenv/config';
import { directMention } from '@slack/bolt';
import fetch from 'node-fetch';

import { buildDeps, validateRequiredEnv } from './lib/deps.js';
import { handleMessage, clearHistory } from './lib/chat.js';
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

export { generateImage, handleMessage };

const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

const THINKING_REACTION = 'brain';

// Add a :brain: reaction to the user's message to signal Data is processing.
// Returns true if the reaction landed (so caller can remove it on reply).
async function addThinkingReaction(app, channel, ts) {
  if (!channel || !ts) return false;
  try {
    await app.client.reactions.add({ channel, timestamp: ts, name: THINKING_REACTION });
    return true;
  } catch (err) {
    console.warn('Failed to add thinking reaction:', err && err.message ? err.message : err);
    return false;
  }
}

// Pull the user-visible text off the chat result. Thinking traces are
// captured by the backend but deliberately not rendered — the :brain:
// reaction on the user's message is Data's "I'm working on this" UI.
function buildReplyPayload({ text }) {
  return text;
}

async function removeThinkingReaction(app, channel, ts) {
  if (!channel || !ts) return;
  try {
    await app.client.reactions.remove({ channel, timestamp: ts, name: THINKING_REACTION });
  } catch (err) {
    console.log('Failed to remove thinking reaction:', err && err.message ? err.message : err);
  }
}

const VISION_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Pull any image attachments off a Slack message, fetch them with the bot
// token, return `[{ mimeType, data: base64 }]` for the chat layer. Anything
// non-image or that fails to fetch is logged and skipped.
async function extractMessageImages(message, botToken) {
  if (!message.files?.length) return [];
  const allFiles = message.files;
  const imageFiles = allFiles.filter((f) => VISION_MIME_TYPES.includes(f.mimetype));
  if (allFiles.length && !imageFiles.length) {
    console.log(
      `Message has ${allFiles.length} attachment(s) but none are supported image types:`,
      allFiles.map((f) => f.mimetype).join(', ')
    );
  }
  const out = [];
  for (const file of imageFiles) {
    try {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!res.ok) {
        console.warn(`Slack file fetch ${file.id}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      out.push({ mimeType: file.mimetype, data: buf.toString('base64') });
      console.log(
        `Vision: extracted ${file.mimetype} (${(buf.length / 1024).toFixed(1)}KB) from Slack file ${
          file.id
        }`
      );
    } catch (err) {
      console.warn(`Slack file fetch ${file.id} failed:`, err.message);
    }
  }
  return out;
}

// Wire all the Bolt event listeners onto `deps.app`. Pure: takes deps, registers handlers.
export function registerHandlers(deps) {
  const { app, chat, convoStore, geminiClient, geminiImageModel, botName, botToken } = deps;

  app.message(async ({ message, say, context }) => {
    if (!message) {
      console.log('Received undefined message');
      return;
    }
    if (context.botUserId && message.text && message.text.includes(`<@${context.botUserId}>`)) {
      return;
    }
    // Slack tags messages with attached files as subtype 'file_share' — let
    // those through so vision uploads reach the LLM. All other subtypes
    // (edits, deletes, channel joins, etc.) are skipped.
    if (message.subtype && message.subtype !== 'file_share') return;
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

    const hasText = message.text && message.text.trim() !== '';
    const hasFiles = !!message.files?.length;
    if (!hasText && !hasFiles) return;
    if (message.edited) return;

    if (isImageRequest(message.text)) {
      await say(IMAGE_REQUEST_GUIDANCE);
      return;
    }

    const reacted = await addThinkingReaction(app, message.channel, message.ts);
    try {
      const images = await extractMessageImages(message, botToken);
      const result = await handleMessage({ ...message, images }, { chat, convoStore });
      if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
      await say(buildReplyPayload(result));
    } catch (error) {
      console.error(`Error in ${channelType} message processing:`, error);
      if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
      await say(GENERIC_ERROR_TEXT);
    }
  });

  app.message(directMention(), async ({ message, say }) => {
    if (!message) return;
    // Slack tags messages with attached files as subtype 'file_share' — let
    // those through so vision uploads reach the LLM. All other subtypes
    // (edits, deletes, channel joins, etc.) are skipped.
    if (message.subtype && message.subtype !== 'file_share') return;
    // Bail on bot-originated messages to prevent loops; thread replies from
    // humans are allowed through so Data can hold a back-and-forth in-thread.
    if (message.bot_profile || message.bot_id) return;

    // Channel @-mentions reply in-thread: continue the existing thread if the
    // mention came from one, otherwise start a new thread rooted at the
    // mention itself. Keeps Data from flooding the channel.
    const threadTs = message.thread_ts || message.ts;
    const sayInThread = (payload) => {
      const obj = typeof payload === 'string' ? { text: payload } : payload;
      return say({ ...obj, thread_ts: threadTs });
    };

    if (message.text && message.text.toLowerCase().includes('help')) {
      await sayInThread(buildHelpText(botName));
      return;
    }

    if (message.text && message.text.toLowerCase().includes('the rules')) {
      await sayInThread(ASIMOV_RULES);
      return;
    }

    if (message.text && /\bdad\s*joke\b/i.test(message.text)) {
      try {
        const joke = await fetchDadJoke(fetch);
        const { joke: jokeText, zinger } = formatDadJoke(joke);
        await sayInThread(jokeText);
        if (zinger) {
          await new Promise((resolve) => setTimeout(resolve, 10000));
          await sayInThread(zinger);
        }
      } catch (error) {
        console.error(error);
        await sayInThread(`Encountered an error :( ${error}`);
      }
      return;
    }

    const hasText = message.text && message.text.trim() !== '';
    const hasFiles = !!message.files?.length;
    if (!hasText && !hasFiles) return;
    if (message.edited) return;

    if (isImageRequest(message.text)) {
      await sayInThread(IMAGE_REQUEST_GUIDANCE);
      return;
    }

    const reacted = await addThinkingReaction(app, message.channel, message.ts);
    try {
      const images = await extractMessageImages(message, botToken);
      const result = await handleMessage({ ...message, images }, { chat, convoStore });
      if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
      await sayInThread(buildReplyPayload(result));
    } catch (error) {
      console.error('Error in direct mention processing:', error);
      if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
      await sayInThread(GENERIC_ERROR_TEXT);
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

  // Let a user wipe their own conversation history. History is keyed by user id
  // alone, so this resets Data's memory of the user everywhere, not just the
  // channel the command was invoked from. Reply is ephemeral so it stays quiet.
  app.command('/forget', async ({ command, ack, respond }) => {
    try {
      await ack();
      await clearHistory(command.user_id, { convoStore });
      console.log(`Cleared conversation history for user ${command.user_id}`);
      await respond({
        text: 'My memory of our previous conversation has been erased. I am now a blank slate, ready to begin anew. How may I assist you?',
        response_type: 'ephemeral',
      });
    } catch (error) {
      console.error('Error in /forget command handling:', error);
      try {
        await respond({
          text: `❌ I was unable to clear our conversation history: ${error.message}`,
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
