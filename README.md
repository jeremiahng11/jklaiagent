# JKL aiAgent — Mission Control

A live, multi-agent **office dashboard**. **JAY JAY** (the CTO) orchestrates a team
of specialist agents who plan a goal, split it into department sub-tasks, build the
deliverables, QA and review them, and synthesize a final result — all visualised in
real time. The brain is **Claude, reached through the [Meridian](https://github.com/rynfar/meridian) proxy** (Anthropic-compatible), so no model API keys live in the app — Meridian routes through your Claude Code subscription.

```
Browser ──REST + WebSocket──▶ Mission Control ──Anthropic SDK──▶ Meridian ──▶ Claude
```

## The team

| Agent | Department | Does |
|-------|------------|------|
| **JAY JAY** | Command | CTO orchestrator — routes, plans, reviews, synthesizes |
| **SCOUT** | Observatory | Research, scanning, monitoring |
| **SCRIBE** | Research Lab | Writing, analysis, reports |
| **ORBIT** | Development | Builds apps/sites (Django/Node/Flutter/React/RN or single-file UI) |
| **WARDEN** | Security | Risk, compliance, vulnerability review |
| **VAULT** | Admin | Records, organising, structured data |

## Features

- **Live visual office** — rooms animate as agents think/work; real-time event ticker over WebSocket.
- **Orchestration** — assign one task or a whole mission; JAY JAY routes "Any" tasks to the right specialist, decomposes goals into chained sub-tasks, and assembles the final deliverable.
- **Two model tiers via Meridian** — Sonnet for the heavy work (deliverables, planning, synthesis), Haiku for high-frequency orchestration (routing, review, memory notes, the AUTO demo), with automatic heavy→light fallback and live model-health.
- **Tools** — cross-department handoffs (`request_help`), SSRF-guarded `http_request` for API testing, and `request_credentials` for sandbox keys.
- **Deliverables** — Markdown → downloadable **Word (.doc)**; multi-file code projects → **.zip**; live **preview** of web builds in a sandboxed iframe.
- **Continuous improvement** — Scribe reviews completed work and proposes/auto-applies enhancements; independent QA (Scout tests Orbit's builds, Orbit fixes).
- **Calendar / routines**, **per-task memory**, **issues**, **daily usage & cost** stats, **auth**, and an installable **PWA**.
- **Simulation mode** — with `SIMULATE=true` (or Meridian unreachable) the office runs end-to-end with believable placeholder output and zero model calls.

## Run locally

Requires Node 20+ (22 recommended) and a running Meridian instance.

```bash
npm install
cp .env.example .env        # set AUTH_*, SESSION_SECRET, MERIDIAN_BASE_URL
npm run build               # build the React app
npm start                   # serves app + API + WebSocket + orchestrator on :3000
# dev: two terminals — `npm run dev` (Vite) and `npm run dev:server`
```

Without `DATABASE_URL` the server keeps state in memory (resets on restart). With it, state persists in Postgres.

### Docker (Postgres included)

```bash
docker compose up --build    # app on :3000 + a Postgres with a persistent volume
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | `admin` / `admin` | Login credentials. **Change before exposing.** |
| `SESSION_SECRET` | dev default | Signs the session cookie — use a long random string. |
| `MERIDIAN_BASE_URL` | `http://localhost:8080` | Meridian's Anthropic-compatible endpoint. |
| `MERIDIAN_API_KEY` | `meridian` | Placeholder the SDK needs; Meridian auths via your Claude session. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Heavy tier (deliverables, planning, synthesis). |
| `ANTHROPIC_FAST_MODEL` | `claude-haiku-4-5-20251001` | Light tier (routing, review, memory, AUTO demo). |
| `DEMO_MODEL` | = light tier | AUTO demo model; `""` for pure simulation. |
| `SIMULATE` | `false` | Force the no-LLM simulation. |
| `DATABASE_URL` | _(unset)_ | Postgres connection string; in-memory if unset. |
| `TICK_MS` | `1500` | Orchestrator loop interval. |
| `AUTONOMOUS` | `false` | Start with the self-running AUTO demo on. |
| `DAILY_BUDGET_USD` | `0` | Optional estimated daily spend ceiling (0 = off). |
| `PORT` | `3000` | HTTP port. |

## Deploying on Coolify

1. Create an **Application** from this repo — Coolify builds the Dockerfile.
2. Add a **Postgres** (Coolify database or managed) and set `DATABASE_URL` to its connection string.
3. Point `MERIDIAN_BASE_URL` at your Meridian service (e.g. `http://meridian:8080` if it's another service on the same project network).
4. Set `AUTH_USERNAME`, `AUTH_PASSWORD`, and a strong `SESSION_SECRET`.
5. Map the container's port 3000 and attach a domain.

## Notes

- Semantic memory uses **keyword recall** — Meridian/Claude has no embeddings endpoint, so the RAG layer degrades gracefully (no quality loss for most tasks).
- The `http_request` tool blocks private/loopback hosts (SSRF guard); set `TOOLS_ALLOW_HOSTS` to allow-list specific public hosts.
- Web-build previews render in a `sandbox="allow-scripts"` iframe — only preview output you trust.

## License

MIT — see [LICENSE](LICENSE).
