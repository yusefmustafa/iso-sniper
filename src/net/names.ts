/**
 * Player names: 2 to 16 characters of letters (any language), digits, spaces
 * and - _ . ' . Emoji and other symbols are rejected. Names are compared
 * case-insensitively, so "Yusef" and "yusef" can't both be in one lobby.
 */
export const NAME_MIN = 2;
export const NAME_MAX = 16;
const ALLOWED = /^[\p{L}\p{M}\p{N} _.'-]+$/u;

/** Trim and collapse runs of spaces. */
export const cleanName = (raw: string) => raw.replace(/\s+/g, ' ').trim();

/** Why a name is not allowed, or null if it is fine. */
export function nameError(raw: string): string | null {
  const name = cleanName(raw);
  if (name.length < NAME_MIN) return `Use at least ${NAME_MIN} characters.`;
  if ([...name].length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`;
  if (!ALLOWED.test(name)) return 'Letters, numbers, spaces and - _ . \' only (no emoji).';
  return null;
}

export const sameName = (a: string, b: string) => cleanName(a).toLocaleLowerCase() === cleanName(b).toLocaleLowerCase();

/** For anything that goes into innerHTML. Names come from the other player, so never trust them. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
