///////////////////////////////////////////////////////////////
// A bolt.js Slack chatbot. Wires Bolt event handlers onto pure
// helpers in lib/. Conversation is routed through native Ollama
// or Gemini SDKs by lib/chat.js; canned trigger-word replies are
// matched in lib/responses.js.
///////////////////////////////////////////////////////////////

import dotenv from 'dotenv';
import { directMention } from '@slack/bolt';

dotenv.config({ quiet: true });

import { buildDeps, validateRequiredEnv } from './lib/deps.js';
import { handleMessage, clearHistory } from './lib/chat.js';
import { generateImage } from './lib/image.js';
import { summarizeThread } from './lib/summarize.js';
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
  GENERIC_ERROR_TEXT,
  isDanceParty,
  isHelpRequest,
  isImageRequest,
  isLoveYou,
  isPodBayDoor,
  isBareSummaryRequest,
  isRickroll,
  isTheRules,
  isThreadSummaryRequest,
  isTikTok,
  THREAD_SUMMARY_GUIDANCE,
} from './lib/responses.js';

export { generateImage, handleMessage };

const THINKING_REACTION = 'brain';

// Slack's ChatStreamer default buffer is 256 chars, which makes short replies
// appear all at once at stop() — streaming happens but is invisible. Flush
// smaller chunks so the reply visibly types out. chat.appendStream is
// rate-limit Tier 4 (100+/min), so even a long reply stays comfortably inside.
const STREAM_BUFFER_SIZE = 64;

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

