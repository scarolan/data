// Thread summarization: fetch a Slack thread, render it as a name-resolved
// transcript, and ask the chat backend for a one-shot briefing. Deliberately
// bypasses convoStore — a summary is a stateless command, and stuffing a whole
// thread transcript into the invoking user's history would both pollute their
// context and blow the history budget.
//
// Slack client and chat adapter are injected (see CLAUDE.md "Adding a function
// that calls an external API") so tests can fake both.

// One conversations.replies page. Threads longer than this are summarized from
// their most recent messages, with a truncation note in the prompt.
const MAX_THREAD_MESSAGES = 200;

// Cap the transcript so a giant thread can't blow the local model's context
// window. Keeps the most recent content — endings carry decisions/action items.
const MAX_TRANSCRIPT_CHARS = 12000;

export const NOTHING_TO_SUMMARIZE_TEXT =
  'There does not appear to be any discussion in this thread for me to summarize. Perhaps you could invoke me again once the conversation has progressed.';

export function buildSummaryPrompt(transcript, { truncated = false } = {}) {
  const truncationNote = truncated
    ? ' (the transcript below was truncated; only the most recent portion is shown)'
    : '';
  return [
    `A crew member has asked you to summarize the following Slack thread${truncationNote}.`,
    'Provide a concise briefing of the discussion: the main topic, the key points and any decisions reached, and outstanding action items with their owners, if any.',
    'Use short paragraphs. Do not invent details that are not present in the transcript.',
    '',
    '--- THREAD TRANSCRIPT ---',
    transcript,
    '--- END TRANSCRIPT ---',
  ].join('\n');
}

// Resolve a Slack user id to a human-readable name, with a per-call cache so a
// long thread costs one users.info per distinct participant. Falls back to the
// raw id if the lookup fails — a summary with an occasional <U123> beats a
// failed summary.
function makeNameResolver(client, { botUserId, botName }) {
  const cache = new Map();
  return async function nameFor(userId) {
    if (!userId) return 'unknown';
    if (botUserId && userId === botUserId) return botName || 'Data';
    if (cache.has(userId)) return cache.get(userId);
    let name = userId;
    try {
      const info = await client.users.info({ user: userId });
      name = info?.user?.profile?.display_name || info?.user?.real_name || userId;
    } catch (err) {
      console.warn(`users.info failed for ${userId}:`, err?.message || err);
    }
    cache.set(userId, name);
    return name;
  };
}

// Render fetched thread messages as "Name: text" lines. Skips the triggering
// mention itself (it's the request, not the discussion), messages with no
// text, and channel-event noise. Inline <@U123> mentions are resolved to
// @Name so the model reads names, not ids.
async function buildTranscript(messages, { triggerTs, nameFor }) {
  const lines = [];
  for (const m of messages) {
    if (m.ts === triggerTs) continue;
    if (m.subtype && m.subtype !== 'bot_message' && m.subtype !== 'file_share') continue;
    const text = (m.text || '').trim();
    if (!text) continue;
    const author = await nameFor(m.user || m.bot_id);
    let rendered = text;
    for (const token of text.match(/<@[A-Z0-9]+>/g) || []) {
      rendered = rendered.replaceAll(token, `@${await nameFor(token.slice(2, -1))}`);
    }
    lines.push(`${author}: ${rendered}`);
  }
  return lines;
}

export async function summarizeThread({
  client,
  chat,
  channel,
  threadTs,
  triggerTs,
  botUserId,
  botName,
  onDelta,
}) {
  const res = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: MAX_THREAD_MESSAGES,
  });
  const nameFor = makeNameResolver(client, { botUserId, botName });
  const lines = await buildTranscript(res?.messages || [], { triggerTs, nameFor });

  if (!lines.length) {
    return { text: NOTHING_TO_SUMMARIZE_TEXT, streamed: false };
  }

  let transcript = lines.join('\n');
  let truncated = !!res?.has_more;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }

  console.log(
    `Summarizing thread ${channel}/${threadTs}: ${lines.length} message(s), ${transcript.length} chars${truncated ? ' (truncated)' : ''}`
  );

  const messages = [{ role: 'user', content: buildSummaryPrompt(transcript, { truncated }) }];
  const streaming = typeof onDelta === 'function' && typeof chat.chatStream === 'function';
  const result = streaming
    ? await chat.chatStream({ messages, onDelta })
    : await chat.chat({ messages });
  const text = (result.text || '').trim();

  if (!text) {
    return {
      text: 'I apologize, but I was unable to formulate a summary of this thread.',
      streamed: false,
    };
  }
  return { text, streamed: streaming };
}
