// Meridian (Claude) integration. Each worker executes its task via Claude —
// through the Meridian proxy using the Anthropic SDK — with its persona; the CTO
// reviews the deliverable and can generate fresh work. With SIMULATE=true (or no
// Meridian reachable) everything degrades to a believable simulation so the
// office still runs end-to-end.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { HEAVY_MODEL, LIGHT_MODEL, SIMULATE } from "./config.js";
import { embedText } from "./embeddings.js";
import { executeTool } from "./tools.js";
import { addEvent, recordUsage, setAgent, getAgent, bus } from "./store.js";
import { AGENT_DEFS } from "./agents.js";

// Tier aliases — the "pro"/heavy path is Sonnet; the "flash"/light path is Haiku.
const GEMINI_MODEL = HEAVY_MODEL;
const GEMINI_FLASH_MODEL = LIGHT_MODEL;
const isLight = (model) => /haiku/i.test(model || "");
// The Claude Code SDK takes a model alias; map our full ids to it.
const modelAlias = (m) => { const s = String(m || "").toLowerCase(); return s.includes("haiku") ? "haiku" : s.includes("opus") ? "opus" : "sonnet"; };

const AGENT_BY_DEPT = Object.fromEntries(AGENT_DEFS.map((a) => [a.department, a]));

// Wake an idle agent so it visibly works (its room animates) during an
// interaction (a consult, a QA pass). Returns a finish() that keeps it working
// for a minimum visible time, then returns it to idle.
function wakeAgent(agentId, label, minMs = 4500) {
  let woke = false;
  try { const a = getAgent(agentId); if (a && a.status === "idle") { setAgent(agentId, { status: "working", task: label }); woke = true; } } catch {}
  const start = Date.now();
  return () => {
    // Record activity even if the agent was busy — interacting still counts as
    // "last active just now".
    try { setAgent(agentId, { lastRunAt: Date.now() }); } catch {}
    if (!woke) return;
    const remain = Math.max(0, minMs - (Date.now() - start));
    setTimeout(() => { try { setAgent(agentId, { status: "idle", task: "standing by", lastRunAt: Date.now() }); } catch {} }, remain);
  };
}

// Talk to Claude DIRECTLY via the Claude Code SDK (query) — uses your logged-in
// Claude Code / Max session, bypassing Meridian (≈30x faster). `ai` is a presence
// flag (the SDK has no client object). SIMULATE=true disables real calls.
const ai = SIMULATE ? null : true;
const clientFor = () => ai;
export const usingGemini = !!ai;

// In-flight runs by task id, so a deleted/cancelled task can abort its LLM calls
// and the agent stops immediately instead of finishing a now-pointless build.
const aborters = new Map();
export function cancelWork(taskId) {
  const ac = aborters.get(taskId);
  if (ac) { try { ac.abort(); } catch {} return true; }
  return false;
}

function isRateLimit(msg) { return /429|rate.?limit|too many requests|overloaded|\b529\b/i.test(String(msg)); }
// Transient overload/availability blips — retry, don't fail the task.
const isTransient = (msg) => /\b5(00|02|03|29)\b|overloaded|UNAVAILABLE|high demand|try again later|INTERNAL|backend error|deadline|ECONNRESET|ETIMEDOUT|fetch failed|timed out|socket hang up/i.test(String(msg));

// A build must finish within this window in ONE attempt (timeouts aren't retried).
// This is effectively the SPEED DIAL: builds are auto-sized (EST_TPS) to fit it,
// so a shorter window = smaller, faster build that still completes; a longer one
// = bigger, slower build. 10 min ≈ a ~7-8k build in ~6 min. Override LLM_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || process.env.GEMINI_TIMEOUT_MS || 1200000);
const withTimeout = (p, ms = TIMEOUT_MS) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Meridian request timed out")), ms))]);
// Assumed generation throughput (tokens/sec), used to size requests so a build
// reliably finishes before the timeout. Conservative on purpose (Max-plan
// endpoints are slow); the fit-cap shrinks oversized builds so they COMPLETE
// rather than time out. Raise LLM_EST_TPS if your endpoint is fast.
const EST_TPS = Number(process.env.LLM_EST_TPS || 11);
// Turns the SDK agent may take. 1 is too few — Claude Code may spend a turn
// trying to use tools, leaving no text and an "max turns" error. Give it room.
const SDK_MAX_TURNS = Number(process.env.LLM_MAX_TURNS || 8);
// Force a plain text answer instead of Claude Code's default file-writing behavior.
const OUTPUT_DIRECTIVE = "\n\nOUTPUT RULES (critical): Produce your COMPLETE deliverable as TEXT in your reply right now. Do NOT use any tools, do NOT write or edit files, do NOT ask questions or stop early — output all code/markdown directly in this message.";

