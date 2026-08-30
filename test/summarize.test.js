import test from 'node:test';
import assert from 'node:assert';

import {
  summarizeThread,
  buildSummaryPrompt,
  NOTHING_TO_SUMMARIZE_TEXT,
} from '../lib/summarize.js';

// Fake Slack WebClient covering the two methods summarizeThread touches.
function makeFakeSlackClient({
  messages = [],
  hasMore = false,
  users = {},
  usersInfoThrows = false,
}) {
  const calls = { replies: [], usersInfo: [] };
  return {
    calls,
    conversations: {
      async replies(args) {
        calls.replies.push(args);
        return { messages, has_more: hasMore };
      },
    },
    users: {
      async info(args) {
        calls.usersInfo.push(args);
        if (usersInfoThrows) throw new Error('user_not_found');
        const u = users[args.user];
        if (!u) throw new Error('user_not_found');
        return { user: u };
      },
    },
  };
}

function makeFakeChat({ reply = 'A concise briefing.' } = {}) {
  const calls = [];
  return {
    calls,
    async chat({ messages }) {
      calls.push({ via: 'chat', messages });
      return { text: reply };
    },
    async chatStream({ messages, onDelta }) {
      calls.push({ via: 'chatStream', messages });
      await onDelta(reply.slice(0, 4));
      await onDelta(reply.slice(4));
      return { text: reply };
    },
  };
}

const THREAD = [
  { ts: '1.0', user: 'U1', text: 'we need to pick a database' },
  { ts: '2.0', user: 'U2', text: 'I vote postgres, <@U1> agreed earlier' },
  { ts: '3.0', user: 'UBOT', text: 'Postgres is a logical choice.' },
  { ts: '9.9', user: 'U1', text: '<@UBOT> summarize this thread' }, // the trigger
];

const USERS = {
  U1: { profile: { display_name: 'geordi' }, real_name: 'Geordi La Forge' },
  U2: { profile: { display_name: '' }, real_name: 'Will Riker' },
};

const BASE_ARGS = {
  channel: 'C1',
  threadTs: '1.0',
  triggerTs: '9.9',
  botUserId: 'UBOT',
  botName: 'Data',
};

test('summarizeThread builds a name-resolved transcript and returns the summary', async () => {
  const client = makeFakeSlackClient({ messages: THREAD, users: USERS });
  const chat = makeFakeChat({ reply: 'They chose postgres.' });

  const result = await summarizeThread({ client, chat, ...BASE_ARGS });

  assert.strictEqual(result.text, 'They chose postgres.');
  assert.strictEqual(result.streamed, false);
  assert.deepStrictEqual(client.calls.replies[0], { channel: 'C1', ts: '1.0', limit: 200 });

  const prompt = chat.calls[0].messages[0].content;
  // Display name preferred, real_name fallback, bot id mapped to botName.
  assert.match(prompt, /geordi: we need to pick a database/);
  assert.match(prompt, /Will Riker: I vote postgres, @geordi agreed earlier/);
  assert.match(prompt, /Data: Postgres is a logical choice\./);
  // The triggering mention is not part of the transcript.
  assert.ok(!prompt.includes('summarize this thread'));
  // One users.info per distinct human, cached thereafter.
  assert.strictEqual(client.calls.usersInfo.length, 2);
});

test('summarizeThread streams the summary when onDelta is provided', async () => {
  const client = makeFakeSlackClient({ messages: THREAD, users: USERS });
  const chat = makeFakeChat({ reply: 'Postgres won.' });
  const deltas = [];

  const result = await summarizeThread({
    client,
    chat,
    ...BASE_ARGS,
    onDelta: async (d) => deltas.push(d),
  });

  assert.strictEqual(chat.calls[0].via, 'chatStream');
  assert.strictEqual(result.streamed, true);
  assert.strictEqual(deltas.join(''), 'Postgres won.');
});

test('summarizeThread returns the canned line without calling chat when the thread is empty', async () => {
  // Thread contains only the trigger mention and channel noise.
  const client = makeFakeSlackClient({
    messages: [
      { ts: '9.9', user: 'U1', text: '<@UBOT> summarize this thread' },
      { ts: '1.1', user: 'U2', subtype: 'channel_join', text: 'joined' },
    ],
    users: USERS,
  });
  const chat = makeFakeChat();

  const result = await summarizeThread({ client, chat, ...BASE_ARGS });

  assert.strictEqual(result.text, NOTHING_TO_SUMMARIZE_TEXT);
  assert.strictEqual(result.streamed, false);
  assert.strictEqual(chat.calls.length, 0);
});

test('summarizeThread falls back to raw ids when users.info fails', async () => {
  const client = makeFakeSlackClient({ messages: THREAD, usersInfoThrows: true });
  const chat = makeFakeChat();

  await summarizeThread({ client, chat, ...BASE_ARGS });

  const prompt = chat.calls[0].messages[0].content;
  assert.match(prompt, /U1: we need to pick a database/);
  assert.match(prompt, /U2: I vote postgres, @U1 agreed earlier/);
});

test('summarizeThread truncates giant transcripts and flags it in the prompt', async () => {
  const messages = [
    { ts: '1.0', user: 'U1', text: `start-marker ${'x'.repeat(13000)}` },
    { ts: '2.0', user: 'U2', text: 'end-marker' },
  ];
  const client = makeFakeSlackClient({ messages, users: USERS });
  const chat = makeFakeChat();

  await summarizeThread({ client, chat, ...BASE_ARGS });

  const prompt = chat.calls[0].messages[0].content;
  assert.ok(!prompt.includes('start-marker'), 'oldest content is dropped');
  assert.match(prompt, /end-marker/);
  assert.match(prompt, /truncated/);
});

test('summarizeThread apologizes on an empty model reply', async () => {
  const client = makeFakeSlackClient({ messages: THREAD, users: USERS });
  const chat = makeFakeChat({ reply: '   ' });

  const result = await summarizeThread({ client, chat, ...BASE_ARGS });

  assert.match(result.text, /unable to formulate a summary/);
  assert.strictEqual(result.streamed, false);
});

test('buildSummaryPrompt wraps the transcript with instructions', () => {
  const prompt = buildSummaryPrompt('alice: hi\nbob: hello');
  assert.match(prompt, /THREAD TRANSCRIPT/);
  assert.match(prompt, /alice: hi/);
  assert.match(prompt, /Do not invent details/);
  assert.ok(!prompt.includes('truncated'));
});
