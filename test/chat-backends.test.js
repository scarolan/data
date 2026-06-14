import test from 'node:test';
import assert from 'node:assert';

import { makeOllamaChat, makeGeminiChat } from '../lib/chat-backends.js';

// --- Ollama --------------------------------------------------------------

function makeFakeOllama(reply) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { message: { role: 'assistant', content: reply } };
    },
  };
}

test('Ollama adapter prepends the system message and forwards the model', async () => {
  const ollama = makeFakeOllama('hello');
  const chat = makeOllamaChat({
    model: 'llama3.1',
    systemMessage: 'You are Data.',
    client: ollama,
  });

  const { text } = await chat.chat({
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.strictEqual(text, 'hello');
  assert.strictEqual(ollama.calls[0].model, 'llama3.1');
  assert.strictEqual(ollama.calls[0].stream, false);
  assert.deepStrictEqual(ollama.calls[0].messages, [
    { role: 'system', content: 'You are Data.' },
    { role: 'user', content: 'hi' },
  ]);
});

test('Ollama adapter strips Llama tokenizer artifacts from replies', async () => {
  const ollama = makeFakeOllama('<|begin_of_text|>clean me<|eot_id|>');
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  const { text } = await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(text, 'clean me');
});

test('Ollama adapter omits the system message when none is configured', async () => {
  const ollama = makeFakeOllama('ok');
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepStrictEqual(ollama.calls[0].messages, [{ role: 'user', content: 'hi' }]);
});

test('Ollama adapter returns empty string when the response has no content', async () => {
  const ollama = {
    async chat() {
      return { message: { role: 'assistant' } };
    },
  };
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  const { text } = await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(text, '');
});

test('Ollama adapter propagates errors from the underlying client', async () => {
  const ollama = makeFakeOllama(new Error('connection refused'));
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  await assert.rejects(() => chat.chat({ messages: [{ role: 'user', content: 'hi' }] }), {
    message: 'connection refused',
  });
});

// --- Gemini --------------------------------------------------------------

function makeFakeGeminiClient(reply) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        if (reply instanceof Error) throw reply;
        return { text: reply };
      },
    },
  };
}

test('Gemini adapter translates roles and lifts the system message', async () => {
  const client = makeFakeGeminiClient('hi back');
  const chat = makeGeminiChat({
    client,
    model: 'gemini-3-flash-latest',
    systemMessage: 'You are Data.',
  });

  const { text } = await chat.chat({
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'how are you?' },
    ],
  });

  assert.strictEqual(text, 'hi back');
  const req = client.calls[0];
  assert.strictEqual(req.model, 'gemini-3-flash-latest');
  assert.deepStrictEqual(req.contents, [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ text: 'hi' }] },
    { role: 'user', parts: [{ text: 'how are you?' }] },
  ]);
  assert.deepStrictEqual(req.config, { systemInstruction: 'You are Data.' });
});

test('Gemini adapter omits config when no system message is configured', async () => {
  const client = makeFakeGeminiClient('ok');
  const chat = makeGeminiChat({ client, model: 'gemini-3-flash-latest' });
  await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(client.calls[0].config, undefined);
});

test('Gemini adapter throws if constructed without a client', () => {
  assert.throws(
    () => makeGeminiChat({ client: null, model: 'gemini-3-flash-latest' }),
    /GEMINI_API_KEY/
  );
});
