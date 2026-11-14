# Self-hosting Shadow

Shadow runs your coding session on your computer or server and sends model requests to the endpoint you choose. You do not need a Shadow account. The installed binary includes the browser console and its assets.

## Connect a model you already run

From your project directory, run `shadow onboard`. Press Enter for **Model server**, choose your server or **Custom endpoint**, and enter its base URL.

| Where the model runs | Example base URL |
| --- | --- |
| Ollama on the same machine | `http://127.0.0.1:11434/v1` |
| LM Studio on the same machine | `http://127.0.0.1:1234/v1` |
| Your OpenAI-compatible model server | `http://your-model-server:8000/v1` |

These are examples; use the port and address configured on your server. Shadow discovers model IDs so you can select from what your endpoint actually serves. Leave the API key empty if your server does not require one. For a public endpoint that you operate, identify it as self-hosted when asked so Shadow allows time for model loading and prompt processing.

Select a model with tool-calling support. Catalog discovery proves that models are listed; the connection test proves the endpoint can respond. Neither alone proves that the model can reliably edit a repository.

```sh
shadow doctor                         # inspect configuration; no inference request
shadow doctor model                   # exercise the selected model's tool use
shadow                                # work in this project
```

The model test sends inference requests and can take time. If you use a paid endpoint, those requests can incur its normal charges.

## Use a model file

Choose **Local file** during onboarding to register a GGUF file or MLX model. Shadow can start the corresponding local server when you begin a session. The serving runtime and the model still need to be available on that machine.

Use `shadow local` to list and manage these models. Use `shadow local test <label>` to check a registered model before starting work.

## Work in the browser

```sh
shadow web
```

Open the access link printed in the terminal. Choose **Start a session**, add the folder you want Shadow to work in under **Settings → Projects** if needed, then start the session. A fresh console's **Web console** entry is a local overview; it does not accept prompts itself.

The console shows connection state, preserves unsent drafts within the same browser tab, and keeps a failed submission available to retry. Starter prompts fill the composer so you can review them before sending. Closing the browser tab clears its tab-scoped drafts. Browser storage restrictions can prevent draft recovery.

Model and integration configuration is captured when the server starts. Restart `shadow web` after changing those settings so new sessions use them. Existing session execution is in memory. Session logs are written to the workspace, but restarting the web process does not restore the browser session list or reconnect a running task.

## Reach a server from your other computer

The current web console intentionally listens on `127.0.0.1`. It does not support a public hostname or direct LAN listener.

On your server, from the project folder:

```sh
shadow web --no-open --port 8080
```

On your other computer, forward the **same port** through an existing SSH account:

```sh
ssh -N -L 8080:127.0.0.1:8080 user@your-server
```

Open the exact `http://127.0.0.1:8080/#t=…` link printed by Shadow in your browser on that computer. The matching port matters because Shadow checks the request host and origin. Keep the SSH connection open. If the port is occupied locally, choose a different port on both commands.

Treat the access link as a password: anyone who can reach the server and has that link can operate the console. This is a single-operator connection, without separate accounts or device permissions. A direct reverse-proxy deployment and phone pairing require a future server authentication design.

## Understand what stays local

Configuration, credential storage, and session logs live on the machine running Shadow. API credentials authenticate requests to the chosen provider. Prompts and tool results go to that provider too. Local inference can keep those requests on your hardware; a remote provider receives them.

Web tools, enabled MCP integrations, model downloads, plugin installation, and update checks have their own network behavior. `shadow doctor --privacy` describes configured paths; `shadow egress` shows the local egress journal. Use the documented offline mode when you require it, and read its actual enforcement status on your host.

Back up `~/.shadow/` and each project's `.shadow/` directory using storage you control. Protect the backup as sensitive data, especially legacy `credentials.json`, vault material, and transcripts. Retain the vault password separately so the encrypted backup is recoverable. Do not publish raw configuration or diagnostic logs without reviewing them.

## Recover from common problems

| What you see | Next step |
| --- | --- |
| Model server cannot be reached | Check the server address and port; `127.0.0.1` means the machine running Shadow. |
| Model appears in the catalog but cannot call tools | Run `shadow doctor model`; check your serving runtime's tool-calling configuration. |
| Model is slow to start answering | Confirm the endpoint is marked self-hosted; allow for loading and prompt processing. |
| Credential vault is locked | Start Shadow from a terminal to unlock it, or configure `SHADOW_VAULT_PASSWORD` in the server's protected environment. |
| Browser access expired | Reopen the complete access link printed by the running server. |
| Project needs to be added | Open Settings → Projects and add the folder you intend Shadow to work in. |
| Browser reconnects after the process restarts | Start a new browser session; durable web-session restoration is not implemented yet. |

Desktop and mobile companions should ultimately connect to a persistent Shadow server and share its sessions, approvals, and model registry. They are not required to use the current terminal and browser product.
