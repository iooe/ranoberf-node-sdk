import type { ImageAsset } from "./types.js";
import { absoluteUrl, uniqueBy } from "./utils.js";

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "hr",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "a",
  "img",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "sup",
  "sub",
  "span",
  "div",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const BLOCK_TAGS = new Set([
  "p",
  "br",
  "hr",
  "li",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "table",
  "ul",
  "ol",
  "div",
]);
const DANGEROUS_BLOCKS = /<(script|style|iframe|object|embed|noscript|form|svg|canvas|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const LAZY_IMAGE_ATTRIBUTES = [
  "src",
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-url",
  "data-lazy",
];

export interface NormalizedHtml {
  formattedHtml: string;
  text: string;
  images: ImageAsset[];
}

export function normalizeChapterHtml(rawHtml: string, baseUrl: string): NormalizedHtml {
  const formattedHtml = sanitizeHtml(rawHtml, baseUrl);
  return {
    formattedHtml,
    text: htmlToText(formattedHtml),
    images: extractContentImages(rawHtml, baseUrl),
  };
}

export function sanitizeHtml(rawHtml: string, baseUrl: string): string {
  const withoutDangerous = rawHtml
    .replace(DANGEROUS_BLOCKS, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const output: string[] = [];
  const tokenPattern = /<[^>]*>|[^<]+/g;
  for (const match of withoutDangerous.matchAll(tokenPattern)) {
    const token = match[0];
    if (!token.startsWith("<")) {
      output.push(token);
      continue;
    }
    const parsed = parseTag(token);
    if (!parsed || !ALLOWED_TAGS.has(parsed.name)) continue;
    if (parsed.closing) {
      if (!VOID_TAGS.has(parsed.name)) output.push(`</${normalizeTagName(parsed.name)}>`);
      continue;
    }
    const normalizedName = normalizeTagName(parsed.name);
    const attributes = sanitizeAttributes(parsed.name, parsed.attributes, baseUrl);
    if (attributes === null) continue;
    output.push(`<${normalizedName}${attributes}>`);
  }
  return output.join("").trim();
}

export function extractContentImages(rawHtml: string, baseUrl: string): ImageAsset[] {
  const images: ImageAsset[] = [];
  const pattern = /<img\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawHtml)) !== null) {
    const attrs = parseAttributes(match[1] ?? "");
    const source = firstAttribute(attrs, LAZY_IMAGE_ATTRIBUTES);
    const url = absoluteUrl(source, baseUrl);
    if (!url) continue;
    images.push({
      id: null,
      url,
      path: null,
      name: fileNameFromUrl(url),
      alt: attrs.get("alt") ?? null,
      kind: "content",
      raw: match[0],
    });
  }
  return uniqueBy(images, (image) => image.url);
}

export function htmlToText(html: string): string {
  let value = html;
  for (const tag of BLOCK_TAGS) {
    const pattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    value = value.replace(pattern, "\n");
  }
  value = value.replace(/<[^>]+>/g, "");
  value = decodeEntities(value);
  return value
    .replace(/\r/g, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\t ]{2,}/g, " ")
    .trim();
}

function normalizeTagName(name: string): string {
  switch (name) {
    case "b":
      return "strong";
    case "i":
      return "em";
    case "del":
      return "s";
    default:
      return name;
  }
}

function sanitizeAttributes(tag: string, raw: string, baseUrl: string): string | null {
  const attrs = parseAttributes(raw);
  const output: string[] = [];

  if (tag === "a") {
    const href = safeLink(attrs.get("href") ?? null, baseUrl);
    if (href) output.push(`href="${escapeAttribute(href)}"`);
    const title = attrs.get("title");
    if (title) output.push(`title="${escapeAttribute(title)}"`);
    if (href?.startsWith("http")) output.push('rel="noopener noreferrer nofollow"');
  }

  if (tag === "img") {
    const source = firstAttribute(attrs, LAZY_IMAGE_ATTRIBUTES);
    const src = absoluteUrl(source, baseUrl);
    if (!src) return null;
    output.push(`src="${escapeAttribute(src)}"`);
    output.push(`alt="${escapeAttribute(attrs.get("alt") ?? "")}"`);
    const title = attrs.get("title");
    if (title) output.push(`title="${escapeAttribute(title)}"`);
    for (const dimension of ["width", "height"] as const) {
      const value = attrs.get(dimension);
      if (value && /^\d{1,5}$/.test(value)) output.push(`${dimension}="${value}"`);
    }
    output.push('loading="lazy"');
    output.push('decoding="async"');
  }

  if (tag === "ol") {
    const start = attrs.get("start");
    if (start && /^-?\d{1,8}$/.test(start)) output.push(`start="${start}"`);
  }

  if (["th", "td"].includes(tag)) {
    for (const key of ["colspan", "rowspan"] as const) {
      const value = attrs.get(key);
      if (value && /^\d{1,3}$/.test(value)) output.push(`${key}="${value}"`);
    }
  }

  const style = sanitizeStyle(attrs.get("style") ?? "");
  if (style) output.push(`style="${escapeAttribute(style)}"`);
  const align = attrs.get("align")?.toLowerCase();
  if (align && ["left", "right", "center", "justify"].includes(align)) {
    output.push(`style="text-align:${align}"`);
  }

  return output.length > 0 ? ` ${deduplicateAttributes(output).join(" ")}` : "";
}

function sanitizeStyle(raw: string): string {
  const allowed = new Set([
    "text-align",
    "font-weight",
    "font-style",
    "text-decoration",
    "vertical-align",
    "white-space",
  ]);
  const result: string[] = [];
  for (const declaration of raw.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!allowed.has(property) || !/^[\w\s.,%#()\-]+$/.test(value)) continue;
    result.push(`${property}:${value}`);
  }
  return result.join(";");
}

function safeLink(value: string | null, baseUrl: string): string | null {
  if (!value) return null;
  if (/^(mailto:|tel:)/i.test(value)) return value;
  return absoluteUrl(value, baseUrl);
}

function parseTag(token: string): { name: string; closing: boolean; attributes: string } | null {
  const match = /^<\s*(\/?)\s*([a-zA-Z0-9]+)([\s\S]*?)\/?\s*>$/.exec(token);
  if (!match) return null;
  return {
    closing: match[1] === "/",
    name: (match[2] ?? "").toLowerCase(),
    attributes: match[3] ?? "",
  };
}

function parseAttributes(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    if (!name || name.startsWith("on")) continue;
    result.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return result;
}

function firstAttribute(attrs: Map<string, string>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = attrs.get(name);
    if (value && value.trim() !== "") return value;
  }
  return null;
}

function deduplicateAttributes(values: string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    const key = value.slice(0, value.indexOf("="));
    if (key === "style" && result.has(key)) {
      const previous = result.get(key) ?? 'style=""';
      const merged = `${previous.slice(7, -1)};${value.slice(7, -1)}`.replace(/^;+|;+$/g, "");
      result.set(key, `style="${merged}"`);
    } else {
      result.set(key, value);
    }
  }
  return [...result.values()];
}

function fileNameFromUrl(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    laquo: "«",
    raquo: "»",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (full, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return named[entity.toLowerCase()] ?? full;
  });
}
