import test from 'node:test';
import assert from 'node:assert';

import { cleanLocalLlmResponse, handleMessage } from '../lib/chat.js';

test('cleanLocalLlmResponse passes text through when not a local LLM', () => {
  const input = 'hello <|eot_id|> world';
  assert.strictEqual(cleanLocalLlmResponse(input, false), input);
});

test('cleanLocalLlmResponse strips tokenizer artifacts when isLocalLlm=true', () => {
  const input =
    '<|begin_of_text|>hello <|eot_id|> world<|end_of_text|>  <|start_header_id|><|end_header_id|>';
  assert.strictEqual(cleanLocalLlmResponse(input, true), 'hello  world');
});

test('cleanLocalLlmResponse handles empty/undefined input safely', () => {
  assert.strictEqual(cleanLocalLlmResponse('', true), '');
  assert.strictEqual(cleanLocalLlmResponse(undefined, true), undefined);
});

function makeFakeChat({ reply = 'pong', shouldThrow = null } = {}) {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    async sendMessage(text, opts) {
      calls.push({ text, opts });
      if (shouldThrow) throw shouldThrow;
      return { id: `msg-${nextId++}`, text: reply };
    },
  };
}

test('handleMessage returns an apology for empty text without calling chat', async () => {
  const chat = makeFakeChat();
  const parentIds = new Map();
  const result = await handleMessage({ text: '', user: 'U1' }, { chat, parentIds });
  assert.match(result, /cannot process an empty message/);
  assert.strictEqual(chat.calls.length, 0);
});

test('handleMessage threads conversation context per-user via parentIds', async () => {
  const chat = makeFakeChat({ reply: 'hi back' });
  const parentIds = new Map();

  const first = await handleMessage({ text: 'hi', user: 'U1' }, { chat, parentIds });
  assert.strictEqual(first, 'hi back');
  assert.strictEqual(chat.calls[0].opts, undefined);

  const second = await handleMessage({ text: 'still there?', user: 'U1' }, { chat, parentIds });
  assert.strictEqual(second, 'hi back');
  assert.strictEqual(chat.calls[1].opts.parentMessageId, 'msg-1');

  // A different user starts fresh.
  await handleMessage({ text: 'new user', user: 'U2' }, { chat, parentIds });
  assert.strictEqual(chat.calls[2].opts, undefined);
});

test('handleMessage strips local LLM tokens when isLocalLlm=true', async () => {
  const chat = makeFakeChat({ reply: '<|begin_of_text|>clean me<|eot_id|>' });
  const result = await handleMessage(
    { text: 'hi', user: 'U1' },
    { chat, parentIds: new Map(), isLocalLlm: true }
  );
  assert.strictEqual(result, 'clean me');
});

test('handleMessage returns a friendly rephrase message on 400-content errors', async () => {
  const err = new Error('invalid content policy');
  err.statusCode = 400;
  const chat = makeFakeChat({ shouldThrow: err });
  const result = await handleMessage({ text: 'hi', user: 'U1' }, { chat, parentIds: new Map() });
  assert.match(result, /rephrase your request/);
});

test('handleMessage falls back to the generic apology on other errors', async () => {
  const chat = makeFakeChat({ shouldThrow: new Error('boom') });
  const result = await handleMessage({ text: 'hi', user: 'U1' }, { chat, parentIds: new Map() });
  assert.match(result, /neural pathways/);
});
