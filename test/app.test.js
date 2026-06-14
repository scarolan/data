import test from 'node:test';
import assert from 'node:assert';

// Importing app.js MUST be safe with no env set and no Slack/Redis available.
// If validateRequiredEnv or the IIFE ever sneaks back in unguarded, this fails.
test('importing app.js does not boot the bot or require env vars', async () => {
  const app = await import('../app.js');
  // Smoke-check that the public surface is exported.
  assert.strictEqual(typeof app.handleMessage, 'function');
  assert.strictEqual(typeof app.generateImage, 'function');
  assert.strictEqual(typeof app.cleanLocalLlmResponse, 'function');
});
