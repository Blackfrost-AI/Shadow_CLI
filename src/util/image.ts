/** Shared image helpers used by the `/image` attach flow (TUI) and the `view_image` tool. */

/** Map a file extension to an image MIME type, or null if it isn't a supported image. */
export function imageMediaType(path: string): string | null {
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}
