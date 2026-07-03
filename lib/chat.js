// Backend-agnostic chat orchestration. `chat` is one of the adapters from
// lib/chat-backends.js; conversation history lives in `convoStore` (Keyv in
// prod, in-memory shim in tests) keyed by Slack user id.
//
// Return shape: { text }.

const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

const DEFAULT_HISTORY_LIMIT = 20;

function convoKey(userId) {
  return `convo:${userId}`;
}

// Per-user write serialization. handleMessage does a read-modify-write on a
// user's history (get → chat → set); two messages arriving close together from
// the same user would otherwise both read the same base history and the second
// set() would clobber the first turn ("Data forgot what I just said"). Chain
// each user's turns through a promise so they apply in order — later turns also
// see earlier ones in context. In-process only, which is sufficient: the bot
// runs as a single process. The map self-cleans once a user goes idle.
const userLocks = new Map();

function withUserLock(key, fn) {
  const prev = userLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run after prev settles, either way
  const tail = run.then(
    () => {},
    () => {}
  );
  userLocks.set(key, tail);
  tail.then(() => {
    if (userLocks.get(key) === tail) userLocks.delete(key);
  });
  return run;
}

// Wipe a single user's stored conversation history. Used by the /forget slash
// command so a user can reset their own context. No-op-safe: deleting a missing
// key is fine. Returns true once the delete resolves.
export async function clearHistory(userId, { convoStore }) {
  if (!userId) return false;
  await convoStore.delete(convoKey(userId));
  return true;
}

// Heuristic: does this error look like a content/safety rejection (→ ask the
// user to rephrase) versus a plain infrastructure failure (→ generic apology)?
// A bare `content` substring used to match unrelated errors like
// "unexpected content-type" or "content-length mismatch" and wrongly tell the
// user to rephrase a perfectly fine message. Match the policy-specific signals
// instead (including the two-word `content policy`/`content filter` phrases).
function looksLikeContentError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (
    msg.includes('safety') ||
    msg.includes('policy') ||
    msg.includes('moderation') ||
    msg.includes('blocked') ||
    msg.includes('prohibited') ||
    msg.includes('content filter')
  );
}

export async function handleMessage(
  message,
  { chat, convoStore, historyLimit = DEFAULT_HISTORY_LIMIT }
) {
  const text = message.text || '';
  const images = message.images || [];
  if (!text && !images.length) {
    return { text: 'I apologize, but I cannot process an empty message. How may I assist you?' };
  }

  const key = convoKey(message.user);
  const userTurn = { role: 'user', content: text };
  if (images.length) userTurn.images = images;

  // Serialize the read-modify-write so concurrent turns from the same user
  // don't race on history (see withUserLock).
  return withUserLock(key, async () => {
    const history = (await convoStore.get(key)) || [];
    try {
      const result = await chat.chat({ messages: [...history, userTurn] });
      const reply = result.text || '';

      // An empty reply (e.g. the model emitted only tokenizer artifacts that the
      // adapter stripped) must not be persisted or posted: a blank assistant turn
      // pollutes history, and say('') is rejected by Slack (no_text) which would
      // surface as a bogus "technical difficulties" error. Bail with a real reply.
      if (!reply.trim()) {
        console.warn('Chat backend returned an empty reply; not persisting the turn.');
        return {
          text: 'I apologize, but I was unable to formulate a response. Could you please rephrase your request?',
        };
      }

      // Persist the text portion of the user turn — image bytes are big and the
      // Slack file URLs they originated from will eventually expire, so we don't
      // try to keep them.
      const persistedUserTurn = { role: 'user', content: text };
      const nextHistory = [
        ...history,
        persistedUserTurn,
        { role: 'assistant', content: reply },
      ].slice(-historyLimit);
      await convoStore.set(key, nextHistory);

      return { text: reply };
    } catch (error) {
      console.error('Error in handleMessage:', error);
      if (looksLikeContentError(error)) {
        return {
          text: 'I apologize, but I encountered an issue processing your message. Could you please rephrase your request?',
        };
      }
      return { text: GENERIC_ERROR_TEXT };
    }
  });
}
