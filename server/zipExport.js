// Package a code deliverable into a downloadable .zip. Orbit (Development) is
// asked to emit each file with a "===== FILE: path =====" marker before its
// code fence; we also fall back to common filename-before-fence patterns.

import JSZip from "jszip";

export function extractFiles(md) {
  const text = md || "";
  let files = [];
  let m;

  // 1) Explicit markers followed by a fenced code block (most reliable).
  const markerFenceRe = /=+\s*FILE:\s*(.+?)\s*=+\s*\n```[^\n]*\n([\s\S]*?)```/g;
  while ((m = markerFenceRe.exec(text))) files.push({ path: m[1].trim(), content: m[2].replace(/\n$/, "") });
  if (files.length) return dedupe(files);

  // 1b) Markers WITHOUT fences — the model sometimes emits raw code right after
  //     the marker (no ``` ). Split on the marker lines and take the body between
  //     them, stripping a wrapping fence if there happens to be one.
  if (/=+\s*FILE:\s*.+?=+/i.test(text)) {
    const parts = text.split(/^[ \t]*=+\s*FILE:\s*(.+?)\s*=+[ \t]*$/gim);
    for (let i = 1; i < parts.length; i += 2) {
      const path = String(parts[i] || "").trim();
      let body = String(parts[i + 1] || "");
      const fence = body.match(/^\s*```[^\n]*\n([\s\S]*?)```\s*$/);
      if (fence) body = fence[1];
      body = body.replace(/^\n+/, "").replace(/\s+$/, "");
      if (path && body) files.push({ path, content: body });
    }
    if (files.length) return dedupe(files);
  }

  // 2) Fallback: a filename on the line just before a fenced block.
  const blockRe = /(^|\n)([^\n]*)\n```([^\n]*)\n([\s\S]*?)```/g;
  while ((m = blockRe.exec(text))) {
    const prev = m[2].trim();
    const content = m[4].replace(/\n$/, "");
    let path = null;
    const bt = prev.match(/`([\w./-]+\.[a-zA-Z0-9]+)`/);
    const colon = prev.match(/(?:file|path)\s*[:=]\s*([\w./-]+\.[a-zA-Z0-9]+)/i);
    const heading = prev.match(/^#{1,6}\s+`?([\w./-]+\.[a-zA-Z0-9]+)`?/);
    if (bt) path = bt[1];
    else if (colon) path = colon[1];
    else if (heading) path = heading[1];
    else if (/^[\w./-]+\.[a-zA-Z0-9]+$/.test(prev)) path = prev;
    if (path) files.push({ path, content });
  }
  if (files.length) return dedupe(files);

  // 3) Raw single file: no markers, no fences, but clearly HTML → index.html, so
  //    it still downloads/previews as a web page instead of a .txt blob.
  if (/^\s*<!doctype html|^\s*<html[\s>]/i.test(text) || /<\/html>\s*$/i.test(text)) {
    return [{ path: "index.html", content: text.trim() }];
  }
  return dedupe(files);
}

function dedupe(files) {
  const seen = new Set();
  return files.filter((f) => { const k = f.path; if (seen.has(k)) return false; seen.add(k); return true; });
}

function safePath(p) {
  return String(p).replace(/^[/\\]+/, "").replace(/\.\.[/\\]/g, "").replace(/[^\w./-]/g, "_").slice(0, 200) || "file.txt";
}

export async function buildZip(files, title, fullMarkdown) {
  const zip = new JSZip();
  if (files.length) {
    for (const f of files) zip.file(safePath(f.path), f.content);
    // Always include the full deliverable for context.
    zip.file("DELIVERABLE.md", fullMarkdown || "");
  } else {
    zip.file("DELIVERABLE.md", fullMarkdown || "(no content)");
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export const hasCode = (md) => /```/.test(md || "");

// Read the TEXT/code files out of an uploaded .zip so an agent can review or
// benchmark against them. Skips binaries and junk; caps total size.
const ZIP_TEXT_EXT = /\.(html?|css|scss|less|js|jsx|ts|tsx|mjs|cjs|json|md|markdown|txt|vue|svelte|py|dart|java|go|rb|php|ya?ml|xml|sql|c|cpp|h|hpp|cs|rs|kt|swift|sh|toml|astro|webmanifest|gitignore|env)$/i;
const ZIP_SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|\.cache|coverage|vendor)\//i;
export async function extractZipText(base64, maxChars = 55000) {
  try {
    const buf = Buffer.from(base64, "base64");
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files)
      .filter((n) => !zip.files[n].dir && !ZIP_SKIP.test(n) && ZIP_TEXT_EXT.test(n))
      .sort((a, b) => (/index\.html?$/i.test(b) ? 1 : 0) - (/index\.html?$/i.test(a) ? 1 : 0) || a.localeCompare(b));
    const parts = [];
    let total = 0, omitted = 0;
    for (const name of names) {
      if (total >= maxChars) { omitted++; continue; }
      const content = await zip.files[name].async("string");
      const slice = content.slice(0, Math.min(content.length, maxChars - total));
      parts.push(`===== FILE: ${name} =====\n${slice}${slice.length < content.length ? "\n… (truncated)" : ""}`);
      total += slice.length + name.length + 24;
    }
    if (!parts.length) return null;
    if (omitted) parts.push(`… (${omitted} more file(s) omitted — over size limit)`);
    return parts.join("\n\n");
  } catch {
    return null;
  }
}
export const isZip = (a) => /zip/i.test(a?.mime || "") || /\.zip$/i.test(a?.filename || "");

// All fenced code blocks (used when there are no explicit filenames).
export function extractCodeBlocks(md) {
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  const out = [];
  let m;
  while ((m = re.exec(md || ""))) out.push({ lang: String(m[1] || "").trim().toLowerCase().split(/\s+/)[0], content: m[2].replace(/\n$/, "") });
  return out;
}

const LANG_EXT = {
  html: "html", htm: "html", js: "js", javascript: "js", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx",
  py: "py", python: "py", dart: "dart", json: "json", css: "css", scss: "scss", java: "java", go: "go", golang: "go",
  rb: "rb", ruby: "rb", php: "php", yaml: "yml", yml: "yml", sh: "sh", bash: "sh", shell: "sh", sql: "sql",
  xml: "xml", md: "md", markdown: "md", c: "c", cpp: "cpp", "c++": "cpp", cs: "cs", csharp: "cs", rs: "rs",
  rust: "rs", kt: "kt", kotlin: "kt", swift: "swift", vue: "vue", svelte: "svelte", toml: "toml", dockerfile: "dockerfile",
  text: "txt", txt: "txt",
};
export const langExt = (lang) => LANG_EXT[lang] || "txt";

const MIME = {
  html: "text/html", css: "text/css", js: "text/javascript", jsx: "text/javascript", ts: "text/typescript",
  json: "application/json", xml: "application/xml", svg: "image/svg+xml", md: "text/markdown",
};
export const mimeForExt = (ext) => MIME[ext] || "text/plain; charset=utf-8";
export const baseName = (p) => String(p).split(/[/\\]/).pop() || "file.txt";
export const extOf = (name) => (String(name).split(".").pop() || "txt").toLowerCase();
