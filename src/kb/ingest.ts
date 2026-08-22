/** Deterministic knowledge-base ingestion pipeline (issue #91). */
import type { MemoryProvider } from "../memory/types";
import type { AuditModule } from "../policy/audit";
import { MEMORY_WRITE_EVENT } from "../store/audit-events";
import { sha256Hex } from "../tools/helpers";
import type { KbConfig, KbSource } from "./config";

export const KB_CHUNK_MAX_CHARS = 2_000;
export const KB_FETCH_TIMEOUT_MS = 10_000;
export const KB_FETCH_MAX_BYTES = 5 * 1024 * 1024;

export interface IngestOptions {
  /** Replaces the configured URL's origin, preserving its path and query. */
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxChunkChars?: number;
}

export interface IngestSourceResult {
  url: string;
  chunks: number;
  saved: number;
}

interface TextSection {
  heading?: string;
  blocks: string[];
}

/** Named HTML entities decodable by name (lowercase). */
const HTML_ENTITY_BY_NAME = new Map<string, string>([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const codePoint = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (name.startsWith("#")) {
      const codePoint = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return HTML_ENTITY_BY_NAME.get(name.toLowerCase()) ?? entity;
  });
}

function htmlToStructuredText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[^]*?-->/g, " ")
      .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, " ")
      .replace(/<h([1-6])\b[^>]*>/gi, (_tag, level: string) => `\n\n${"#".repeat(Number(level))} `)
      .replace(/<\/h[1-6]\s*>/gi, "\n\n")
      .replace(/<(?:p|div|section|article|header|footer|main|aside|blockquote|pre)\b[^>]*>/gi, "\n\n")
      .replace(/<\/(?:p|div|section|article|header|footer|main|aside|blockquote|pre)\s*>/gi, "\n\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/li\s*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function textSections(text: string): TextSection[] {
  const sections: TextSection[] = [];
  let heading: string | undefined;
  let blocks: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push(paragraphLines.join(" "));
    paragraphLines = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (heading !== undefined || blocks.length > 0) sections.push({ heading, blocks });
    blocks = [];
  };

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim().replace(/[ \t]+/g, " ");
    if (!line) {
      flushParagraph();
      continue;
    }
    if (/^#{1,6}\s+\S/.test(line)) {
      flushSection();
      heading = line;
      continue;
    }
    paragraphLines.push(line);
  }
  flushSection();
  return sections;
}

function splitBlock(block: string, limit: number): string[] {
  const parts: string[] = [];
  let remaining = block;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const breakAt = candidate.slice(0, limit).search(/\s+\S*$/);
    const take = breakAt > 0 ? breakAt : limit;
    parts.push(remaining.slice(0, take).trimEnd());
    remaining = remaining.slice(take).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * Splits text by Markdown headings and paragraph boundaries. Chunks from a
 * headed section repeat that heading and never exceed `maxChars`.
 */
export function chunkText(text: string, maxChars: number = KB_CHUNK_MAX_CHARS): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 16) throw new Error("KB chunk size must be an integer of at least 16");
  const chunks: string[] = [];

  for (const section of textSections(text)) {
    if (section.blocks.length === 0) {
      if (section.heading) chunks.push(...splitBlock(section.heading, maxChars));
      continue;
    }

    const maxHeadingLength = Math.floor((maxChars - 2) / 2);
    const heading = section.heading?.slice(0, maxHeadingLength);
    const prefix = heading ? `${heading}\n\n` : "";
    const bodyLimit = maxChars - prefix.length;
    let body = "";

    const flushBody = () => {
      if (!body) return;
      chunks.push(`${prefix}${body}`);
      body = "";
    };

    for (const block of section.blocks) {
      if (block.length > bodyLimit) {
        flushBody();
        for (const part of splitBlock(block, bodyLimit)) chunks.push(`${prefix}${part}`);
        continue;
      }
      const candidate = body ? `${body}\n\n${block}` : block;
      if (candidate.length > bodyLimit) {
        flushBody();
        body = block;
      } else {
        body = candidate;
      }
    }
    flushBody();
  }

  return chunks;
}

function effectiveSourceUrl(sourceUrl: string, baseUrl?: string): string {
  if (!baseUrl) return sourceUrl;
  const original = new URL(sourceUrl);
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("KB base URL override must use http or https");
  }
  return new URL(`${original.pathname}${original.search}${original.hash}`, base).toString();
}

async function fetchSourceText(source: KbSource, options: IngestOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? KB_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? KB_FETCH_MAX_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("KB fetch timeout must be a positive integer");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("KB fetch size cap must be a positive integer");

  const fetchUrl = effectiveSourceUrl(source.url, options.baseUrl ?? process.env.BOTTEGA_KB_BASE_URL);
  try {
    const response = await Bun.fetch(fetchUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > maxBytes) {
      await response.body?.cancel();
      throw new Error(`response exceeds ${maxBytes}-byte size cap`);
    }
    if (!response.body) throw new Error("response has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const textParts: string[] = [];
    let bytesRead = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maxBytes}-byte size cap`);
      }
      textParts.push(decoder.decode(result.value, { stream: true }));
    }
    textParts.push(decoder.decode());
    const text = textParts.join("");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    return contentType.includes("html") || /<!doctype\s+html|<html\b|<h[1-6]\b|<p\b/i.test(text)
      ? htmlToStructuredText(text)
      : text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`KB source '${source.id}' fetch failed (${fetchUrl}): ${message}`);
  }
}

/** Fetches, chunks, saves, and audits one configured source. */
export async function ingestSource(
  memoryProvider: MemoryProvider,
  audit: AuditModule,
  source: KbSource,
  options: IngestOptions = {},
): Promise<IngestSourceResult> {
  const text = await fetchSourceText(source, options);
  const chunks = chunkText(text, options.maxChunkChars ?? KB_CHUNK_MAX_CHARS);
  if (chunks.length === 0) throw new Error(`KB source '${source.id}' produced no content`);

  let saved = 0;
  for (const chunk of chunks) {
    const entry = await memoryProvider.save({
      scope: { kind: "org" },
      content: chunk,
      metadata: { kind: "kb", source: source.id, url: source.url },
    });
    await audit.appendAudit({
      actor: "kb_ingest",
      event_type: MEMORY_WRITE_EVENT,
      payload: {
        scope: "org",
        principal: null,
        id: entry.id,
        content_hash: sha256Hex(entry.content),
      },
    });
    saved += 1;
  }
  return { url: source.url, chunks: chunks.length, saved };
}

/** Ingests every configured source in declaration order. */
export async function ingestAll(
  memoryProvider: MemoryProvider,
  audit: AuditModule,
  config: KbConfig,
  options: IngestOptions = {},
): Promise<IngestSourceResult[]> {
  const results: IngestSourceResult[] = [];
  for (const source of config.sources) results.push(await ingestSource(memoryProvider, audit, source, options));
  return results;
}
