/** Optional identity hints must never appear in terminal output or browser launch diagnostics. */
export function publicSignInUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.delete('id_token_hint');
  url.searchParams.delete('login_hint');
  return url.toString();
}