// Cap output tokens per tier (model limit) AND to what can be generated within
// the timeout (so a big request can't time out and loop). Sized from EST_TPS.
function clampTokens(req, model) {
  const hard = isLight(model) ? 8000 : 32000;
  const fit = Math.floor((TIMEOUT_MS / 1000) * EST_TPS * 0.7); // 30% headroom (slow/jittery endpoints)
  const cap = Math.min(hard, Math.max(1500, fit));
  return Math.max(512, Math.min(req || 4096, cap));
}
// Pull JSON out of a reply (Claude may wrap it in prose or ``` fences).
function extractJson(t) {
  let s = String(t || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith("{") && !s.startsWith("[")) { const m = s.match(/[\[{][\s\S]*[\]}]/); if (m) s = m[0]; }
  return s;
}
// Build an Anthropic user-content array from the prompt + attachments.
function userContent(prompt, media) {
  const blocks = [{ type: "text", text: prompt }];
  for (const m of media || []) {
    const mt = String(m.mimeType || "").toLowerCase();
    if (/^image\/(jpeg|png|gif|webp)$/.test(mt)) blocks.push({ type: "image", source: { type: "base64", media_type: mt, data: m.data } });
    else if (mt === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: m.data } });
    else if (/^text\//.test(mt)) { try { blocks.push({ type: "text", text: `\n\n[Attached ${mt}]\n` + Buffer.from(m.data, "base64").toString("utf8").slice(0, 60000) }); } catch {} }
  }
  return blocks;
}
const textOf = (res) => (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
const usageMeta = (res) => ({ promptTokenCount: res?.usage?.input_tokens || 0, candidatesTokenCount: res?.usage?.output_tokens || 0 });

// Stream a message and return the final Message. On TIMEOUT, abort the stream
// and SALVAGE whatever text was generated so far (a partial build still delivers
// — no error/retry loop). Re-throws a user cancellation; throws a timeout only
// when nothing usable was produced.
let partialNoticeAt = 0;
// Run a completion through the Claude Code SDK and return an Anthropic-Message-
// shaped result ({content:[{type:'text',text}], usage}) so the rest of the brain
// is unchanged. Extracts the system + user text from the Anthropic-style body.
// On timeout, aborts and salvages whatever streamed (no error/retry loop).
async function streamFinal(body, signal) {
  const system = body.system || "";
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  const prompt = Array.isArray(lastUser?.content)
    ? lastUser.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
    : String(lastUser?.content || "").trim();

  const ac = new AbortController();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", () => ac.abort(), { once: true }); }
  let timedOut = false;
  const to = setTimeout(() => { timedOut = true; try { ac.abort(); } catch {} }, TIMEOUT_MS);

  // Auth: if a Claude Code OAuth/Max token is present, make it authoritative —
  // strip any ANTHROPIC_API_KEY (a stale/placeholder one would cause a 401).
  const childEnv = { ...process.env };
  if (childEnv.CLAUDE_CODE_OAUTH_TOKEN) delete childEnv.ANTHROPIC_API_KEY;

  let partial = "", finalText = "", usage = null;
  try {
    const q = query({
      prompt,
      options: {
        model: modelAlias(body.model),
        systemPrompt: system + OUTPUT_DIRECTIVE, // string fully replaces the default prompt
        maxTurns: SDK_MAX_TURNS,     // >1 so it can finish instead of erroring on turn 1
        allowedTools: [],            // pure generation — no file/bash tools
        includePartialMessages: true, // stream deltas so we can salvage partials
        abortController: ac,
        env: childEnv,
      },
    });
    for await (const m of q) {
      if (m.type === "stream_event") {
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) partial += ev.delta.text;
      } else if (m.type === "assistant") {
        // A (possibly incremental) assistant snapshot — keep the fullest one so a
        // timeout salvage has content even if delta events aren't emitted.
        const t = (m.message?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
        if (t.length > partial.length) partial = t;
      } else if (m.type === "result") {
        if (m.subtype === "success" && typeof m.result === "string" && m.result.trim()) finalText = m.result;
        usage = m.usage || usage;
      }
    }
    const text = (finalText || partial).trim();
    return { content: [{ type: "text", text }], usage: usage ? { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 } : null };
  } catch (e) {
    if (signal?.aborted && !timedOut) throw e; // user cancelled — discard partial
    const text = (partial || finalText).trim();
    if (text.length > 400) {
      const now = Date.now();
      if (now - partialNoticeAt > 30000) { partialNoticeAt = now; try { addEvent({ kind: "system", text: "Build hit the time limit — delivering what was generated. Use Follow up to extend it." }); } catch {} }
      return { content: [{ type: "text", text }], usage: null };
    }
    if (timedOut) throw new Error("request timed out");
    throw e;
  } finally {
    clearTimeout(to);
  }
}

// Errors that mean "this tier can't serve the request right now" — rate limit,
// overload, bad model. For these we fall back from heavy (Sonnet) to light (Haiku).
const FALLBACKABLE = (msg) =>
  /429|rate.?limit|overloaded|\b5(00|02|03|29)\b|not.?found|invalid|unsupported|permission|\b40[13]\b|unauthenticated/i.test(String(msg));
const PRO_DOWN_ERR = (msg) => /429|rate.?limit|overloaded|quota/i.test(String(msg));
// Circuit breaker: once the heavy tier is rate-limited, route to the light tier
// for a while instead of re-failing every task. Auto-retries heavy later.
let proDownUntil = 0, flashDownUntil = 0;
const isProDown = () => Date.now() < proDownUntil;
const isFlashDown = () => Date.now() < flashDownUntil;
// Live model health for the UI.
export function getModelHealth() {
  return {
    pro: { name: GEMINI_MODEL, configured: !!ai, online: !!ai && !isProDown() },
    flash: { name: GEMINI_FLASH_MODEL, configured: !!ai, online: !!ai && !isFlashDown(), sharedKey: true },
    simulated: !ai,
  };
}
function emitModels() { try { bus.emit("models", getModelHealth()); } catch {} }

// Lightweight reachability probe — the orchestrator uses it to auto-resume the
// office after an LLM outage (bad token, rate limit, connection). Returns true
// if a tiny call succeeds within ~30s.
export async function pingModel() {
  if (!ai) return true; // simulation — never "down"
  try {
    await Promise.race([
      callModel("You are a health check.", "Reply with the single word: OK", { model: GEMINI_FLASH_MODEL }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ping timeout")), 30000)),
    ]);
    return true;
  } catch { return false; }
}
function markProDown() {
  if (isProDown()) return;
  proDownUntil = Date.now() + 10 * 60 * 1000; // 10 min
  console.warn(`[meridian] ${GEMINI_MODEL} rate-limited — routing to ${GEMINI_FLASH_MODEL} for 10 min`);
  try { addEvent({ kind: "system", text: `⚠️ ${GEMINI_MODEL} is rate-limited — running on ${GEMINI_FLASH_MODEL} for now.` }); } catch {}
  emitModels();
}
function markFlashDown() {
  if (isFlashDown()) return;
  flashDownUntil = Date.now() + 10 * 60 * 1000;
  console.warn(`[meridian] ${GEMINI_FLASH_MODEL} rate-limited too`);
  try { addEvent({ kind: "system", text: `⚠️ ${GEMINI_FLASH_MODEL} is also rate-limited — pausing briefly may help.` }); } catch {}
  emitModels();
}
// A tier came back (a call succeeded) — clear its down flag and notify.
function markUp(model) {
  if (isLight(model)) { if (flashDownUntil) { flashDownUntil = 0; emitModels(); } }
  else if (proDownUntil) { proDownUntil = 0; console.warn(`[meridian] ${GEMINI_MODEL} recovered`); emitModels(); }
}
let lastFallbackNote = 0;
function noteFallback(fromModel, msg) {
  console.warn(`[meridian] ${fromModel} failed (${String(msg).slice(0, 80)}) — falling back to ${GEMINI_FLASH_MODEL}`);
  const now = Date.now();
  if (now - lastFallbackNote > 60000) { // throttle the user-facing notice
    lastFallbackNote = now;
    try { addEvent({ kind: "system", text: `⚠️ ${GEMINI_MODEL} unavailable — falling back to ${GEMINI_FLASH_MODEL}.` }); } catch {}
  }
}
const canFallback = (model, msg) => !isLight(model) && !!ai && !!GEMINI_FLASH_MODEL && FALLBACKABLE(msg);

async function callModel(system, prompt, { json = false, temperature = 0.7, model, media, maxOutputTokens, signal } = {}) {
  const mdl = model || GEMINI_MODEL;
  const messages = [{ role: "user", content: userContent(prompt, media) }];
  const MAX_TRIES = 4;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      // Stream + collect the final message. On timeout, salvage the partial
      // output so a slow build still delivers instead of erroring and retrying.
      const res = await streamFinal({ model: mdl, max_tokens: clampTokens(maxOutputTokens, mdl), system, temperature, messages }, signal);
      try { recordUsage(mdl, usageMeta(res)); } catch {}
      const text = textOf(res);
      return json ? extractJson(text) : text;
    } catch (e) {
      const msg = e?.message || String(e);
      if (signal?.aborted || /abort/i.test(msg)) throw e; // cancelled — stop now, don't retry
      // Our own timeout must NEVER be retried — retrying at full duration multiplies
      // the wait (a stalled call became ~40 min). Fail it so the task re-queues.
      const timedOut = /timed out/i.test(msg);
      // Back off and retry on rate-limit / overload / transient 5xx — these clear
      // on their own; the heavy→light fallback handles harder failures.
      const retryable = !timedOut && (isTransient(msg) || isRateLimit(msg));
      if (attempt < MAX_TRIES - 1 && retryable) {
        const m = msg.match(/retry.*?([\d.]+)s/i);
        const delay = m
          ? Math.min(20000, Math.max(2000, parseFloat(m[1]) * 1000))
          : Math.min(16000, 2000 * 2 ** attempt + Math.floor(Math.random() * 1200)); // backoff + jitter
        if (attempt === 0) { try { addEvent({ kind: "system", text: `${mdl} is busy — retrying…` }); } catch {} }
        await wait(delay);
        continue;
      }
      throw e;
    }
  }
}

// Wrapper: run on the requested model; if Pro hits quota/billing/availability,
// transparently retry on Flash so work keeps flowing.
async function generate(system, prompt, opts = {}) {
  let model = opts.model || GEMINI_MODEL;
  // Circuit breaker: if the heavy tier is rate-limited, go straight to light.
  if (!isLight(model) && isProDown()) model = GEMINI_FLASH_MODEL;
  try {
    const r = await callModel(system, prompt, { ...opts, model });
    markUp(model);
    return r;
  } catch (e) {
    const msg = e?.message || String(e);
    if (canFallback(model, msg)) {
      if (!isLight(model) && PRO_DOWN_ERR(msg)) markProDown();
      noteFallback(model, msg);
      try { const r = await callModel(system, prompt, { ...opts, model: GEMINI_FLASH_MODEL }); markUp(GEMINI_FLASH_MODEL); return r; }
      catch (e2) { if (PRO_DOWN_ERR(e2?.message || "")) markFlashDown(); throw e2; }
    }
    throw e;
  }
}

