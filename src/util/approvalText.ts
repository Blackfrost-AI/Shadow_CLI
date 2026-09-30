/**
 * Display-only projection of untrusted approval text, before width measurement or styling.
 * Escape controls visibly instead of deleting escape sequences: an unterminated OSC must not
 * swallow the rest of the command. Keep the original tool input and question answers intact.
 */
export function approvalText(text: string): string {
  return text
    .replace(
      /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (char) => {
        const code = char.charCodeAt(0);
        return code <= 0xff
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`;
      },
    )
    .replace(/[\n\t]/g, ' ');
}
