# jklaiagent

An HTTP AI agent that talks to **Claude** through the [Meridian](https://github.com/rynfar/meridian) proxy, with a small **pluggable tool framework** and per-session conversation memory.

```
HTTP client ──POST /chat──▶ jklaiagent ──Anthropic API──▶ Meridian ──▶ Claude Code (your Claude Max/Pro)
```

The agent never holds your Anthropic credentials. It just makes standard Anthropic API calls to Meridian's local endpoint; Meridian routes them through your Claude Code subscription.

## Features

- **Built-in chat UI** — open the app's URL in a browser for a polished chat client with markdown rendering, drag & drop / paste uploads, and image previews. No separate frontend to deploy.
- **Image + file uploads** — send images (Claude vision), PDFs (document blocks), and text files (inlined) alongside your message.
- **HTTP/webhook API** — `POST /chat` to send a message and get a reply; drive it from any app, not just the browser.
- **Tool calling** — Claude can invoke registered tools mid-conversation. Ships with `get_current_time` and `fetch_url` as examples; add your own in `src/tools/`.
- **Session memory** — pass a `sessionId` to keep a conversation going (in-memory, swappable for SQLite/Redis).
- **Optional bearer auth** — protect the endpoint once it's exposed.
- **Production-ready container** — multi-stage Dockerfile, non-root user, healthcheck. Deploys to Coolify as-is.

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
| `GET /`                | —                                      | Browser chat UI.                             |
| `GET /health`          | —                                      | Liveness + model/session/tool info.          |
| `POST /chat`           | see below                              | Send a message; returns `{ sessionId, reply, toolsUsed }`. |
| `DELETE /chat/:id`     | —                                      | Clear a conversation's history.              |

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

If `AGENT_API_KEY` is set, send `Authorization: Bearer <key>` on every request except `GET /` and `GET /health`.

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
| `SESSION_TTL_MS`      | `3600000`                | Idle session lifetime before eviction (ms).                                |
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
5. Coolify maps the container's port 3000; attach a domain if you want external access.

Keep the agent and Meridian as **separate services** so you can restart/update each independently.

## Notes & next steps

- Session history is **in-memory** and cleared on restart. For durability or multiple instances, replace `src/sessions.ts` with a SQLite/Redis-backed store — the rest of the app only depends on its `getHistory`/`saveHistory`/`clearSession` functions.
- The `fetch_url` tool fetches arbitrary public URLs. If you expose the agent to untrusted callers, consider allow-listing hosts to avoid SSRF against your internal network.

## License

MIT — see [LICENSE](LICENSE).
