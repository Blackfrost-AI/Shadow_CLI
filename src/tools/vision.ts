// Shadow's pluggable "eyes" — `describe_media` runs an image through an OpenAI-compatible vision
// endpoint and returns a TEXT description. Because the output is text, any driving model benefits,
// including a local text-only model. The endpoint is always supplied by trusted user config and is
// never hardcoded.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { imageMediaType } from '../util/image.js';
import { shadowFetch } from '../safety/egress.js';

export interface VisionConfig {
  baseUrl: string;
  model: string;
  prompt?: string;
}

export interface DescribeMediaData {
  path: string;
  backend: 'vision';
  description: string;
}

async function describeViaVision(
  cfg: VisionConfig,
  abs: string,
  mediaType: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const b64 = readFileSync(abs).toString('base64');
  const body = {
    model: cfg.model,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
        ],
      },
    ],
  };
  const res = await shadowFetch(
    `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
    { purpose: 'vision', origin: 'user' },
  );
  if (!res.ok)
    throw new Error(`vision endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

export function makeDescribeMediaTool(
  cfg: VisionConfig,
): Tool<{ path: string; prompt?: string }, DescribeMediaData> {
  return {
    name: 'describe_media',
    description:
      'Describe an image by running it through YOUR configured vision model (your "eyes"). Returns a TEXT ' +
      "description, so it works even when the current model can't see. Give a workspace-relative image path " +
      '(png/jpg/gif/webp). Use this when you need to know what is IN an image.',
    risk: 'network',
    inputSchema: z.object({ path: z.string().min(1), prompt: z.string().optional() }),
    async run(input, ctx): Promise<ToolResult<DescribeMediaData>> {
      const start = Date.now();
      const fail2 = (code: string, message: string) =>
        fail('describe_media', 'network', Date.now() - start, code, message);

      const mediaType = imageMediaType(input.path);
      if (!mediaType) {
        return fail2(
          'unsupported_image',
          `"${input.path}" is not a supported image (png/jpg/gif/webp).`,
        );
      }
      let abs: string;
      try {
        abs = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
      } catch (e) {
        return fail2('outside_workspace', (e as Error).message);
      }

      const prompt = input.prompt ?? cfg.prompt ?? 'Describe this image in detail. What is shown?';
      try {
        const description = await describeViaVision(cfg, abs, mediaType, prompt, ctx.signal);
        if (!description) return fail2('no_text', 'vision endpoint returned no description.');
        return ok('describe_media', 'network', Date.now() - start, description, {
          path: abs,
          backend: 'vision',
          description,
        });
      } catch (e) {
        if (ctx.signal.aborted || (e as Error).name === 'AbortError') {
          return fail2('aborted', 'describe_media was interrupted.');
        }
        return fail2('describe_failed', `vision describe failed: ${(e as Error).message}`);
      }
    },
  };
}
