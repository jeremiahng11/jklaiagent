// Local, offline text embeddings for semantic memory (RAG). Runs a small
// sentence-transformer in-process via Transformers.js — no API key, no network
// at runtime (the model is cached into the Docker image at build time). Returns
// a 384-dim unit vector, or null on failure so callers fall back to keyword
// recall. This is what makes the agents recall past work BY MEANING and improve
// over time.

import { pipeline, env } from "@xenova/transformers";
import { existsSync, mkdirSync, cpSync, accessSync, constants } from "fs";

// Where the model lives at runtime. Prefer a PERSISTENT location (the data
// volume) so it's fetched at most once and survives redeploys; seed it from the
// copy baked into the image so there's usually no download at all. If that
// location isn't writable (e.g. a root-owned volume), fall back to the baked
// in-image cache, which always works.
const BAKED = "./.models";
function pickCacheDir() {
  const want = process.env.EMBED_CACHE_DIR || `${process.env.DATA_DIR || "/app/data"}/.models`;
  try {
    mkdirSync(want, { recursive: true });
    accessSync(want, constants.W_OK);
    if (!existsSync(`${want}/Xenova`) && existsSync(`${BAKED}/Xenova`)) {
      cpSync(`${BAKED}/Xenova`, `${want}/Xenova`, { recursive: true });
      console.log("[embed] seeded model cache from image →", want);
    }
    return want;
  } catch {
    return BAKED; // not writable → use the model baked into the image
  }
}
env.cacheDir = pickCacheDir();
env.allowLocalModels = true;
console.log("[embed] model cache dir:", env.cacheDir);

// all-MiniLM-L6-v2: 384-dim, ~25MB quantized — fast on CPU, fine on a Pi.
const MODEL = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) extractorPromise = pipeline("feature-extraction", MODEL);
  return extractorPromise;
}

/** Embed text → 384-dim L2-normalized vector (or null on failure). */
export async function embedText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  if (!t) return null;
  try {
    const extractor = await getExtractor();
    const out = await extractor(t, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  } catch (e) {
    console.warn("[embed] failed:", e?.message);
    return null;
  }
}

/** Warm-up used by the Docker build to pre-download + cache the model. */
export async function warmEmbeddings() {
  const v = await embedText("warm up the embeddings model");
  return Array.isArray(v) ? v.length : 0;
}
