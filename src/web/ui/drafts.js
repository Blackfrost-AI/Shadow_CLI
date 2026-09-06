// Drafts belong to this browser tab and origin. They never go to the server until sent.
const prefix = 'shadow.draft.';

export function readDraft(sessionId) {
  try {
    return sessionStorage.getItem(prefix + sessionId) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(sessionId, text) {
  try {
    if (text) sessionStorage.setItem(prefix + sessionId, text);
    else sessionStorage.removeItem(prefix + sessionId);
    return true;
  } catch {
    return false; // The composer still works when storage is unavailable or full.
  }
}
