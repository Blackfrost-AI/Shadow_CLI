// Shadow's pluggable "eyes" — `describe_media` runs an image through a vision model YOU run and returns
// a TEXT description. Because the output is text, ANY driving model benefits — including a text-only
// local one with no native vision. Two backends:
//   • vision  — any OpenAI-compatible vision endpoint (Ollama/vLLM/llama.cpp serving a VLM). PREFERRED.
//   • comfy   — a local ComfyUI caption workflow.
//
// The endpoint is ALWAYS supplied by config (~/.shadow or env) — never hardcoded — and both are
// PROJECT_UNTRUSTED_KEYS, so a cloned repo can't redirect where your workspace media is uploaded. The
// pure helpers (graph builder + output parser) are exported for unit testing without a live server.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { imageMediaType } from '../util/image.js';

/** An OpenAI-compatible vision endpoint (baseUrl ends in /v1). The reproducible "eyes" backend. */
export interface VisionConfig {
  baseUrl: string;
  model: string;
  prompt?: string;
}

export interface ComfyConfig {
  baseUrl: string;
  visionModel?: string;
  visionType?: string;
  describePrompt?: string;
}

export interface DescribeConfig {
  vision?: VisionConfig;
  comfy?: ComfyConfig;
}

export interface DescribeMediaData {
  path: string;
  backend: string;
  description: string;
}

/** ComfyUI API-format graph: load the VL model, run it over an uploaded image, echo the text out. */
export function buildDescribeGraph(opts: {
  filename: string;
  model: string;
  clipType: string;
  prompt: string;
  maxLength: number;
}): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '1': { class_type: 'CLIPLoader', inputs: { clip_name: opts.model, type: opts.clipType } },
    '2': { class_type: 'LoadImage', inputs: { image: opts.filename } },
    '3': {
      class_type: 'TextGenerate',
      inputs: { clip: ['1', 0], prompt: opts.prompt, max_length: opts.maxLength, sampling_mode: 'off', image: ['2', 0] },
    },
    '4': { class_type: 'PreviewAny', inputs: { source: ['3', 0] } },
  };
}

/** Pull the first non-empty text string out of a ComfyUI `/history` outputs blob (PreviewAny/text nodes). */
export function extractText(outputs: Record<string, unknown> | undefined): string | null {
  for (const node of Object.values(outputs ?? {})) {
    const n = node as Record<string, unknown>;
    for (const field of ['text', 'string', 'value']) {
      const v = n?.[field];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v)) {
        const s = v.find((x) => typeof x === 'string' && x.trim());
        if (s) return (s as string).trim();
      }
    }
  }
  return null;
}

/** Read a ComfyUI `/history/{id}` entry into a terminal outcome: pending, the text, or a node error. */
export function readHistory(
  entry: { status?: { status_str?: string; messages?: unknown[] }; outputs?: Record<string, unknown> } | undefined,
): { state: 'pending' } | { state: 'done'; text: string | null } | { state: 'error'; message: string } {
  if (!entry) return { state: 'pending' };
  const status = entry.status?.status_str;
  if (status === 'error') {
    let msg = 'ComfyUI workflow failed';
    for (const m of entry.status?.messages ?? []) {
      const mm = m as [string, Record<string, unknown>];
      if (mm[0] === 'execution_error') {
        msg = `ComfyUI node ${mm[1]?.node_type ?? '?'} failed: ${String(mm[1]?.exception_message ?? '').slice(0, 300)}`;
        break;
      }
    }
    return { state: 'error', message: msg };
  }
  if (status === 'success' || entry.outputs) return { state: 'done', text: extractText(entry.outputs) };
  return { state: 'pending' };
}

