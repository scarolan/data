import test from 'node:test';
import assert from 'node:assert';

import {
  ASIMOV_RULES,
  DANCE_PARTY_EMOJI,
  buildDancePartyMessage,
  buildHelpText,
  fetchDadJoke,
  formatDadJoke,
  formatPodBayResponse,
  isDanceParty,
  isLoveYou,
  isPodBayDoor,
  isRickroll,
  isTikTok,
} from '../lib/responses.js';

test('isLoveYou matches phrases case-insensitively', () => {
  assert.ok(isLoveYou('i love you'));
  assert.ok(isLoveYou('Hey I LOVE YOU robot'));
  assert.ok(!isLoveYou('i loved you yesterday'));
  assert.ok(!isLoveYou(''));
  assert.ok(!isLoveYou(undefined));
});

test('isPodBayDoor matches the HAL line', () => {
  assert.ok(isPodBayDoor('open the pod bay door'));
  assert.ok(isPodBayDoor('Please OPEN THE POD BAY DOOR HAL'));
  assert.ok(!isPodBayDoor('open the door'));
});

test('formatPodBayResponse interpolates the display name', () => {
  assert.strictEqual(formatPodBayResponse('Dave'), "I'm sorry Dave, I'm afraid I can't do that.");
});

test('isDanceParty matches with or without a space', () => {
  assert.ok(isDanceParty('danceparty'));
  assert.ok(isDanceParty('time for a Dance Party'));
  assert.ok(!isDanceParty('partyfoul'));
});

test('buildDancePartyMessage picks 10-12 emoji using injected rng', () => {
  // Deterministic rng: always 0 → first emoji each time, count is floor(0*3)+10 = 10.
  const zero = () => 0;
  const result = buildDancePartyMessage(zero);
  assert.strictEqual(result, DANCE_PARTY_EMOJI[0].repeat(10));

  // rng → 0.999 → count is floor(0.999*3)+10 = 12, all from the last index.
  const high = () => 0.999;
  const high_result = buildDancePartyMessage(high);
  assert.strictEqual(high_result, DANCE_PARTY_EMOJI[DANCE_PARTY_EMOJI.length - 1].repeat(12));
});

test('isTikTok and isRickroll match their trigger phrases', () => {
  assert.ok(isTikTok('tiktok'));
  assert.ok(isTikTok('tik tok please'));
  assert.ok(!isTikTok('clock'));

  assert.ok(isRickroll('rickroll me'));
  assert.ok(isRickroll('rick roll'));
  assert.ok(isRickroll('Never gonna give you up'));
  assert.ok(!isRickroll('rocknroll'));
});

test('buildHelpText interpolates the bot name and lists key commands', () => {
  const help = buildHelpText('Data');
  assert.match(help, /@Data/);
  assert.match(help, /danceparty/);
  assert.match(help, /\/image/);
  assert.match(help, /the rules/);
  assert.match(help, /dad joke/);
});

test('ASIMOV_RULES contains all four laws', () => {
  for (const n of [0, 1, 2, 3]) {
    assert.match(ASIMOV_RULES, new RegExp(`^${n}\\.`, 'm'));
  }
});

test('formatDadJoke appends the punchline emoji and respects rng for zinger', () => {
  const withZinger = formatDadJoke('Why did the chicken cross the road?', () => 0.01);
  assert.match(withZinger.joke, /:sheep:/);
  assert.ok(withZinger.zinger.length > 0);

  const noZinger = formatDadJoke('A joke', () => 0.5);
  assert.strictEqual(noZinger.zinger, '');
});

test('fetchDadJoke uses the injected fetch and returns the joke text', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { text: async () => 'a fake dad joke' };
  };
  const joke = await fetchDadJoke(fakeFetch);
  assert.strictEqual(joke, 'a fake dad joke');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /icanhazdadjoke/);
  assert.strictEqual(calls[0].opts.headers.Accept, 'text/plain');
});
