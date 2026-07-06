import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { imageMediaType } from '../util/image.js';

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to an image file (png, jpg/jpeg, gif, webp), relative to the workspace root or absolute. Must stay inside the workspace.'),
});

type ViewImageInput = z.infer<typeof inputSchema>;

export interface ViewImageData {
  path: string;
  mediaType: string;
  bytes: number;
}

// Anthropic caps a single image near 5 MB; keep a margin so the request never 400s on
// size (and a base64 blob much larger than this would swamp the context window anyway).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const viewImage: Tool<ViewImageInput, ViewImageData> = {
  name: 'view_image',
  description:
    'Load an image file from the workspace into the conversation so you can SEE it (screenshots, ' +
    'diagrams, design mockups, rendered output). Supported: png, jpg/jpeg, gif, webp. The image is ' +
    'added to your context as visual input — use this instead of read_file for images (read_file refuses ' +
    'binaries). Only works with vision-capable models.',
  risk: 'read',
  async run(input, ctx): Promise<ToolResult<ViewImageData>> {
    const start = Date.now();

    const mediaType = imageMediaType(input.path);
    if (!mediaType) {
      return fail(
        'view_image',
        'read',
        Date.now() - start,
        'unsupported_image',
        `"${input.path}" is not a supported image (need .png, .jpg/.jpeg, .gif, or .webp).`,
      );
    }

    let abs: string;
    try {
      abs = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
    } catch (e) {
      return fail('view_image', 'read', Date.now() - start, 'outside_workspace', (e as Error).message);
    }

    let bytes: number;
    try {
      bytes = statSync(abs).size;
    } catch (e) {
      return fail('view_image', 'read', Date.now() - start, 'read_failed', `could not stat "${input.path}": ${(e as Error).message}`);
    }
    if (bytes > MAX_IMAGE_BYTES) {
      return fail(
        'view_image',
        'read',
        Date.now() - start,
        'image_too_large',
        `"${input.path}" is ${(bytes / (1024 * 1024)).toFixed(1)} MB — over the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit. Resize or crop it first.`,
      );
    }

    let data: string;
    try {
      data = readFileSync(abs).toString('base64');
    } catch (e) {
      return fail('view_image', 'read', Date.now() - start, 'read_failed', `could not read "${input.path}": ${(e as Error).message}`);
    }

    ctx.readTracker?.markSeen(abs);

    const result = ok(
      'view_image',
      'read',
      Date.now() - start,
      `Loaded image "${input.path}" (${mediaType}, ${(bytes / 1024).toFixed(1)} KB) — shown below.`,
      { path: abs, mediaType, bytes },
    );
    result.images = [{ type: 'image', mediaType, data }];
    return result;
  },
  inputSchema,
};
