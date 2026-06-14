import test from 'node:test';
import assert from 'node:assert';

import { generateImage } from '../lib/image.js';

function makeFakeGemini(response) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

function makeImageResponse(base64) {
  return {
    candidates: [{ content: { parts: [{ inlineData: { data: base64, mimeType: 'image/png' } }] } }],
  };
}

test('generateImage rejects empty prompts before touching the client', async () => {
  const client = makeFakeGemini({});
  await assert.rejects(
    () => generateImage('', { client, model: 'gemini-3.1-flash-image' }),
    /Empty prompt/
  );
  assert.strictEqual(client.calls.length, 0);
});

test('generateImage rejects when no client is configured', async () => {
  await assert.rejects(
    () => generateImage('cat on a couch', { client: null, model: 'gemini-3.1-flash-image' }),
    /GEMINI_API_KEY is not configured/
  );
});

test('generateImage returns a Buffer decoded from the inlineData', async () => {
  const expected = Buffer.from('hello-png-bytes', 'utf8');
  const client = makeFakeGemini(makeImageResponse(expected.toString('base64')));
  const buf = await generateImage('cat on a couch', {
    client,
    model: 'gemini-3.1-flash-image',
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString('utf8'), 'hello-png-bytes');
  assert.deepStrictEqual(client.calls[0], {
    model: 'gemini-3.1-flash-image',
    contents: 'cat on a couch',
  });
});

test('generateImage surfaces the text part when the model refuses to return an image', async () => {
  const client = makeFakeGemini({
    candidates: [{ content: { parts: [{ text: 'I cannot generate that.' }] } }],
  });
  await assert.rejects(
    () => generateImage('something forbidden', { client, model: 'gemini-3.1-flash-image' }),
    /I cannot generate that\./
  );
});

test('generateImage throws a generic error when the response has no parts at all', async () => {
  const client = makeFakeGemini({ candidates: [{ content: { parts: [] } }] });
  await assert.rejects(
    () => generateImage('cat', { client, model: 'gemini-3.1-flash-image' }),
    /invalid response/
  );
});