// Tool-use loop: lets an agent call tools (e.g. http_request to test an API),
// feeding results back until it produces the final deliverable.
async function toolLoop(system, prompt, { model, media, tools, toolCtx, maxOutputTokens, signal }) {
  const mdl = model || GEMINI_MODEL;
  const max_tokens = clampTokens(maxOutputTokens, mdl);
  const messages = [{ role: "user", content: userContent(prompt, media) }];
  for (let step = 0; step < 8; step++) {
    if (signal?.aborted) throw new Error("aborted");
    const res = await streamFinal({ model: mdl, max_tokens, system, temperature: 0.5, tools, messages }, signal);
    try { recordUsage(mdl, usageMeta(res)); } catch {}
    const toolUses = (res.content || []).filter((b) => b.type === "tool_use");
    if (!toolUses.length) return textOf(res);
    messages.push({ role: "assistant", content: res.content });
    const results = [];
    for (const tu of toolUses) {
      const result = await executeTool(tu.name, tu.input || {}, toolCtx);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    messages.push({ role: "user", content: results });
  }
  messages.push({ role: "user", content: "Wrap up now and produce the final deliverable from what you gathered." });
  const final = await streamFinal({ model: mdl, max_tokens, system, messages }, signal);
  try { recordUsage(mdl, usageMeta(final)); } catch {}
  return textOf(final);
}

// Same heavy->light fallback (+ circuit breaker) for the tool-using path.
async function generateWithTools(system, prompt, opts = {}) {
  let model = opts.model || GEMINI_MODEL;
  if (!isLight(model) && isProDown()) model = GEMINI_FLASH_MODEL;
  try {
    const r = await toolLoop(system, prompt, { ...opts, model });
    markUp(model);
    return r;
  } catch (e) {
    const msg = e?.message || String(e);
    if (canFallback(model, msg)) {
      if (!isLight(model) && PRO_DOWN_ERR(msg)) markProDown();
      noteFallback(model, msg);
      try { const r = await toolLoop(system, prompt, { ...opts, model: GEMINI_FLASH_MODEL }); markUp(GEMINI_FLASH_MODEL); return r; }
      catch (e2) { if (PRO_DOWN_ERR(e2?.message || "")) markFlashDown(); throw e2; }
    }
    throw e;
  }
}

// Handoff: one agent consults another department's specialist mid-task and gets
// a concise answer to fold into its own deliverable.
export async function consultAgent(department, question, model = null) {
  const def = AGENT_BY_DEPT[department];
  if (!ai || !model) return `(${def?.name || department} is unavailable; proceeding without their input.)`;
  const persona = def?.persona || "You are a helpful specialist.";
  // Wake the consulted agent so it visibly works while answering.
  const done = def ? wakeAgent(def.id, `helping: ${String(question).slice(0, 36)}`) : () => {};
  try {
    return await generate(
      `${persona} A teammate has asked for your expert input on their task. Answer concisely and practically — a few sentences or a short list — focused on exactly what they need. No preamble.`,
      String(question || "").slice(0, 4000),
      { model, temperature: 0.4 }
    );
  } catch (e) {
    return `(${def?.name || department} couldn't respond: ${e.message})`;
  } finally {
    done();
  }
}

// Semantic memory (RAG): embed text with a local model (Transformers.js) — no
// API/network needed. Returns a 384-dim vector, or null on failure (callers then
// fall back to keyword recall). This is what powers cross-task learning.
export async function embed(text) {
  return embedText(text);
}

// A guaranteed-correct screen-transition + animation foundation. Agents kept
// re-writing this and introducing bugs (stale state, no-op transitions). Mandate
// it verbatim so transitions/animations ALWAYS work; the agent builds on top.
const WEB_FOUNDATION =
  "REQUIRED FOUNDATION — copy this EXACT transition & animation system VERBATIM (do not rewrite or omit any of it) and build your screens on top. It guarantees smooth, professional transitions and entrance animations:\n" +
  "/* styles.css */\n" +
  ".screen{position:absolute;inset:0;display:flex;flex-direction:column;opacity:0;pointer-events:none;transform:translateX(24px);transition:opacity .38s cubic-bezier(.32,.72,0,1),transform .38s cubic-bezier(.32,.72,0,1)}\n" +
  ".screen.active{opacity:1;pointer-events:auto;transform:none;z-index:2}\n" +
  ".screen.exiting{opacity:0;transform:translateX(-24px);z-index:1}\n" +
  "@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}\n" +
  ".screen.active .stagger>*{opacity:0;animation:fadeUp .5s forwards}\n" +
  ".screen.active .stagger>*:nth-child(1){animation-delay:.04s}.screen.active .stagger>*:nth-child(2){animation-delay:.1s}.screen.active .stagger>*:nth-child(3){animation-delay:.16s}.screen.active .stagger>*:nth-child(4){animation-delay:.22s}.screen.active .stagger>*:nth-child(5){animation-delay:.28s}.screen.active .stagger>*:nth-child(6){animation-delay:.34s}\n" +
  "button,.pressable{transition:transform .12s ease}button:active,.pressable:active{transform:scale(.96)}\n" +
  "/* app.js */\n" +
  "function navigateTo(id){const cur=document.querySelector('.screen.active'),next=document.getElementById(id);if(!next||cur===next)return;if(cur){cur.classList.add('exiting');cur.classList.remove('active');setTimeout(()=>cur.classList.remove('exiting'),420);}next.classList.add('active');window.scrollTo(0,0);const nx=next.getAttribute('data-next');if(nx){setTimeout(()=>navigateTo(nx),parseInt(next.getAttribute('data-delay'),10)||1800);}}\n" +
  "document.addEventListener('click',e=>{const t=e.target.closest('[data-nav]');if(t){e.preventDefault();navigateTo(t.getAttribute('data-nav'));}});\n" +
  "function _armInitial(){const s=document.querySelector('.screen.active'),nx=s&&s.getAttribute('data-next');if(nx)setTimeout(()=>navigateTo(nx),parseInt(s.getAttribute('data-delay'),10)||1800);}\n" +
  "if(document.readyState!=='loading')_armInitial();else document.addEventListener('DOMContentLoaded',_armInitial);\n" +
  "RULES: every screen is <div class=\"screen\" id=\"screen-...\">; EXACTLY ONE starts with class=\"screen active\". Wrap each screen's content in <div class=\"stagger\">. Navigate ONLY via data-nav=\"screen-target\" on buttons (already wired — never write your own broken navigation).\n" +
  "CRITICAL — NO DEAD ENDS: EVERY screen must have a way forward. For a loading / verifying / processing / splash screen (no button), add data-next=\"screen-target\" (and optional data-delay=\"ms\", default 1800) to the screen div — it AUTO-ADVANCES (handled above). So a 'Verifying your details…' screen MUST be <div class=\"screen\" id=\"screen-verifying\" data-next=\"screen-verified\" data-delay=\"2200\">. Never leave a screen the user can get stuck on.\n" +
  "On TOP of this, add polish keyframes: an animated success checkmark on activation, a card reveal/flip, skeleton loaders, a balance count-up. Keep the foundation intact.";

const SIM = {
  observatory: ["scan the data streams", "chart the latest signals", "log the night readings"],
  security: ["sweep the perimeter", "audit the access logs", "run a vulnerability pass"],
  research_lab: ["draft the weekly brief", "summarize the findings", "polish the report"],
  development: ["refactor the module", "fix the failing build", "prototype the feature"],
  admin: ["index the records", "back up the archive", "reconcile the ledgers"],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const DESIGN_BAR =
  "DESIGN BAR — match top fintech apps (Revolut / Wise / Monzo). A static, rough, or incomplete result FAILS the bar.\n" +
  "- VISUAL: deliberate colour palette, gradients, soft shadows, generous spacing, clear type hierarchy, rounded corners, consistent inline-SVG/emoji icons. No overlapping/clipped text — check every label fits.\n" +
  "- ANIMATION & TRANSITIONS (REQUIRED — not optional): animated screen-to-screen transitions (slide or fade) as the user moves through the flow; button press feedback (scale/opacity); input focus styles; staggered entrance animations for cards & list items; an animated success checkmark on completion/activation; a card reveal on activation; loading/skeleton states where data 'loads'; and smooth value changes (e.g. balance count-up). Drive them with CSS transitions/keyframes + a little JS. It must feel alive and fluid, NOT a static screenshot.\n" +
  "- MOBILE: the app IS the mobile screen — it fills the viewport (responsive, safe-area padding) and looks like the real running app on a phone. NO decorative phone/device frame, bezel, notch, or fake status bar. (On wide desktop you MAY centre it in a plain mobile-width column ~430px, with no device chrome.)\n" +
  "- REALISTIC CARD: gradient background; a gold EMV chip drawn as a small rounded rect with 3-4 thin contact lines (NOT a plain block); a contactless/wifi glyph; the card number as masked dots grouped in 4s ending with 4 real digits; CARD HOLDER name; EXPIRES mm/yy; and the network mark rendered as CLEAN STYLED TEXT — e.g. a bold italic 'VISA' in a sans-serif with letter-spacing — do NOT hand-draw the Visa/Mastercard logo as a complex SVG (it comes out garbled and overlapping). Card aspect ratio ~1.586:1.\n" +
  "- COMPLETE FLOW: build EVERY screen the task implies, in full, with real working navigation between them — do NOT stop after the home/dashboard screen. If the task lists steps (welcome → sign-up/OTP → KYC identity verification → account & currency (SGD/USD) setup → card application → CARD ACTIVATION (show the card + an Activate action + success animation) → set PIN → WALLET DASHBOARD → top-up), implement EACH as its own screen. Never skip the activation, success, or dashboard screens. No broken image links — inline SVG, CSS gradients, or emoji only.\n" +
  "- WALLET DASHBOARD (the destination after onboarding): show the multi-currency balances and the Visa card, recent transactions, and quick actions (top-up, send). Put an EYE toggle on the card that reveals/masks the card number — when tapped it reveals the FIRST group of digits (e.g. 4921 •••• •••• 3087) and hides them again on a second tap. Animate the reveal.";
// Default sized to COMPLETE reliably in one shot (~4-6 min). Bigger caps produce
// richer builds but can exceed the request timeout on slower endpoints and never
// finish — raise only if your endpoint is fast, and prefer iterating via Follow-up.
const BUILD_MAX_TOKENS = Number(process.env.BUILD_MAX_TOKENS || 14000);
// Balanced: keep Scout's single QA pass but skip the costly Orbit fix-rebuild.
// Set BUILD_QA_FIX=true to also auto-fix flagged issues (slower, max quality).
const BUILD_QA_FIX = process.env.BUILD_QA_FIX === "true";
// Quality: number of build passes. 1 = single shot; 2-3 = iteratively enhance the
// build toward a flagship standard (slower, much richer). Set BUILD_PASSES=2+.
const BUILD_PASSES = Math.max(1, Number(process.env.BUILD_PASSES || 1));
// The gap between a 2-3 screen sample and a real product. Be exhaustive.
const CRAFT_BAR =
  "SCALE & COMPLETENESS: a real onboarding/banking flow is 12-20+ distinct screens AND each screen is RICH (a shipping app averages 300-500 lines per screen, not 70). Build the ENTIRE journey end to end — every step plus its empty / loading / success / error states. And make every screen DENSE and real: proper headers, sub-copy, multiple components, realistic data, states and details — NOT a sparse placeholder with one heading and a button. Write ALL the code; never stop early, summarise, or leave '...'. If you're running long, keep going — depth and completeness beat brevity.\n" +
  "CRAFT (what separates pro from generic):\n" +
  "- Design tokens in :root: a DISTINCTIVE brand identity (NOT generic default blue — choose a real palette), a characterful display font for headings (e.g. a serif like Fraunces, or a strong sans) + Inter for body via a Google Fonts <link>, a shadow scale (sm/md/lg), a consistent radius.\n" +
  "- Real motion on EVERY screen change: transitions with iOS/spring easings such as cubic-bezier(0.32,0.72,0,1) and cubic-bezier(0.34,1.56,0.64,1); staggered fade-up entrances on content; animated success checkmarks; progress bars between steps; skeletons while 'loading'.\n" +
  "- Considered layout: comfortable spacing, aligned grids, thumb-friendly targets. Use normal flow / flex / grid — do NOT absolutely-position banners or labels on top of cards or other content (that bug — e.g. a 'Tap to activate' strip overlapping the card — is unacceptable). Verify NOTHING overlaps or clips: every label fits its box, each element has its own space.";
// Focused-flow mode: build the core 6-8 screens fast (then extend via Follow-up),
// instead of the exhaustive 12-20+ screen build. Toggle with BUILD_SCOPE=focused.
// Default to FOCUSED: at ~56 tok/s a full 12-20 screen build can exceed the
// timeout and never finish. Focused builds the core 6-8 screens, completes in a
// few minutes, and you extend with Follow-up. Set BUILD_SCOPE=full to opt back in.
const BUILD_SCOPE = String(process.env.BUILD_SCOPE || "focused").toLowerCase();
const CRAFT_FOCUSED =
  "SCOPE (HARD LIMIT): Build the 6-8 MOST IMPORTANT screens ONLY — even if the task lists more steps, do NOT attempt all of them in this build. Pick the core end-to-end flow (e.g. welcome → sign-up/OTP → KYC → card application → activation + animated success → wallet DASHBOARD with the card eye-toggle) and STOP at ~8 screens. The user will request the rest via follow-up. Building too many screens makes the build run long and fail — staying within 6-8 lets it FINISH completely. Each screen must still be RICH and real (proper header, sub-copy, components, realistic data, empty/loading/success states) — NOT a sparse placeholder. Write ALL the code for these screens, no '...'.\n" +
  "CRAFT (what separates pro from generic):\n" +
  "- Design tokens in :root: a DISTINCTIVE brand identity (NOT generic default blue), a characterful display font for headings + Inter for body via a Google Fonts <link>, a shadow scale, a consistent radius.\n" +
  "- Real motion on every screen change: transitions with iOS/spring easings (cubic-bezier(0.32,0.72,0,1)); staggered fade-up entrances; an animated success checkmark; skeletons while 'loading'.\n" +
  "- Considered layout: comfortable spacing, thumb-friendly targets, NOTHING overlapping or clipping (no banners absolutely-positioned over cards).";
const activeCraftBar = () => (BUILD_SCOPE === "focused" ? CRAFT_FOCUSED : CRAFT_BAR);
const ENG_MULTI =
  "ENGINEERING: Write the FULL project — every file complete, no placeholders, no \"...\". Split into PROPER, separate files (do NOT cram everything into one file). Output EACH file as a marker line \"===== FILE: relative/path.ext =====\" immediately followed by its fenced code block, so it packages into a downloadable .zip with the correct folder structure. Every import / link / href / src / path MUST use the exact file names and resolve. Include a README.md with exact run instructions. Keep prose to a one-line intro; the deliverable is the project.";
// CSS framework CDNs are a footgun for generated code (URL typos like
// 'httpss://', undefined utility classes) and the best hand-built results don't
// use them. Mandate hand-written CSS with design tokens.
const STYLING_RULES =
  "STYLING — write REAL, hand-crafted CSS. This is non-negotiable and is how the best results are built:\n" +
  "- DO NOT use the Tailwind CDN or any CSS-framework CDN (cdn.tailwindcss.com, bootstrap, etc.). They cause broken output here — URL typos and undefined utility classes leave the page unstyled. Do NOT use Tailwind utility classes at all.\n" +
  "- Put your ENTIRE design system in css/styles.css: design tokens in :root (a distinctive colour palette, a display font + body font, spacing, radius, a shadow scale), then real semantic classes (.btn, .card, .screen, .input, .chip, etc.). Reference tokens with var(--x).\n" +
  "- Load fonts with a Google Fonts <link> in <head> — and double-check the URL is EXACTLY https:// (no typos like httpss://). It's the only external resource.\n" +
  "- EVERY class used in the HTML must be defined in your styles.css. No undefined classes, no framework utilities. Self-check before finishing: would this render fully styled with zero network/CDN dependencies besides the font link? It must.";

// Non-app artifacts Development produces best as a single self-contained file —
// each with its own brief instead of the multi-screen app design bar.
function detectArtifact(text) {
  const s = String(text).toLowerCase();
  if (/\b(logo|app icon|favicon|brand ?mark|wordmark|icon set|brand identity)\b/.test(s)) return "logo";
  if (/\b(invoice|receipt|quotation|\bquote\b|billing statement|purchase order)\b/.test(s)) return "invoice";
  if (/\b(presentation|power ?point|\bpptx?\b|slide ?deck|\bslides\b|pitch ?deck|\bdeck\b)\b/.test(s)) return "deck";
  if (/\b(landing page|marketing (page|site|mockup)|one[- ]?pager|hero section|sales page)\b/.test(s)) return "marketing";
  return null;
}
function artifactSystem(kind, persona) {
  const tail = ' Output it as "===== FILE: index.html =====" then a fenced code block. One-line intro only — no other prose.';
  const base = `${persona}\n\nDeliver ONE self-contained index.html: hand-written inline CSS with design tokens in :root, inline JS, and a single Google Fonts <link> only — NO Tailwind or any CDN. Distinctive, modern, production-grade craft; nothing overlapping or clipped.`;
  const briefs = {
    logo: "\n\nTASK: design a distinctive, professional LOGO. Show the primary logo as clean, scalable INLINE SVG, plus a monochrome variant, an app-icon/favicon (rounded square), and the mark on light AND dark backgrounds. Balanced geometry, a considered palette, memorable — not generic clip-art. Include the raw <svg> so it can be copied out.",
    invoice: "\n\nTASK: produce a PRINT-READY INVOICE (A4, @media print friendly). Branded header, company & client blocks, invoice number / issue & due dates, a line-items table (description, qty, unit price, amount), subtotal, tax/GST, total, payment terms and bank details. Use realistic data drawn from the task.",
    deck: "\n\nTASK: produce a PRESENTATION — one <section> per slide with keyboard arrow-key navigation: a title slide, agenda, 8–12 content slides with REAL structured content from the task, and a closing slide. Consistent layout, strong hierarchy, subtle slide transitions.",
    marketing: "\n\nTASK: build a polished MARKETING landing page: hero (headline / sub / CTA), feature sections, social proof, pricing or a final CTA, and a footer. Strong visual hierarchy, responsive, subtle entrance animations.",
  };
  return base + (briefs[kind] || "") + tail;
}
const STACK_GUIDE = {
  django: "Stack: Django (Python). Deliver manage.py, the project package (settings.py with INSTALLED_APPS, urls.py, wsgi.py), app(s) with models.py / views.py / urls.py / admin.py, templates/ and static/ (css, js) for the UI, requirements.txt, and README.md (venv, pip install, migrate, runserver).",
  node: "Stack: Node.js. Deliver package.json (scripts + deps), an Express or Fastify server, routes, and a front-end (server-rendered views or a public/ folder with separate html/css/js), plus README.md (npm install, npm start).",
  flutter: "Stack: Flutter (Dart), Material 3. Deliver pubspec.yaml, lib/main.dart, and lib/ split into screens & widgets, plus README.md (flutter pub get, flutter run).",
  react: "Stack: React + Vite. Deliver package.json, index.html, vite.config.js, src/main.jsx, src/App.jsx and components in separate files, styling via plain CSS / CSS modules (no Tailwind CDN), plus README.md (npm install, npm run dev).",
  "react-native": "Stack: React Native (Expo) + React Navigation. Deliver package.json, App.js, and screens/components in separate files, plus README.md (npm install, npx expo start).",
};

// Independent QA: SCOUT tests a build it did NOT write (fresh eyes catch what the
// author misses), reports concrete bugs, then ORBIT fixes them. Covers any stack.
async function qaTestBuild(build, task, model, signal) {
  if (!ai || !model || !build) return { clean: true, bugs: [] };
  try {
    const txt = await generate(
      "You are SCOUT doing INDEPENDENT QA on a build a teammate produced — you did NOT write it, so review it CRITICALLY with fresh eyes and try hard to break it. Find concrete BUGS across LOGIC and UX/UI (any stack — web, mobile, or backend):\n" +
        "- INTENT MISMATCH: a behaviour the task asks for that doesn't actually work (e.g. tapping a card should FLIP it but it only shows an 'activated' label; an Activate button that doesn't change the card; an endpoint that doesn't return what it should).\n" +
        "- LOGIC errors: wrong control flow, state, calculations, validation, edge cases.\n" +
        "- DEAD-END / STUCK SCREENS: a screen the user can't get past — e.g. a 'Verifying…'/loading/processing/splash screen that never advances (no auto-advance timer and no button), or a button that goes nowhere. EVERY screen must have a way forward; this is a top-severity bug.\n" +
        "- DEAD/UNWIRED controls, broken navigation/routes, unreachable screens.\n" +
        "- STATE that doesn't update after an action.\n" +
        "- UX/UI defects: OVERFLOWING or clipped content, overlapping elements, broken/unresponsive layout, poor contrast/spacing.\n" +
        "- Code that errors or silently does nothing (mismatched selectors/IDs/imports/paths).\n" +
        "Be specific — name the screen/element/function. Respond ONLY as JSON: {\"clean\": boolean, \"bugs\": [\"specific bug to fix\"]} (max 10, most severe first; clean=true ONLY if you genuinely find none).",
      `TASK: ${task.title}\nDETAILS: ${task.prompt}\n\nBUILD TO TEST:\n${String(build).slice(0, 60000)}`,
      { model, json: true, temperature: 0.2, signal }
    );
    const p = JSON.parse(txt);
    const bugs = Array.isArray(p.bugs) ? p.bugs.map((b) => String(b).slice(0, 240)).filter(Boolean).slice(0, 10) : [];
    return { clean: !!p.clean && !bugs.length, bugs };
  } catch {
    return { clean: true, bugs: [] };
  }
}

async function qaAndFixBuild(build, task, model, signal) {
  if (!ai || !model || !build || build.length < 200) return build;
  // On Flash free-tier (Pro out of credits), skip the extra QA round-trips so the
  // build itself completes without exhausting the per-minute quota.
  if (isProDown()) return build;
  // Show Scout actively QA-testing (its room scans) for a visible minimum.
  const scoutDone = wakeAgent("scout", `QA-testing ${task.title}`, 6000);
  try { addEvent({ kind: "review", text: `Scout is QA-testing "${task.title}"…`, taskId: task.id, agentId: "scout" }); } catch {}
  const qa = await qaTestBuild(build, task, model, signal);
  scoutDone();
  if (qa.clean || !qa.bugs.length) {
    try { addEvent({ kind: "system", text: `Scout QA: "${task.title}" passed — no bugs found.`, taskId: task.id, agentId: "scout" }); } catch {}
    return build;
  }
  // Balanced: surface Scout's findings but don't trigger the expensive rebuild.
  if (!BUILD_QA_FIX) {
    try { addEvent({ kind: "review", text: `Scout's QA noted ${qa.bugs.length} item(s) on "${task.title}": ${qa.bugs.slice(0, 3).join("; ")}${qa.bugs.length > 3 ? "…" : ""}`, taskId: task.id, agentId: "scout" }); } catch {}
    return build;
  }
  try { addEvent({ kind: "redo", text: `Scout's QA found ${qa.bugs.length} issue(s) in "${task.title}" — Orbit is fixing…`, taskId: task.id, agentId: task.assignedTo || "orbit" }); } catch {}
  try {
    const fixed = await generate(
      "You are ORBIT. Independent QA (Scout) tested your build and found the bugs below. FIX EVERY ONE and return the COMPLETE corrected project (same \"===== FILE: path =====\" markers, full files) — keep whatever already works, do not shorten the project. " +
        "For any stuck loading/verifying screen, make it AUTO-ADVANCE: add data-next=\"screen-target\" (optional data-delay=\"ms\") to that screen div, or a setTimeout(()=>navigateTo('screen-target'),1800). Ensure every screen has a way forward.\n\nBUGS TO FIX:\n- " + qa.bugs.join("\n- "),
      `TASK: ${task.title}\nDETAILS: ${task.prompt}\n\nYOUR BUILD:\n${String(build).slice(0, 60000)}`,
      { model, maxOutputTokens: BUILD_MAX_TOKENS, temperature: 0.3, signal }
    );
    return fixed && fixed.length > build.length * 0.6 ? fixed : build;
  } catch {
    return build;
  }
}

// Quality passes: take the build and iteratively RAISE it to a flagship standard.
// Each pass keeps what works and deepens it; we only accept a pass that doesn't
// shrink the result (guards against truncation/regressions).
async function enhanceBuild(build, task, model, system, signal) {
  if (!ai || !model || !build || BUILD_PASSES <= 1) return build;
  let cur = build;
  for (let i = 1; i < BUILD_PASSES; i++) {
    try { addEvent({ kind: "system", text: `Orbit is polishing "${task.title}" (pass ${i + 1}/${BUILD_PASSES})…`, taskId: task.id, agentId: task.assignedTo || "orbit" }); } catch {}
    try {
      const better = await generate(
        `${system}\n\nThis is a POLISH pass. Below is the current build. RAISE it to a flagship, production-grade standard — the calibre of a real shipped fintech app (Revolut / Wise / Monzo). KEEP everything that already works, then: (1) complete any MISSING screens of the full flow; (2) make every screen denser and more refined (real components, copy, empty/loading/success states, micro-interactions, spacing & typography); (3) ensure the wallet DASHBOARD shows the balances + card with an eye-toggle that reveals the first group of the card number; (4) smooth every transition/animation. Return the COMPLETE updated file(s) — same "===== FILE: path =====" markers, full code, no "..." and no truncation. Do NOT shorten it.`,
        `TASK: ${task.title}\n\nDETAILS:\n${task.prompt}\n\nCURRENT BUILD:\n${String(cur).slice(0, 120000)}`,
        { model, maxOutputTokens: BUILD_MAX_TOKENS, temperature: 0.4, signal }
      );
      if (better && better.length > cur.length * 0.85) cur = better;
    } catch { /* keep current on failure */ }
  }
  return cur;
}
// Build finishing: enhance (quality passes) then independent QA.
async function finishBuild(out, task, model, system, signal) {
  const enhanced = await enhanceBuild(out, task, model, system, signal);
  return (await qaAndFixBuild(enhanced, task, model, signal)) || `Done: ${task.title}.`;
}

/* Worker performs the task, building on the department's memory.
   model=null (or no key) => simulated path: no API call, no cost. */
export async function runWork(agent, task, memoryText = "", model = null, priorWork = null, media = [], tools = null, toolCtx = null, upstream = [], build = null, attachedProjects = []) {
  if (!ai || !model) {
    await wait(1200 + Math.random() * 1800);
    return !model
      ? `Demo task — ${task.title}.\n\n(Visual demo only; no model call was made.)`
      : `Done: ${task.title}.\n\n(Simulated — connect Meridian and unset SIMULATE for real work.)`;
  }
  // Throws on API error — the orchestrator turns that into a blocked task +
  // an Issue (it must NOT become a "done" deliverable).
  const memBlock = memoryText
    ? `\n\nNOTES FROM EARLIER WORK (build on these, continue and add to them, don't repeat):\n${memoryText}`
    : "";
  const priorBlock = priorWork
    ? `\n\nPREVIOUS DELIVERABLE — you are REVISING this EXISTING project, not starting over. Keep everything that already works, apply the requested change, and return the COMPLETE updated project: EVERY file, each with its "===== FILE: path =====" marker, INCLUDING files you did not change. Do NOT drop files and do NOT collapse a multi-file project into a single file. The result must be at least as complete as this one:\n${String(priorWork).slice(-120000)}`
    : "";
  // On a re-do, the CTO's review note lists the specific gaps to fix.
  const fixBlock = priorWork && task.reviewNotes && task.reviewNotes !== "follow-up requested"
    ? `\n\nThe previous attempt was sent back. FIX THESE GAPS specifically and return the COMPLETE corrected deliverable: ${task.reviewNotes}`
    : "";
  const upstreamBlock = upstream && upstream.length
    ? `\n\nUPSTREAM RESULTS — completed earlier steps you must build on (don't repeat them, continue from them):\n` +
      upstream.map((u) => `### ${u.title}\n${String(u.result).slice(0, 6000)}`).join("\n\n")
    : "";
  const isBuild = agent.department === "development";
  const projectBlock = attachedProjects && attachedProjects.length
    ? `\n\nThe user UPLOADED a project (.zip) for this task — its files are below. Use them as instructed: review/improve them, build on them, or treat them as the BENCHMARK to match or exceed.\n\n${attachedProjects.join("\n\n").slice(0, 60000)}`
    : "";
  const fileBlock = media && media.length
    ? `\n\nThe user ATTACHED ${media.length} file(s) below — read/analyze them and use them to complete the task.` +
      (isBuild ? ` IMPORTANT: if any attachment is a DESIGN REFERENCE (a screenshot, mockup, or an HTML/CSS file), treat it as the QUALITY BAR and STYLE GUIDE — study its palette, typography, spacing, components, motion and overall polish, and MATCH or EXCEED it. Reproduce that calibre of craft (don't invent a more generic look).` : "")
    : "";
  const docSystem =
    `${agent.persona} Write a clear, well-structured deliverable in Markdown. Start with a "# Title" heading, then a short intro. Use ## / ### section headings, and a dedicated subsection per item (e.g. one per company/option) covering its details. When comparing things, include a Markdown table. Be thorough and specific, not terse. ` +
    `IMPORTANT: You output the DOCUMENT CONTENT as Markdown — the app converts it to a downloadable Word (.doc) file automatically, so if the task asks for a "doc"/"Word"/"PDF", just write the well-formatted Markdown content. Never say you cannot create files or attach a document. ` +
    `No preamble like "Here is" — start directly with the title heading.`;
  let system = docSystem;
  if (isBuild) {
    const artifact = detectArtifact(`${task.title} ${task.prompt}`);
    const singleRequested = /\b(single|one)[-\s]?(file|html|page)\b|self-?contained|inline (everything|all|css)/i.test(`${task.title} ${task.prompt}`);
    const webStack = new Set(["static", "node", "react", "django"]);
    const isMultiScreenWeb = /onboard|sign[- ]?up|\bapply\b|application|activat|\bkyc\b|\bflow\b|\bsteps?\b|wallet|top[- ]?up|screens?|journey|app\b/i.test(`${task.title} ${task.prompt}`);
    if (artifact) {
      // Logo / invoice / presentation / marketing — a tailored single-file brief.
      system = artifactSystem(artifact, agent.persona);
    } else if (build && build.type === "app") {
      // Full app/platform in the stack Jay Jay recommended — multi-file project.
      const rules = webStack.has(build.stack) ? `\n\n${STYLING_RULES}` : "";
      const foundation = (build.stack === "static" || build.stack === "node") && isMultiScreenWeb ? `\n\n${WEB_FOUNDATION}` : "";
      system = `${agent.persona}\n\nBuild a COMPLETE, RUNNABLE project — production quality, not a prototype.\n${STACK_GUIDE[build.stack] || STACK_GUIDE.node}\n\n${DESIGN_BAR}${rules}\n\n${activeCraftBar()}${foundation}\n\n${ENG_MULTI}`;
    } else if (singleRequested) {
      // Only when the user explicitly asked for a single file.
      const foundation = isMultiScreenWeb ? `\n\n${WEB_FOUNDATION}` : "";
      system = `${agent.persona}\n\nBuild a COMPLETE, WORKING, BEAUTIFUL front-end — production quality, not a prototype.\n\n${DESIGN_BAR}\n\n${activeCraftBar()}\n\n${STYLING_RULES}${foundation}\n\nENGINEERING: The user asked for a SINGLE file — deliver one self-contained index.html with ALL CSS in an inline <style> (design tokens in :root) and ALL JS in an inline <script>. NO Tailwind/CDN. Full code, no placeholders, no "...". Output it as "===== FILE: index.html =====" then its fenced code block. One-line intro only.`;
    } else {
      // DEFAULT: a proper MULTI-FILE project — the expected "download the zip"
      // output. index.html is written FIRST and mandatory so a long build can
      // never drop the entry file; focused scope (6-8 screens) keeps it complete.
      const foundation = isMultiScreenWeb ? `\n\n${WEB_FOUNDATION}` : "";
      system = `${agent.persona}\n\nBuild a COMPLETE, WORKING, BEAUTIFUL front-end — production quality, not a prototype.\n\n${DESIGN_BAR}\n\n${activeCraftBar()}\n\n${STYLING_RULES}${foundation}\n\nENGINEERING: Build a PROPER MULTI-FILE web project. WRITE index.html FIRST — a complete entry point is MANDATORY, never omit or truncate it — then css/styles.css, js/app.js, and manifest.json for the PWA. Link css/styles.css and js/app.js with their exact paths. ${ENG_MULTI}`;
    }
  }
  const userPrompt = `TASK: ${task.title}\n\nDETAILS:\n${task.prompt}${memBlock}${priorBlock}${fixBlock}${upstreamBlock}${projectBlock}${fileBlock}`;

  // Register an aborter so deleting/cancelling the task stops its LLM calls.
  const ac = new AbortController();
  aborters.set(task.id, ac);
  const signal = ac.signal;
  try {
    if (tools && toolCtx) {
      const toolNote = agent.department === "development"
        ? "\n\nTools: request_help (consult another department), http_request (actually call an API to test it — use {{NAME}} placeholders for secrets), request_credentials (ask the human for sandbox keys). Actually run tests with http_request and report real responses; if you lack a credential, call request_credentials. Use request_help when another department's expertise would improve the result."
        : "\n\nTool: request_help — consult another department's specialist when their expertise would genuinely improve your deliverable (e.g. ask Observatory to research something, Development to sanity-check code, Security for a risk check). Use it sparingly, then fold their answer into your work.";
      const out = await generateWithTools(system + toolNote, userPrompt, { model, media, tools, toolCtx, maxOutputTokens: isBuild ? BUILD_MAX_TOKENS : undefined, signal });
      return (isBuild ? await finishBuild(out, task, model, system, signal) : out) || `Done: ${task.title}.`;
    }
    const out = await generate(system, userPrompt, { model, media, maxOutputTokens: isBuild ? BUILD_MAX_TOKENS : undefined, signal });
    return (isBuild ? await finishBuild(out, task, model, system, signal) : out) || `Done: ${task.title}.`;
  } finally {
    aborters.delete(task.id);
  }
}

/* Router: pick the single best department for a task (so "Any" goes to the
   right specialist, not whoever is idle first). Flash classifier + keyword fallback. */
const DEPT_KEYWORDS = {
  development: ["code", "app", "api", "build", "website", "web app", "script", "program", "bug", "deploy", "frontend", "backend", "html", "python", "react", "flutter", "sql", "function", "feature", "prototype", "software", "endpoint", "library", "logo", "icon", "favicon", "invoice", "receipt", "quotation", "presentation", "powerpoint", "slides", "slide deck", "deck", "mockup", "wireframe", "landing page", "marketing page", "design", "dashboard", "integration", "integrate", "webhook", "sdk", "oauth", "widget"],
  research_lab: ["research", "report", "summary", "summarize", "brief", "write", "article", "analysis", "analyse", "analyze", "compare", "study", "document", "draft", "content", "blog", "whitepaper", "essay", "plan", "proposal", "scope", "job scope", "statement of work", "memo", "update", "minutes", "documentation", "guide", "manual", "policy", "faq", "specification", "requirements"],
  observatory: ["find", "scan", "monitor", "investigate", "trends", "market", "competitor", "signal", "track", "watch", "discover", "explore", "intelligence", "landscape", "list of", "who are"],
  security: ["security", "vulnerability", "audit", "risk", "compliance", "pentest", "threat", "secure", "privacy", "pdpa", "mas", "encrypt", "exposure", "breach", "hardening"],
  admin: ["organize", "organise", "index", "record", "archive", "reconcile", "ledger", "catalog", "spreadsheet", "inventory", "sort", "categorize", "clean up", "format the data"],
};
export function keywordDept(text) {
  const low = String(text).toLowerCase();
  let best = null, bestScore = 0;
  for (const [d, kws] of Object.entries(DEPT_KEYWORDS)) {
    const score = kws.reduce((s, k) => s + (low.includes(k) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return bestScore > 0 ? best : null;
}
export async function classifyDepartment(task, model = null) {
  const text = `${task.title}\n${task.prompt || ""}`;
  if (ai && model) {
    try {
      const txt = await generate(
        "Route this task to the single best department. Reply with ONLY one of these words: observatory (research, monitoring, finding/discovering things), research_lab (writing & analysis: reports, proposals, job scopes, documents, updates, summaries incl. reading & summarizing API docs), development (code, apps, APIs, integrations, AND visual artifacts: logos, icons, invoices, presentations/slides, marketing pages, UI mockups), security (security, compliance, risk), admin (organizing, records, structured data).",
        text.slice(0, 1500),
        { model, temperature: 0 }
      );
      const d = String(txt || "").toLowerCase().match(/observatory|research_lab|development|security|admin/);
      if (d) return d[0];
    } catch { /* fall through */ }
  }
  return keywordDept(text);
}

/* Jay Jay decides HOW Development should build: a quick UI mockup (single
   self-contained HTML) vs a full app/platform in a real stack he recommends. */
const BUILD_STACKS = ["static", "django", "node", "flutter", "react", "react-native"];
export async function recommendStack(task, model = null) {
  const text = `${task.title}\n${task.prompt || ""}`;
  const low = text.toLowerCase();
  const explicit = /\bdjango\b/.test(low) ? "django"
    : /\bflutter\b/.test(low) ? "flutter"
    : /(react native|react-native|\bexpo\b)/.test(low) ? "react-native"
    : /\breact\b/.test(low) ? "react"
    : /(node\.?js|express|fastify|next\.?js)/.test(low) ? "node" : null;
  // An explicit HTML / mobile-web / mockup / UI-flow request → a self-contained
  // web mockup; never let the classifier upgrade it to a React/Node app.
  const mockupHint = /(mockup|wireframe|prototype|html (project|page|mock|template|flow)|mobile[- ]?web|web (app )?mockup|single[- ]?page|landing page|html template|ui kit|screen flow|ui flow|design only|just the (ui|design|frontend)|logo|app icon|favicon|invoice|receipt|quotation|presentation|power ?point|slide ?deck|\bslides\b|pitch ?deck|marketing page)/.test(low)
    || (/\bhtml\b/.test(low) && /(mockup|flow|screens?|prototype|mobile|onboard|wallet|card)/.test(low));
  if (explicit) return { type: "app", stack: explicit, reason: "you named the stack" };
  if (mockupHint) return { type: "mockup", stack: "static", reason: "mobile web HTML mockup" };
  if (ai && model) {
    try {
      const txt = await generate(
        "You are JAY JAY, the CTO, deciding how Development should build this. DEFAULT to MOCKUP (one self-contained HTML/UI prototype). Only choose 'app' if the task EXPLICITLY requires a real backend — a server, database, user accounts/persistence, or real API endpoints — or explicitly names a framework. A UI / flow / screens / prototype is a MOCKUP even if it's called an 'app'. If app, recommend ONE stack: django, node, flutter, react, or react-native. Reply ONLY as JSON: {\"type\":\"mockup\"|\"app\",\"stack\":\"static\"|\"django\"|\"node\"|\"flutter\"|\"react\"|\"react-native\",\"reason\":\"<=12 words\"}. stack is \"static\" only when type is mockup.",
        text.slice(0, 1500),
        { json: true, temperature: 0, model }
      );
      const p = JSON.parse(txt);
      if (p.type === "app" && BUILD_STACKS.includes(p.stack) && p.stack !== "static") return { type: "app", stack: p.stack, reason: String(p.reason || "").slice(0, 80) };
      return { type: "mockup", stack: "static", reason: String(p.reason || "UI mockup").slice(0, 80) };
    } catch { /* fall through */ }
  }
  if (mockupHint) return { type: "mockup", stack: "static", reason: "UI mockup" };
  if (/(full app|platform|backend|rest api|\bapi\b|database|authentication|login system|sign ?up|crud|deploy|server|micro-?service)/.test(low)) return { type: "app", stack: "node", reason: "app with backend" };
  return { type: "mockup", stack: "static", reason: "front-end UI" };
}

/* Planner: Jay Jay breaks a goal into 2-5 department-assignable sub-tasks. */
export async function planTask(task, model = null) {
  const DEPTS = "observatory (Scout — research/monitoring), research_lab (Scribe — writing/analysis), development (Orbit — building/coding/API tests), admin (Vault — records/organizing), security (Warden — security checks)";
  if (!ai || !model) {
    return [{ title: `Work on: ${task.title}`, prompt: task.prompt, department: task.department || null }];
  }
  const txt = await generate(
    `You are JAY JAY, the CTO, planning how to deliver a GOAL with your team. Break it into 2-5 CONCRETE sub-tasks, each assignable to ONE department and completable by one agent in a single shot. ORDER them logically and set dependencies so later steps build on earlier ones (e.g. research before building, build before testing). For each step, "after" is the 0-based index of the earlier step it depends on (so it receives that step's output), or null if it can run independently. Departments: ${DEPTS}. Respond ONLY as JSON: {"subtasks":[{"title":"<=10 words","prompt":"clear instructions","department":"one of: observatory|research_lab|development|admin|security","after":<index or null>}]}.`,
    `GOAL: ${task.title}\n\nDETAILS: ${task.prompt}`,
    { json: true, temperature: 0.4, model }
  );
  const valid = new Set(["observatory", "research_lab", "development", "admin", "security"]);
  try {
    const p = JSON.parse(txt);
    const subs = (p.subtasks || []).filter((s) => s && s.title).slice(0, 6).map((s, i) => ({
      title: String(s.title).slice(0, 80),
      prompt: String(s.prompt || s.title).slice(0, 2000),
      department: valid.has(s.department) ? s.department : (task.department || null),
      after: Number.isInteger(s.after) && s.after >= 0 && s.after < i ? s.after : null, // only depend on earlier steps
    }));
    if (subs.length) return subs;
  } catch { /* fall through */ }
  return [{ title: `Work on: ${task.title}`, prompt: task.prompt, department: task.department || null, after: null }];
}

/* Synthesis: combine the sub-task deliverables into one final deliverable. */
export async function synthesize(task, parts, model = null) {
  const joined = parts.map((p) => `## ${p.title}${p.department ? ` (${p.department})` : ""}\n${p.result || ""}`).join("\n\n---\n\n");
  if (!ai || !model) return `# ${task.title}\n\n${joined}`;
  const out = await generate(
    "You are JAY JAY, the CTO. Assemble the sub-task deliverables below into ONE cohesive final deliverable that fulfils the goal. Markdown, starting with a \"# Title\". RULES: " +
      "(1) Integrate and deduplicate — don't just concatenate. " +
      "(2) PRESERVE ALL CODE EXACTLY as given — keep every \"===== FILE: path =====\" marker and every fenced code block verbatim; never rewrite, summarize, or drop code (the app packages those files into a downloadable .zip). " +
      "(3) Keep tables and data intact. " +
      "(4) End with a \"## Contributors\" section listing which department/agent produced which part (from the sub-task headings). No preamble.",
    `GOAL: ${task.title}\n\nDETAILS: ${task.prompt}\n\nSUB-TASK DELIVERABLES (each headed by the department that produced it):\n${joined.slice(0, 28000)}`,
    { model }
  );
  return out || `# ${task.title}\n\n${joined}`;
}

/* Research Lab reviews a finished deliverable and proposes concrete
   improvements (or says it's done / needs the human's input). */
export async function suggestImprovements(task, result, model = null) {
  const fallback = { done: false, needsInput: false, note: "Reviewed.", improvements: [] };
  if (!ai || !model || !result) return fallback;
  try {
    const txt = await generate(
      "You are the Research Lab QA reviewing a COMPLETED deliverable for the CTO. " +
        "FIRST screen for BUGS and defects — list every one you find as a high-priority item: logic errors, wrong behaviour vs the task's intent, broken or dead interactions/handlers/routes, state that doesn't update, and UX/UI problems (OVERFLOWING or clipped content, overlapping elements, broken/unresponsive layout, poor contrast/spacing). " +
        "THEN add other high-value improvements (UX/UI polish, completeness of the flow, missing screens/states, accessibility, performance). Bugs come first, ordered by severity, then enhancements. " +
        "If it is genuinely excellent — no bugs and nothing material left — set done=true with an empty list. If progressing needs a human decision only they can make (ambiguous direction, a missing requirement, a product choice), set needsInput=true and explain in the note. " +
        "Respond ONLY as JSON: {\"done\": boolean, \"needsInput\": boolean, \"note\": \"<=18 words\", \"improvements\": [{\"title\": \"<=8 words\", \"detail\": \"one specific change/fix to make\"}]} — max 6, ordered by impact (bugs first).",
      `TASK: ${task.title}\nDETAILS: ${task.prompt}\n\nDELIVERABLE:\n${String(result).slice(0, 24000)}`,
      { json: true, temperature: 0.4, model }
    );
    const p = JSON.parse(txt);
    const improvements = Array.isArray(p.improvements) ? p.improvements.filter((x) => x && x.title).slice(0, 6).map((x) => ({ title: String(x.title).slice(0, 80), detail: String(x.detail || x.title).slice(0, 400) })) : [];
    return { done: !!p.done && !improvements.length, needsInput: !!p.needsInput, note: String(p.note || "").slice(0, 160) || "Reviewed.", improvements };
  } catch {
    return fallback;
  }
}

/* One-line memory note so future related tasks can continue the work. */
export async function summarizeForMemory(agent, task, result, model = null) {
  if (!ai || !model) return `${task.title} — completed.`;
  try {
    const txt = await generate(
      "In ONE short line (max 18 words), note what was done and any key fact worth remembering for future related work. No preamble.",
      `TASK: ${task.title}\nRESULT:\n${result}`,
      { temperature: 0.3, model }
    );
    return (txt || "").replace(/\s+/g, " ").slice(0, 180) || `${task.title} — completed.`;
  } catch {
    return `${task.title} — completed.`;
  }
}

/* CTO reviews the deliverable. Throws on API error (-> Issue); a bad/parse
   response just defaults to approved rather than blocking the pipeline. */
export async function runReview(task, result, model = null) {
  // Deterministic guard: empty / refusal / stub never passes.
  const text = String(result || "").trim();
  if (text.length < 40 || /^(i (can'?t|cannot|am unable|'?m sorry)|as an ai)\b/i.test(text)) {
    return { complete: false, note: "deliverable is empty, a refusal, or far too short" };
  }
  // Completeness gate for web build flows: a multi-step app must actually have
  // the screens. A thin 1-2 screen build is auto-rejected so it gets rebuilt.
  const looksWeb = /<!doctype html|<html|class="[^"]*\bscreen\b|data-screen=/i.test(text);
  const flowTask = /onboard|sign[- ]?up|\bapply\b|application|activat|\bkyc\b|\bflow\b|\bsteps?\b|wallet|top[- ]?up|multi[- ]?step|journey/i.test(`${task.title} ${task.prompt}`);
  if (looksWeb && flowTask) {
    const screens = (text.match(/class="[^"]*\b(screen|page|step|view)\b|data-screen=|id="[^"]*screen/gi) || []).length;
    if (screens < 5) {
      return { complete: false, note: `Incomplete flow — only ~${screens} screen(s). Build EVERY screen of the journey with working navigation: welcome → sign-up/OTP → KYC → account & currency (SGD/USD) setup → card application → card ACTIVATION + animated success → set PIN → wallet home → top-up. No overlapping elements.` };
    }
  }
  if (!ai || !model) {
    await wait(400 + Math.random() * 500);
    return { complete: true, note: !model ? "demo" : "approved (sim)" };
  }
  const isDev = task.department === "development";
  const txt = await generate(
    "You are JAY JAY, the CTO, doing QA on a deliverable. It's Markdown TEXT that the app exports to .doc/.zip — NEVER reject it for file format or for \"being text\". " +
      "Check three things: (1) it addresses EVERY explicit requirement in the task, (2) it's correct and on-topic, (3) it's specific and real — no placeholders, TODOs, or vague filler. " +
      (isDev ? "For build/code tasks: the deliverable must contain actual code; and if the task describes a multi-step flow, it must implement the WHOLE journey (all screens, not just a home/dashboard) with working navigation and NO overlapping/clipped elements — mark incomplete if it's a thin 1-3 screen sample or has layout overlaps. " : "") +
      "Mark complete=false ONLY for MATERIAL problems (a missing requirement, wrong/placeholder content) — not for style or polish. " +
      "Respond ONLY as JSON: {\"complete\": boolean, \"note\": \"if incomplete: the SPECIFIC gaps to fix (<=16 words); if complete: a one-line approval\"}.",
    `TASK: ${task.title}\nDETAILS: ${task.prompt}\n\nDELIVERABLE:\n${result}`,
    { json: true, temperature: 0.2, model }
  );
  try {
    const p = JSON.parse(txt);
    return { complete: !!p.complete, note: String(p.note || "").slice(0, 160) || "reviewed" };
  } catch {
    return { complete: true, note: "approved" };
  }
}

/* CTO invents a department-appropriate task when the queue is empty.
   model=null (AUTO demo without a demo model) uses a canned title — no API. */
export async function generateTask(agent, model = null) {
  if (!ai || !model) {
    const title = pick(SIM[agent.department] || ["run a routine check"]);
    return { title, prompt: `${title}. Provide a brief, useful result.` };
  }
  try {
    const txt = await generate(
      `You are JAY JAY, the CTO, assigning ONE small self-contained task to ${agent.name} (${agent.role}, ${agent.room}). It must be completable by an LLM in a single shot with no external tools. Respond ONLY as JSON: {"title": string up to 8 words, "prompt": string}.`,
      `Assign a useful task to ${agent.name}.`,
      { json: true, temperature: 1.0, model }
    );
    const p = JSON.parse(txt);
    if (p.title && p.prompt) {
      return { title: String(p.title).slice(0, 80), prompt: String(p.prompt).slice(0, 800) };
    }
  } catch {
    /* fall through to sim */
  }
  const title = pick(SIM[agent.department] || ["run a routine check"]);
  return { title, prompt: `${title}. Provide a brief, useful result.` };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
