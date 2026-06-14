// Backend-agnostic chat orchestration. `chat` is one of the adapters from
// lib/chat-backends.js; conversation history lives in `convoStore` (Keyv in
// prod, in-memory shim in tests) keyed by Slack user id. History survives
// process restarts because we own all the state — no reliance on any
// provider's server-side conversation tracking.

const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

const DEFAULT_HISTORY_LIMIT = 20;

function convoKey(userId) {
  return `convo:${userId}`;
}

function looksLikeContentError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (
    msg.includes('content') ||
    msg.includes('policy') ||
    msg.includes('moderation') ||
    msg.includes('safety')
  );
}

export async function handleMessage(
  message,
  { chat, convoStore, historyLimit = DEFAULT_HISTORY_LIMIT }
) {
  if (!message.text) {
    return 'I apologize, but I cannot process an empty message. How may I assist you?';
  }

  const key = convoKey(message.user);
  const history = (await convoStore.get(key)) || [];
  const turn = { role: 'user', content: message.text };

  try {
    const { text } = await chat.chat({ messages: [...history, turn] });

    const nextHistory = [...history, turn, { role: 'assistant', content: text }].slice(
      -historyLimit
    );
    await convoStore.set(key, nextHistory);

    return text;
  } catch (error) {
    console.error('Error in handleMessage:', error);
    if (looksLikeContentError(error)) {
      return 'I apologize, but I encountered an issue processing your message. Could you please rephrase your request?';
    }
    return GENERIC_ERROR_TEXT;
  }
}
