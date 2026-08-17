import type { QueryEntries, QueryValue, UnknownRecord } from "./types.js";

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function asInteger(value: unknown): number | null {
  const number = asNumber(value);
  return number === null ? null : Math.trunc(number);
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate = asString(value);
    if (candidate !== null && candidate.trim() !== "") return candidate;
  }
  return null;
}

export function firstId(...values: unknown[]): number | string | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

export function absoluteUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "" || /^data:/i.test(trimmed) || /^javascript:/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, `${baseUrl.replace(/\/+$/, "")}/`);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function objectToSearchParams(values: QueryEntries = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(values)) {
    const list = Array.isArray(raw) ? raw : [raw];
    for (const value of list) appendQueryValue(params, key, value);
  }
  return params;
}

export function appendQueryValue(
  params: URLSearchParams,
  key: string,
  value: QueryValue,
): void {
  if (value === null || value === undefined) return;
  params.append(key, String(value));
}

export function mergeQuery(
  base: QueryEntries | undefined,
  additions: QueryEntries,
): URLSearchParams {
  const params = objectToSearchParams(base);
  for (const [key, raw] of Object.entries(additions)) {
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.every((value) => value === null || value === undefined)) continue;
    params.delete(key);
    for (const value of list) appendQueryValue(params, key, value);
  }
  return params;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function normalizePath(value: string): string {
  const path = value.trim();
  if (path === "" || path === "/") return "/";
  return `/${path.replace(/^\/+|\/+$/g, "")}`;
}

export function slugFromBookInput(input: string, baseUrl: string): string {
  const path = pathFromInput(input, baseUrl);
  const segments = path.split("/").filter(Boolean);
  const slug = segments[0];
  if (!slug) throw new TypeError(`Invalid RanobeRF book input: ${input}`);
  return decodeURIComponent(slug);
}

export function chapterSlugsFromInput(
  bookInput: string,
  chapterInput: string | undefined,
  baseUrl: string,
): { bookSlug: string; chapterSlug: string } {
  if (chapterInput !== undefined) {
    return {
      bookSlug: slugFromBookInput(bookInput, baseUrl),
      chapterSlug: slugFromChapterInput(chapterInput, baseUrl),
    };
  }
  const path = pathFromInput(bookInput, baseUrl);
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2 || !segments[0] || !segments[1]) {
    throw new TypeError(`Expected a full RanobeRF chapter URL or book/chapter slugs: ${bookInput}`);
  }
  return { bookSlug: segments[0], chapterSlug: segments[1] };
}

export function slugFromChapterInput(input: string, baseUrl: string): string {
  const path = pathFromInput(input, baseUrl);
  const segments = path.split("/").filter(Boolean);
  const slug = segments.at(-1);
  if (!slug) throw new TypeError(`Invalid RanobeRF chapter input: ${input}`);
  return decodeURIComponent(slug);
}

export function pathFromInput(input: string, baseUrl: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const expected = new URL(baseUrl);
    if (url.hostname !== expected.hostname) {
      throw new TypeError(`URL does not belong to RanobeRF: ${input}`);
    }
    return normalizePath(url.pathname);
  }
  return normalizePath(trimmed);
}

export function encodeRoutePath(route: string): string {
  const normalized = normalizePath(route);
  if (normalized === "/") return "index.json";
  return `${normalized
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(decodeURIComponent(part)))
    .join("/")}.json`;
}

export function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    const identifier = key(value);
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    output.push(value);
  }
  return output;
}
