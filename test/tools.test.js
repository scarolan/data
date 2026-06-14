import test from 'node:test';
import assert from 'node:assert';

import { makeTools } from '../lib/tools.js';

function makeCtx(overrides = {}) {
  const calls = { uploads: [], posts: [], fetches: [], sleeps: [] };
  const ctx = {
    geminiClient: null,
    geminiImageModel: 'gemini-3.1-flash-image',
    botName: 'data',
    async slackUploadImage(args) {
      calls.uploads.push(args);
    },
    async slackPostBlocks(payload) {
      calls.posts.push(payload);
    },
    fetch: async () => ({ text: async () => 'a fake joke' }),
    rng: () => 0.5, // pinned: no zinger (threshold is 0.05), deterministic emoji counts
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    ...overrides,
  };
  return { ctx, calls };
}

function byName(tools, name) {
  return tools.find((t) => t.name === name);
}

test('makeTools exposes the expected tool names', () => {
  const { ctx } = makeCtx();
  const tools = makeTools(ctx);
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    'generate_image',
    'play_rickroll',
    'play_tiktok',
    'show_help',
    'start_dance_party',
    'state_asimovs_laws',
    'tell_dad_joke',
  ]);
});

test('every tool has a name, description, and JSON-schema parameters object', () => {
  const { ctx } = makeCtx();
  const tools = makeTools(ctx);
  for (const t of tools) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0, `${t.name}: name`);
    assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.name}: desc`);
    assert.strictEqual(t.parameters.type, 'object', `${t.name}: parameters.type`);
    assert.ok(t.parameters.properties, `${t.name}: parameters.properties`);
    assert.strictEqual(typeof t.execute, 'function', `${t.name}: execute`);
  }
});

test('generate_image refuses gracefully when no Gemini client is configured', async () => {
  const { ctx, calls } = makeCtx();
  const tools = makeTools(ctx);
  const result = await byName(tools, 'generate_image').execute({ prompt: 'cat' });
  assert.match(result, /GEMINI_API_KEY/);
  assert.strictEqual(calls.uploads.length, 0);
});

test('generate_image calls Gemini, uploads the buffer, and returns a confirmation', async () => {
  const fakeBuffer = Buffer.from('png-bytes');
  const geminiClient = {
    models: {
      async generateContent() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { data: fakeBuffer.toString('base64'), mimeType: 'image/png' } },
                ],
              },
            },
          ],
        };
      },
    },
  };
  const { ctx, calls } = makeCtx({ geminiClient });
  const tools = makeTools(ctx);
  const result = await byName(tools, 'generate_image').execute({ prompt: 'a sehlat' });

  assert.match(result, /Image generated/);
  assert.match(result, /sehlat/);
  assert.strictEqual(calls.uploads.length, 1);
  assert.strictEqual(calls.uploads[0].prompt, 'a sehlat');
  assert.ok(Buffer.isBuffer(calls.uploads[0].buffer));
});

test('tell_dad_joke fetches a joke and posts it (no zinger)', async () => {
  const { ctx, calls } = makeCtx({
    fetch: async () => ({ text: async () => 'Why did the chicken cross the road?' }),
  });
  const tools = makeTools(ctx);
  const result = await byName(tools, 'tell_dad_joke').execute();
  assert.match(result, /chicken/);
  assert.match(calls.posts[0], /chicken/);
  // rng pinned above the zinger threshold — no follow-up message, no sleep.
  assert.strictEqual(calls.posts.length, 1);
  assert.strictEqual(calls.sleeps.length, 0);
});

test('tell_dad_joke fires the zinger when rng falls in the lucky band', async () => {
  const { ctx, calls } = makeCtx({
    fetch: async () => ({ text: async () => 'Why did the chicken cross the road?' }),
    rng: () => 0.01, // below the 0.05 zinger threshold
  });
  const tools = makeTools(ctx);
  await byName(tools, 'tell_dad_joke').execute();
  assert.strictEqual(calls.posts.length, 2);
  assert.deepStrictEqual(calls.sleeps, [10000]);
});

test('state_asimovs_laws posts the four laws', async () => {
  const { ctx, calls } = makeCtx();
  const tools = makeTools(ctx);
  await byName(tools, 'state_asimovs_laws').execute();
  assert.strictEqual(calls.posts.length, 1);
  for (const n of [0, 1, 2, 3]) assert.match(calls.posts[0], new RegExp(`^${n}\\.`, 'm'));
});

test('show_help posts the help text containing the bot name', async () => {
  const { ctx, calls } = makeCtx();
  const tools = makeTools(ctx);
  await byName(tools, 'show_help').execute();
  assert.match(calls.posts[0], /@data/);
});

test('start_dance_party, play_rickroll, play_tiktok each post a payload', async () => {
  const { ctx, calls } = makeCtx();
  const tools = makeTools(ctx);
  await byName(tools, 'start_dance_party').execute();
  await byName(tools, 'play_rickroll').execute();
  await byName(tools, 'play_tiktok').execute();
  assert.strictEqual(calls.posts.length, 3);
});
