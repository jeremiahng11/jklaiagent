<img src="assets/logo.svg" alt="JKL aiAgent" width="56" align="left" />

# JKL aiAgent

An HTTP AI agent that talks to **Claude** through the [Meridian](https://github.com/rynfar/meridian) proxy, with a small **pluggable tool framework** and per-session conversation memory. (Package / repo name: `jklaiagent`.)

```
HTTP client ──POST /chat──▶ jklaiagent ──Anthropic API──▶ Meridian ──▶ Claude Code (your Claude Max/Pro)
```

The agent never holds your Anthropic credentials. It just makes standard Anthropic API calls to Meridian's local endpoint; Meridian routes them through your Claude Code subscription.

## Features

- **3-pane chat app** — open the app's URL in a browser for a full client: a **history sidebar** (switch / rename / delete conversations), the chat, and an **artifact preview pane**.
- **Artifact preview** — code the AI produces appears on the right with copy + download; HTML/SVG can be rendered live in a sandboxed frame; referenced images preview inline. Toggle the pane any time with the **⧉ Preview** button in the header (it shows how many artifacts the open chat has), so you can reopen it after closing without losing anything.
- **Persistent conversations** — every chat is saved to disk and reloads after restarts/redeploys (mount a volume at `DATA_DIR`). Pick up any past conversation, with its images and context intact.
- **Image + file uploads** — drag & drop, paste, or 📎 to send images (Claude vision), PDFs (document blocks), and text files (inlined).
- **HTTP/webhook API** — `POST /chat` to drive it from any app, not just the browser.
- **Tool calling** — Claude can invoke registered tools mid-conversation. Ships with `get_current_time` and `fetch_url` as examples; add your own in `src/tools/`.
- **Optional bearer auth** — protect the endpoints once exposed.
- **Production-ready container** — multi-stage Dockerfile, non-root user, healthcheck, persistent data volume. Deploys to Coolify as-is.

## Using the chat UI

Open the app's URL (the Coolify domain, or `http://localhost:3000` locally) in a browser. You can:

- Type a message and press **Enter** (Shift+Enter for a newline).
- **Attach files** with the 📎 button, **drag & drop** onto the input, or **paste** an image from the clipboard.
- If the server has `AGENT_API_KEY` set, open **⚙ Settings** once and paste the token — it's stored in your browser and sent automatically.

## Tech stack

TypeScript (strict) · Fastify 5 · `@anthropic-ai/sdk` · zod · Node 22

## Run locally

Requires Node 20+ and a running Meridian instance.

```bash
npm install
cp .env.example .env        # then edit MERIDIAN_BASE_URL etc.
npm run dev                 # hot-reloading dev server on :3000
```

Production build:

```bash
npm run build
npm start
```

Try it:

```bash
# First message — omit sessionId to start a new conversation
curl -s localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What time is it in Singapore?"}'

# Continue the conversation by passing back the returned sessionId
curl -s localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"message":"And in UTC?","sessionId":"<id-from-previous-response>"}'
```

## API

| Method & path          | Body / params                          | Description                                  |
| ---------------------- | -------------------------------------- | -------------------------------------------- |
| `GET /`                | —                                      | Browser chat app.                            |
| `GET /health`          | —                                      | Liveness + model/session/tool info.          |
| `GET /diag`            | —                                      | Tests whether the agent can reach Meridian.  |
| `POST /chat`           | see below                              | Send a message; returns `{ sessionId, title, reply, toolsUsed }`. |
| `GET /sessions`        | —                                      | List saved conversations (metadata).         |
| `GET /sessions/:id`    | —                                      | Get a conversation's display transcript.     |
| `PATCH /sessions/:id`  | `{ "title": string }`                  | Rename a conversation.                       |
| `DELETE /sessions/:id` | —                                      | Delete a conversation.                       |

`POST /chat` body — provide a `message`, `attachments`, or both:

```jsonc
{
  "message": "What's in this image?",
  "sessionId": "optional-to-continue-a-conversation",
  "attachments": [
    { "name": "photo.png", "mediaType": "image/png", "data": "<base64 bytes, no data: prefix>" }
  ]
}
```

Attachments are routed by `mediaType`: `image/{jpeg,png,gif,webp}` → vision, `application/pdf` → document, anything else → decoded and inlined as text. The JSON body limit is 30 MB (the UI caps each file at 10 MB).

If `AGENT_API_KEY` is set, send `Authorization: Bearer <key>` on every request except `GET /`, `GET /health`, and `GET /diag`.

## Environment variables

| Variable              | Default                  | Description                                                                 |
| --------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `PORT`                | `3000`                   | HTTP port.                                                                  |
| `HOST`                | `0.0.0.0`                | Bind address.                                                               |
| `MERIDIAN_BASE_URL`   | `http://localhost:8080`  | Meridian's Anthropic-compatible endpoint. Use the service name across Coolify services (e.g. `http://meridian:8080`). |
| `MERIDIAN_API_KEY`    | `meridian`               | Placeholder key the SDK requires; Meridian auths via your Claude Code session. |
| `ANTHROPIC_MODEL`     | `claude-sonnet-4-6`      | Model name passed to Meridian.                                              |
| `MAX_TOKENS`          | `2048`                   | Max output tokens per response.                                             |
| `SYSTEM_PROMPT`       | _(see `.env.example`)_   | System prompt defining the agent's behaviour.                              |
| `MAX_TOOL_ITERATIONS` | `8`                      | Safety cap on tool-call round trips per request.                           |
| `DATA_DIR`            | `./data` (`/app/data` in Docker) | Where conversations are persisted. Mount a volume here to keep history. |
| `AGENT_API_KEY`       | _(unset)_                | If set, required as a bearer token. **Set this once exposed.**             |
| `LOG_LEVEL`           | `info`                   | pino log level.                                                            |

## Adding a tool

1. Create `src/tools/myTool.ts` exporting a `Tool` (see `getTime.ts` for the shape).
2. Add it to the `tools` array in `src/tools/index.ts`.

That's it — the agent loop and API pick it up automatically.

## Deploying on Coolify (Raspberry Pi)

1. Push this repo to GitHub (done).
2. In Coolify, create a new **Application** from this Git repo. Coolify detects the Dockerfile and builds it (native arm64 on the Pi — no emulation).
3. Set environment variables (above). Point `MERIDIAN_BASE_URL` at your Meridian service — if Meridian is another Coolify service on the same project network, use its internal name, e.g. `http://meridian:8080`.
4. Set `AGENT_API_KEY` to a strong random value before exposing the app publicly.
5. **Add a persistent volume** mounted at `/app/data` (Coolify → Storage) so conversation history survives redeploys. Without it, history is wiped on every rebuild.
6. Coolify maps the container's port 3000; attach a domain if you want external access.

Keep the agent and Meridian as **separate services** so you can restart/update each independently.

## Notes & next steps

- Conversations are persisted as JSON files under `DATA_DIR` (one file per conversation, loaded into memory at boot). Great for a single-instance personal agent on a Pi. For multi-instance or high volume, swap `src/store.ts` for a SQLite/Postgres-backed implementation — the rest of the app only depends on its exported functions.
- Stored history includes uploaded image bytes (base64), so reopening an old chat restores its image context. Watch `DATA_DIR` disk usage if you upload many large images.
- The `fetch_url` tool fetches public URLs only — it resolves each target (and every redirect hop) and refuses loopback, link-local, RFC1918, CGNAT, and cloud-metadata (`169.254.169.254`) addresses, so it can't be turned against Meridian or the rest of your internal network. If you need it to reach a specific internal host, add an explicit allow-list in `src/tools/fetchUrl.ts`.
- The artifact pane renders HTML/SVG in a `sandbox="allow-scripts"` iframe. Only run artifacts you trust.

## License

MIT — see [LICENSE](LICENSE).
