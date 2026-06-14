import test from 'node:test';
import assert from 'node:assert';

import { handleMessage } from '../lib/chat.js';

// Minimal in-memory convoStore that quacks like Keyv (async get/set).
function makeFakeConvoStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
      return true;
    },
  };
}

function makeFakeChat({ reply = 'pong', shouldThrow = null } = {}) {
  const calls = [];
  return {
    calls,
    async chat({ messages }) {
      calls.push({ messages });
      if (shouldThrow) throw shouldThrow;
      return { text: reply };
    },
  };
}

test('handleMessage returns an apology for empty text without calling chat', async () => {
  const chat = makeFakeChat();
  const result = await handleMessage(
    { text: '', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(result, /cannot process an empty message/);
  assert.strictEqual(chat.calls.length, 0);
});

test('handleMessage persists per-user history across calls', async () => {
  const chat = makeFakeChat({ reply: 'hi back' });
  const convoStore = makeFakeConvoStore();

  const first = await handleMessage({ text: 'hi', user: 'U1' }, { chat, convoStore });
  assert.strictEqual(first, 'hi back');
  // First turn: history is just the new user message.
  assert.deepStrictEqual(chat.calls[0].messages, [{ role: 'user', content: 'hi' }]);

  const second = await handleMessage({ text: 'still there?', user: 'U1' }, { chat, convoStore });
  assert.strictEqual(second, 'hi back');
  // Second turn: history includes both prior turns plus the new user message.
  assert.deepStrictEqual(chat.calls[1].messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hi back' },
    { role: 'user', content: 'still there?' },
  ]);

  // Stored history reflects the post-call state.
  const stored = await convoStore.get('convo:U1');
  assert.strictEqual(stored.length, 4);
  assert.strictEqual(stored[3].content, 'hi back');
});

test('handleMessage keeps per-user history isolated', async () => {
  const chat = makeFakeChat({ reply: 'reply' });
  const convoStore = makeFakeConvoStore();

  await handleMessage({ text: 'hi from U1', user: 'U1' }, { chat, convoStore });
  await handleMessage({ text: 'hi from U2', user: 'U2' }, { chat, convoStore });

  // U2's first call must not see U1's history.
  assert.deepStrictEqual(chat.calls[1].messages, [{ role: 'user', content: 'hi from U2' }]);
});

test('handleMessage trims history to the configured limit', async () => {
  const chat = makeFakeChat({ reply: 'r' });
  const convoStore = makeFakeConvoStore();

  for (let i = 0; i < 5; i++) {
    await handleMessage({ text: `msg ${i}`, user: 'U1' }, { chat, convoStore, historyLimit: 4 });
  }

  const stored = await convoStore.get('convo:U1');
  // Each turn appends 2 messages; with limit=4 we keep only the last 2 turns.
  assert.strictEqual(stored.length, 4);
  assert.strictEqual(stored[0].content, 'msg 3');
  assert.strictEqual(stored[2].content, 'msg 4');
});

test('handleMessage rehydrates history from convoStore on cold start', async () => {
  // Simulates a process restart: history is already in Redis from a prior session.
  const convoStore = makeFakeConvoStore({
    'convo:U1': [
      { role: 'user', content: 'remember this' },
      { role: 'assistant', content: 'noted' },
    ],
  });
  const chat = makeFakeChat({ reply: 'ack' });

  await handleMessage({ text: 'do you remember?', user: 'U1' }, { chat, convoStore });
  assert.deepStrictEqual(chat.calls[0].messages, [
    { role: 'user', content: 'remember this' },
    { role: 'assistant', content: 'noted' },
    { role: 'user', content: 'do you remember?' },
  ]);
});

test('handleMessage returns a friendly rephrase message on content/policy errors', async () => {
  const err = new Error('blocked by safety filter');
  const chat = makeFakeChat({ shouldThrow: err });
  const result = await handleMessage(
    { text: 'hi', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(result, /rephrase your request/);
});

test('handleMessage falls back to the generic apology on other errors', async () => {
  const chat = makeFakeChat({ shouldThrow: new Error('boom') });
  const result = await handleMessage(
    { text: 'hi', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(result, /neural pathways/);
});

test('handleMessage does not persist history when the backend errors', async () => {
  const convoStore = makeFakeConvoStore({
    'convo:U1': [{ role: 'user', content: 'prior' }],
  });
  const chat = makeFakeChat({ shouldThrow: new Error('boom') });
  await handleMessage({ text: 'hi', user: 'U1' }, { chat, convoStore });

  const stored = await convoStore.get('convo:U1');
  // Prior history is intact; failed turn was not appended.
  assert.deepStrictEqual(stored, [{ role: 'user', content: 'prior' }]);
});