async function uploadImage(base: string, abs: string, mediaType: string, signal: AbortSignal): Promise<string> {
  const fd = new FormData();
  fd.append('image', new Blob([readFileSync(abs)], { type: mediaType }), basename(abs));
  fd.append('overwrite', 'true');
  const res = await fetch(`${base}/upload/image`, { method: 'POST', body: fd, signal });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  const j = (await res.json()) as { name: string; subfolder?: string };
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

/** Describe an image via an OpenAI-compatible vision endpoint (POST the image as a data-URI image_url). */
async function describeViaVision(cfg: VisionConfig, abs: string, mediaType: string, prompt: string, signal: AbortSignal): Promise<string> {
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
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`vision endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

/** Describe an image via a local ComfyUI caption workflow (upload → submit → poll → text). */
async function describeViaComfy(cfg: ComfyConfig, abs: string, mediaType: string, prompt: string, signal: AbortSignal): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!cfg.visionModel) throw new Error('comfy.visionModel is not set — no vision model to describe with.');
  const filename = await uploadImage(base, abs, mediaType, signal);
  const graph = buildDescribeGraph({ filename, model: cfg.visionModel, clipType: cfg.visionType ?? 'qwen_image', prompt, maxLength: 300 });
  const sub = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }), signal });
  if (!sub.ok) throw new Error(`ComfyUI rejected the workflow: HTTP ${sub.status} ${(await sub.text()).slice(0, 200)}`);
  const promptId = ((await sub.json()) as { prompt_id: string }).prompt_id;
  for (let i = 0; i < 60; i++) {
    await sleep(2000, signal);
    const h = (await (await fetch(`${base}/history/${promptId}`, { signal })).json()) as Record<string, unknown>;
    const r = readHistory(h[promptId] as never);
    if (r.state === 'error') throw new Error(r.message);
    if (r.state === 'done') {
      if (!r.text) throw new Error('ComfyUI finished but returned no text — check the workflow output node.');
      return r.text;
    }
  }
  throw new Error('ComfyUI did not return a description within 2 minutes.');
}

/** Build the `describe_media` tool. Prefers the OpenAI-compatible `vision` endpoint; falls back to ComfyUI. */
export function makeDescribeMediaTool(cfg: DescribeConfig): Tool<{ path: string; prompt?: string }, DescribeMediaData> {
  const backend = cfg.vision ? 'vision' : 'comfy';
  return {
    name: 'describe_media',
    description:
      'Describe an image by running it through YOUR configured vision model (your "eyes"). Returns a TEXT ' +
      'description, so it works even when the current model can\'t see. Give a workspace-relative image path ' +
      '(png/jpg/gif/webp). Use this when you need to know what is IN an image.',
    risk: 'network',
    inputSchema: z.object({ path: z.string().min(1), prompt: z.string().optional() }),
    async run(input, ctx): Promise<ToolResult<DescribeMediaData>> {
      const start = Date.now();
      const fail2 = (code: string, message: string) => fail('describe_media', 'network', Date.now() - start, code, message);

      const mediaType = imageMediaType(input.path);
      if (!mediaType) return fail2('unsupported_image', `"${input.path}" is not a supported image (png/jpg/gif/webp).`);
      let abs: string;
      try {
        abs = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
      } catch (e) {
        return fail2('outside_workspace', (e as Error).message);
      }

      const prompt = input.prompt ?? cfg.vision?.prompt ?? cfg.comfy?.describePrompt ?? 'Describe this image in detail. What is shown?';
      try {
        const text = cfg.vision
          ? await describeViaVision(cfg.vision, abs, mediaType, prompt, ctx.signal)
          : await describeViaComfy(cfg.comfy!, abs, mediaType, prompt, ctx.signal);
        if (!text) return fail2('no_text', `${backend} endpoint returned no description.`);
        return ok('describe_media', 'network', Date.now() - start, text, { path: abs, backend, description: text });
      } catch (e) {
        if ((e as Error).message === 'aborted') return fail2('aborted', 'describe_media was interrupted.');
        return fail2('describe_failed', `${backend} describe failed: ${(e as Error).message}`);
      }
    },
  };
}
