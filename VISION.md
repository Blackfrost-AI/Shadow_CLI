# Vision — give any model eyes

**Point Shadow at a vision model you run, and every model you drive can see — even a text-only one.**

Most coding agents can only "see" if the model you're driving happens to be multimodal, and only by
sending your images to that model's provider. Shadow takes a different stance: **vision is a capability
you plug in, not a property of your model.** Run any vision-language model (VLM) behind an
OpenAI-compatible endpoint — Ollama, vLLM, llama.cpp — point Shadow at it, and the driving model gains
eyes by *delegating*.

Ask *"what's in this screenshot?"* and the model calls one tool, `describe_media`. Shadow sends the image
to **your** vision endpoint, gets back a text description, and hands it to the model to reason over. Because
the hand-off is text in, text out:

- **A text-only model can see.** A small local coder with no native vision can inspect a UI screenshot, a
  diagram, a design mockup, or a rendered chart — by asking a VLM you host.
- **It stays on your terms.** The image goes to the vision model *you* chose and run. No coding-provider
  vision API, no image leaving your machines except to your own endpoint.
- **It composes with strong VLMs.** Use whatever you like — a 4B local model for cheap glances, or a large
  one for dense, faithful descriptions.

---

## How it works

Shadow registers a `describe_media` tool whenever you've configured a vision endpoint. When the driving
model wants to know what's in an image, it calls:

```
describe_media(path: "shot.png", prompt?: "…optional focus…")
```

Shadow resolves the path inside your workspace, POSTs the image to your endpoint's
`/v1/chat/completions` as an `image_url`, and returns the description as the tool result. The model reads
it like any other tool output and continues — often adding its own reasoning on top ("the sharp shadows
say it's midday", "this error dialog means the build failed").

Supported image formats: **png, jpg/jpeg, gif, webp.**

---

## Setup

### 1. Run a vision model behind an OpenAI-compatible endpoint

Any of these work — pick what you already run:

**Ollama** (simplest):

```bash
ollama pull <a-vision-model>        # e.g. a qwen-vl / llava-family model
# Ollama serves an OpenAI-compatible API at http://localhost:11434/v1
```

**vLLM** (throughput, big context):

```bash
docker run -d --gpus all -p 8001:8000 \
  vllm/vllm-openai:latest \
  --model <org/your-vlm> \
  --served-model-name my-vlm \
  --trust-remote-code
# → http://<host>:8001/v1
```

**llama.cpp**:

```bash
llama-server -m <your-vlm.gguf> --mmproj <mmproj.gguf> --host 0.0.0.0 --port 8001
# → http://<host>:8001/v1
```

### 2. Point Shadow at it

Add a `vision` block to `~/.shadow/config.json` (global config — **not** a project file):

```json
{
  "vision": {
    "baseUrl": "http://your-vlm-host:8001/v1",
    "model": "my-vlm",
    "prompt": "Describe this image in detail. What is shown?"
  }
}
```

- `baseUrl` — your endpoint, ending in `/v1`.
- `model` — the served model name your endpoint reports at `/v1/models`.
- `prompt` — optional default question; the model can override it per call.

### 3. Use it

Just ask, in plain language:

```
> what's in ~/Downloads/mockup.png?
> does this error screenshot say the build failed? check build-error.png
> read the numbers off this chart: q3-revenue.png
```

The model picks the tool on its own — no special syntax.

---

## Privacy & safety

Vision follows the same posture as the rest of Shadow:

- **Your endpoint, your data.** The only outbound traffic is to the vision endpoint you configured.
  Nothing goes to a coding-model provider's vision API.
- **Endpoint is global-config or env only.** `vision` is a *project-untrusted* key — a cloned repository
  can never set or redirect it, so a hostile repo can't point your images at an endpoint it controls.
- **Workspace-scoped.** `describe_media` only reads images inside your workspace (and any `--add-dir`
  roots), same jail as every file tool.
- **Off in offline mode.** `--offline` doesn't register the tool at all — it's a network call, and the
  no-egress contract wins.

---

## ComfyUI backend (alternative)

If you run a **ComfyUI** instance, Shadow can drive a caption workflow there instead — configure a
`comfy` block (`baseUrl`, `visionModel`, `visionType`) and `describe_media` will upload the image, run the
workflow, and return the text. The `vision` (OpenAI-compatible) backend is preferred and recommended for
its simplicity; ComfyUI is the right home when you also want image **generation** from the same box.

---

## The idea in one line

Your coding model doesn't need to be able to see. It needs to be able to *ask something that can.*