async function removeThinkingReaction(app, channel, ts) {
  if (!channel || !ts) return;
  try {
    await app.client.reactions.remove({ channel, timestamp: ts, name: THINKING_REACTION });
  } catch (err) {
    console.warn('Failed to remove thinking reaction:', err && err.message ? err.message : err);
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

// Wrap a lazily-created Slack ChatStreamer (client.chatStream / sayStream) so
// the chat pipeline can push reply deltas at it without caring whether Slack
// streaming actually works in this conversation. Degrades gracefully: any
// failure before a message is visible makes finish() return false, telling the
// caller to fall back to a plain say(). The streamer is only created on the
// first delta, so a turn that errors out before producing text never opens a
// stream.
export function makeStreamSink(createStreamer) {
  let streamer = null;
  let broken = false;
  let receivedAny = false;
  return {
    // True once at least one delta arrived — i.e. reply content exists that
    // may be (partially) visible in a streamed Slack message.
    get active() {
      return receivedAny;
    },
    async push(delta) {
      receivedAny = true;
      if (broken) return;
      try {
        streamer = streamer || createStreamer();
        await streamer.append({ markdown_text: delta });
      } catch (err) {
        broken = true;
        console.warn(
          'Streaming append failed; falling back to a plain reply:',
          err?.message || err
        );
      }
    },
    // Finalize the stream; `trailer` (optional) is appended before stopping —
    // used to tack an apology onto a partially-streamed reply. Returns true if
    // a Slack message ended up posted via the stream, false if the caller
    // should deliver the reply with say() instead.
    async finish(trailer) {
      if (!streamer) return false;
      const visible = () => streamer.ts !== undefined;
      if (broken && !visible()) return false;
      try {
        await streamer.stop(trailer ? { markdown_text: trailer } : undefined);
        return true;
      } catch (err) {
        console.warn('Streaming stop failed:', err?.message || err);
        return visible();
      }
    },
  };
}

// Shared chat-turn pipeline for both the DM handler and the @-mention handler.
// Runs the common pre-flight guards (empty message, edits, image-request nudge)
// then the react → extract-images → handleMessage → reply sequence. The only
// things that differ between the two call sites are `say` (flat for DMs,
// in-thread for mentions), the optional `streamFactory` (a () => ChatStreamer
// used to stream the reply into Slack as it generates), and the error-log
// label, so all three are injected.
export async function runChatTurn({ message, say, deps, errorLabel, streamFactory }) {
  const { app, chat, convoStore, botToken } = deps;

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
    const sink = streamFactory ? makeStreamSink(streamFactory) : null;
    const result = await handleMessage(
      { ...message, images },
      { chat, convoStore, ...(sink ? { onDelta: (delta) => sink.push(delta) } : {}) }
    );
    if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
    await deliverReply({ sink, result, say });
  } catch (error) {
    console.error(errorLabel, error);
    if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
    await say(GENERIC_ERROR_TEXT);
  }
}

// Shared "summarize this thread" turn for the @-mention handler and the bare
// DM/MPIM form. Wraps summarizeThread with the same reaction + stream-or-say
// delivery UX as a chat turn. `say` must already target the thread.
export async function runThreadSummary({ message, deps, client, context, say, streamFactory }) {
  const { app, chat, botName } = deps;
  const reacted = await addThinkingReaction(app, message.channel, message.ts);
  const sink = streamFactory ? makeStreamSink(streamFactory) : null;
  try {
    const result = await summarizeThread({
      client,
      chat,
      channel: message.channel,
      threadTs: message.thread_ts || message.ts,
      triggerTs: message.ts,
      botUserId: context.botUserId,
      botName,
      ...(sink ? { onDelta: (delta) => sink.push(delta) } : {}),
    });
    if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
    await deliverReply({ sink, result, say });
  } catch (error) {
    console.error('Error in thread summarization:', error);
    if (reacted) await removeThinkingReaction(app, message.channel, message.ts);
    await say(GENERIC_ERROR_TEXT);
  }
}

// Land a { text, streamed } result in Slack. If reply content went through the
// stream, finalize it — appending the text as a trailer when it's a fallback
// (error/empty mid-stream) the stream never saw, so a partial message still
// ends coherently. Otherwise (or if the stream never became visible) fall back
// to a plain say().
async function deliverReply({ sink, result, say }) {
  let posted = false;
  if (sink && sink.active) {
    posted = await sink.finish(result.streamed ? undefined : `\n\n${result.text}`);
  }
  if (!posted) await say(result.text);
}

// Wire all the Bolt event listeners onto `deps.app`. Pure: takes deps, registers handlers.
export function registerHandlers(deps) {
  // `chat` is consumed inside runChatTurn (via `deps`); everything else is used
  // directly by the handlers below.
  const { app, convoStore, geminiClient, geminiImageModel, botName, botToken } = deps;

  app.message(async ({ message, say, client, context }) => {
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
    // Ignore bot-originated messages (prevents loops). Match the mention
    // handler: some bot messages carry bot_profile but no bot_id.
    if (message.bot_profile || message.bot_id) return;

    if (isLoveYou(message.text)) {
      await say('I know.');
      return;
    }

    if (isPodBayDoor(message.text)) {
      // This branch makes a live users.info call — the only canned response
      // that does I/O. Guard it so a transient Slack API failure can't take
      // down the handler with an unhandled rejection; fall back to HAL's
      // canonical "Dave" so the gag still lands.
      let displayName = 'Dave';
      try {
        const userInfo = await app.client.users.info({ token: botToken, user: message.user });
        displayName = userInfo.user.profile.display_name || userInfo.user.real_name || displayName;
      } catch (err) {
        console.warn('pod bay: users.info failed, using fallback name:', err?.message || err);
      }
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

    // Thread summaries work without an @-mention in DMs/MPIMs, where the bot
    // is the conversational partner: "summarize this thread" anywhere, or any
    // short summarize-shaped message (typos included) from inside a thread.
    // Outside a thread there is nothing to summarize — canned guidance beats
    // letting the LLM improvise a refusal.
    if (
      isThreadSummaryRequest(message.text) ||
      (message.thread_ts && isBareSummaryRequest(message.text))
    ) {
      if (!message.thread_ts) {
        await say(THREAD_SUMMARY_GUIDANCE);
        return;
      }
      const sayInThread = (payload) => {
        const obj = typeof payload === 'string' ? { text: payload } : payload;
        return say({ ...obj, thread_ts: message.thread_ts });
      };
      await runThreadSummary({
        message,
        deps,
        client,
        context,
        say: sayInThread,
        streamFactory: deps.streamReplies
          ? () =>
              client.chatStream({
                channel: message.channel,
                thread_ts: message.thread_ts,
                recipient_team_id: context.teamId ?? context.enterpriseId,
                recipient_user_id: context.userId,
                buffer_size: STREAM_BUFFER_SIZE,
              })
          : null,
      });
      return;
    }

    await runChatTurn({
      message,
      say,
      deps,
      errorLabel: `Error in ${channelType} message processing:`,
      // Slack only streams into threads (startStream without thread_ts fails
      // with invalid_thread_ts — verified live), so DM streams are rooted at
      // the user's message; replies inside that thread keep streaming there.
      // If Slack still refuses, the sink falls back to a flat say().
      streamFactory: deps.streamReplies
        ? () =>
            client.chatStream({
              channel: message.channel,
              thread_ts: message.thread_ts || message.ts,
              recipient_team_id: context.teamId ?? context.enterpriseId,
              recipient_user_id: context.userId,
              buffer_size: STREAM_BUFFER_SIZE,
            })
        : null,
    });
  });

  app.message(directMention, async ({ message, say, sayStream, client, context }) => {
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

    if (isHelpRequest(message.text)) {
      await sayInThread(buildHelpText(botName));
      return;
    }

    if (isTheRules(message.text)) {
      await sayInThread(ASIMOV_RULES);
      return;
    }

    if (message.text && /\bdad\s*joke\b/i.test(message.text)) {
      try {
        const joke = await fetchDadJoke(fetch);
        const { joke: jokeText, zinger } = formatDadJoke(joke);
        await sayInThread(jokeText);
        if (zinger) {
          // Fire-and-forget the zinger after a beat for comedic timing — don't
          // hold the handler open for 10s waiting on it. Errors are logged only.
          setTimeout(() => {
            sayInThread(zinger).catch((err) =>
              console.error('Failed to post dad joke zinger:', err)
            );
          }, 10000);
        }
      } catch (error) {
        console.error(error);
        await sayInThread(`Encountered an error :( ${error}`);
      }
      return;
    }

    if (
      isThreadSummaryRequest(message.text) ||
      (message.thread_ts && isBareSummaryRequest(message.text))
    ) {
      await runThreadSummary({
        message,
        deps,
        client,
        context,
        say: sayInThread,
        streamFactory:
          deps.streamReplies && sayStream
            ? () => sayStream({ buffer_size: STREAM_BUFFER_SIZE })
            : null,
      });
      return;
    }

    await runChatTurn({
      message,
      say: sayInThread,
      deps,
      errorLabel: 'Error in direct mention processing:',
      // Bolt's sayStream targets thread_ts ?? ts — the same thread sayInThread
      // replies into — so streamed and non-streamed replies land in one place.
      streamFactory:
        deps.streamReplies && sayStream
          ? () => sayStream({ buffer_size: STREAM_BUFFER_SIZE })
          : null,
    });
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
  console.log('Bot is alive!');
}

// Only boot the bot when this module is run directly. This is what lets the
// test suite import app.js without triggering env validation or Slack connect.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  validateRequiredEnv();
  start();
}
