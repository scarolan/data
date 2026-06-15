import test from 'node:test';
import assert from 'node:assert';

import { handleMessage, clearHistory } from '../lib/chat.js';

// Minimal in-memory convoStore that quacks like Keyv (async get/set/delete).
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
    async delete(key) {
      return data.delete(key);
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
  assert.match(result.text, /cannot process an empty message/);
  assert.strictEqual(chat.calls.length, 0);
});

test('handleMessage persists per-user history across calls', async () => {
  const chat = makeFakeChat({ reply: 'hi back' });
  const convoStore = makeFakeConvoStore();

  const first = await handleMessage({ text: 'hi', user: 'U1' }, { chat, convoStore });
  assert.strictEqual(first.text, 'hi back');
  assert.deepStrictEqual(chat.calls[0].messages, [{ role: 'user', content: 'hi' }]);

  const second = await handleMessage({ text: 'still there?', user: 'U1' }, { chat, convoStore });
  assert.strictEqual(second.text, 'hi back');
  assert.deepStrictEqual(chat.calls[1].messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hi back' },
    { role: 'user', content: 'still there?' },
  ]);

  const stored = await convoStore.get('convo:U1');
  assert.strictEqual(stored.length, 4);
  assert.strictEqual(stored[3].content, 'hi back');
});

test('handleMessage keeps per-user history isolated', async () => {
  const chat = makeFakeChat({ reply: 'reply' });
  const convoStore = makeFakeConvoStore();

  await handleMessage({ text: 'hi from U1', user: 'U1' }, { chat, convoStore });
  await handleMessage({ text: 'hi from U2', user: 'U2' }, { chat, convoStore });

  assert.deepStrictEqual(chat.calls[1].messages, [{ role: 'user', content: 'hi from U2' }]);
});

test('handleMessage trims history to the configured limit', async () => {
  const chat = makeFakeChat({ reply: 'r' });
  const convoStore = makeFakeConvoStore();

  for (let i = 0; i < 5; i++) {
    await handleMessage({ text: `msg ${i}`, user: 'U1' }, { chat, convoStore, historyLimit: 4 });
  }

  const stored = await convoStore.get('convo:U1');
  assert.strictEqual(stored.length, 4);
  assert.strictEqual(stored[0].content, 'msg 3');
  assert.strictEqual(stored[2].content, 'msg 4');
});

test('handleMessage rehydrates history from convoStore on cold start', async () => {
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
  assert.match(result.text, /rephrase your request/);
});

test('handleMessage falls back to the generic apology on other errors', async () => {
  const chat = makeFakeChat({ shouldThrow: new Error('boom') });
  const result = await handleMessage(
    { text: 'hi', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(result.text, /neural pathways/);
});

test('handleMessage does not persist history when the backend errors', async () => {
  const convoStore = makeFakeConvoStore({
    'convo:U1': [{ role: 'user', content: 'prior' }],
  });
  const chat = makeFakeChat({ shouldThrow: new Error('boom') });
  await handleMessage({ text: 'hi', user: 'U1' }, { chat, convoStore });

  const stored = await convoStore.get('convo:U1');
  assert.deepStrictEqual(stored, [{ role: 'user', content: 'prior' }]);
});

// --- clearHistory ---------------------------------------------------------

test('clearHistory removes the stored history for a user', async () => {
  const convoStore = makeFakeConvoStore({
    'convo:U1': [{ role: 'user', content: 'remember this' }],
    'convo:U2': [{ role: 'user', content: 'keep me' }],
  });

  const ok = await clearHistory('U1', { convoStore });
  assert.strictEqual(ok, true);
  assert.strictEqual(await convoStore.get('convo:U1'), undefined);
  // Other users are untouched.
  assert.deepStrictEqual(await convoStore.get('convo:U2'), [{ role: 'user', content: 'keep me' }]);
});

test('clearHistory is a no-op-safe when there is nothing stored', async () => {
  const convoStore = makeFakeConvoStore();
  const ok = await clearHistory('U1', { convoStore });
  assert.strictEqual(ok, true);
  assert.strictEqual(await convoStore.get('convo:U1'), undefined);
});

test('clearHistory returns false for a missing user id', async () => {
  const convoStore = makeFakeConvoStore();
  const ok = await clearHistory(undefined, { convoStore });
  assert.strictEqual(ok, false);
});

test('a user can chat, forget, then start fresh', async () => {
  const chat = makeFakeChat({ reply: 'ack' });
  const convoStore = makeFakeConvoStore();

  await handleMessage({ text: 'my name is Geordi', user: 'U1' }, { chat, convoStore });
  await clearHistory('U1', { convoStore });

  // Next turn sees no prior context.
  await handleMessage({ text: 'do you remember my name?', user: 'U1' }, { chat, convoStore });
  assert.deepStrictEqual(chat.calls[chat.calls.length - 1].messages, [
    { role: 'user', content: 'do you remember my name?' },
  ]);
});

// --- Vision ---------------------------------------------------------------

test('handleMessage attaches images to the user turn and strips them on persist', async () => {
  const chat = makeFakeChat({ reply: 'I see a cat.' });
  const convoStore = makeFakeConvoStore();
  const images = [{ mimeType: 'image/png', data: 'YWJj' }];

  const reply = await handleMessage(
    { text: 'what is this?', user: 'U1', images },
    { chat, convoStore }
  );

  assert.strictEqual(reply.text, 'I see a cat.');
  assert.deepStrictEqual(chat.calls[0].messages[0].images, images);
  const stored = await convoStore.get('convo:U1');
  assert.deepStrictEqual(stored, [
    { role: 'user', content: 'what is this?' },
    { role: 'assistant', content: 'I see a cat.' },
  ]);
});

test('handleMessage accepts images with empty text', async () => {
  const chat = makeFakeChat({ reply: 'A cat.' });
  const convoStore = makeFakeConvoStore();
  const images = [{ mimeType: 'image/png', data: 'YWJj' }];
  const reply = await handleMessage({ text: '', user: 'U1', images }, { chat, convoStore });
  assert.strictEqual(reply.text, 'A cat.');
});

test('handleMessage still rejects truly empty (no text, no images) input', async () => {
  const chat = makeFakeChat();
  const reply = await handleMessage(
    { text: '', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(reply.text, /cannot process an empty message/);
  assert.strictEqual(chat.calls.length, 0);
});
