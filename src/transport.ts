import { LruTtlCache } from "./cache.js";
import {
  HttpError,
  InvalidPayloadError,
  NotFoundError,
  ResponseTooLargeError,
} from "./errors.js";
import { RequestScheduler } from "./scheduler.js";
import type { Logger, TransportRequestOptions, UnknownRecord } from "./types.js";
import { sleep } from "./utils.js";

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export interface TransportOptions {
  baseUrl: string;
  fetch: typeof fetch;
  headers: Record<string, string>;
  userAgent: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxConcurrency: number;
  minRequestIntervalMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  cache: LruTtlCache | null;
  logger: Logger | null;
}

export class HttpTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #cache: LruTtlCache | null;
  readonly #logger: Logger | null;
  readonly #scheduler: RequestScheduler;
  readonly #inflight = new Map<string, Promise<string>>();

  public constructor(options: TransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch;
    this.#headers = options.headers;
    this.#userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#maxRetries = options.maxRetries;
    this.#retryBaseDelayMs = options.retryBaseDelayMs;
    this.#retryMaxDelayMs = options.retryMaxDelayMs;
    this.#cache = options.cache;
    this.#logger = options.logger;
    this.#scheduler = new RequestScheduler(
      options.maxConcurrency,
      options.minRequestIntervalMs,
    );
  }

  public absoluteUrl(pathOrUrl: string): string {
    return new URL(pathOrUrl, `${this.#baseUrl}/`).href;
  }

  public async getText(
    pathOrUrl: string,
    options: TransportRequestOptions = {},
  ): Promise<string> {
    const url = this.absoluteUrl(pathOrUrl);
    const key = options.cacheKey ?? `text:${url}`;
    const ttl = options.cacheTtlMs ?? 0;
    const cached = this.#cache?.get<string>(key);
    if (cached !== undefined) return cached;

    const existing = this.#inflight.get(key);
    if (existing) return existing;

    const promise = this.#requestWithRetries(url, options)
      .then((text) => {
        if (ttl > 0) this.#cache?.set(key, text, ttl);
        return text;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  public async getJson<T = unknown>(
    pathOrUrl: string,
    options: TransportRequestOptions = {},
  ): Promise<T> {
    const url = this.absoluteUrl(pathOrUrl);
    const cacheKey = options.cacheKey ?? `json:${url}`;
    const text = await this.getText(url, {
      ...options,
      cacheKey,
      accept: options.accept ?? "application/json,text/plain;q=0.9,*/*;q=0.8",
    });
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new InvalidPayloadError("RanobeRF returned invalid JSON.", {
        url,
        preview: text.slice(0, 500),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public clearCache(): void {
    this.#cache?.clear();
  }

  public deleteCache(key: string): void {
    this.#cache?.delete(key);
  }

  async #requestWithRetries(
    url: string,
    options: TransportRequestOptions,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Aborted");
      }
      try {
        return await this.#scheduler.schedule(
          () => this.#fetchOnce(url, options),
          options.signal,
        );
      } catch (error) {
        lastError = error;
        if (!this.#shouldRetry(error, attempt, options.signal)) throw error;
        const delayMs = this.#retryDelay(error, attempt);
        this.#logger?.warn("Retrying RanobeRF request", {
          url,
          attempt: attempt + 1,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delayMs, options.signal);
      }
    }
    throw lastError;
  }

  async #fetchOnce(url: string, options: TransportRequestOptions): Promise<string> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new DOMException("Request timeout", "TimeoutError")),
      this.#timeoutMs,
    );
    const signal = combineSignals(options.signal, timeoutController.signal);
    try {
      this.#logger?.debug("Fetching RanobeRF", { url });
      const request: RequestInit = {
        method: "GET",
        redirect: "follow",
        headers: {
          Accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "User-Agent": this.#userAgent,
          Referer: `${this.#baseUrl}/`,
          ...this.#headers,
        },
      };
      if (signal) request.signal = signal;
      const response = await this.#fetch(url, request);
      const text = await readResponseText(response, this.#maxResponseBytes, url);
      if (response.ok) return text;
      if (response.status === 404) throw new NotFoundError(url, text);
      throw new HttpError(`RanobeRF returned HTTP ${response.status}.`, {
        status: response.status,
        url,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        body: text,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  #shouldRetry(error: unknown, attempt: number, signal?: AbortSignal): boolean {
    if (attempt >= this.#maxRetries || signal?.aborted) return false;
    if (error instanceof HttpError) {
      return RETRYABLE_STATUSES.has(error.status) || error.status >= 500;
    }
    if (error instanceof InvalidPayloadError || error instanceof ResponseTooLargeError) {
      return false;
    }
    return (
      error instanceof TypeError ||
      (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
    );
  }

  #retryDelay(error: unknown, attempt: number): number {
    if (error instanceof HttpError && error.retryAfterMs !== null) {
      return Math.min(this.#retryMaxDelayMs, Math.max(0, error.retryAfterMs));
    }
    const exponential = Math.min(
      this.#retryMaxDelayMs,
      this.#retryBaseDelayMs * 2 ** attempt,
    );
    return Math.round(exponential * (0.8 + Math.random() * 0.4));
  }
}

async function readResponseText(response: Response, limit: number, url: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ResponseTooLargeError(url, limit);
  }
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ResponseTooLargeError(url, limit);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  if (first.aborted) return first;
  if (second.aborted) return second;
  const controller = new AbortController();
  const relay = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  first.addEventListener("abort", () => relay(first), { once: true });
  second.addEventListener("abort", () => relay(second), { once: true });
  return controller.signal;
}

export const consoleLogger: Logger = {
  debug: (message, context) => console.debug(message, context ?? {}),
  info: (message, context) => console.info(message, context ?? {}),
  warn: (message, context) => console.warn(message, context ?? {}),
  error: (message, context) => console.error(message, context ?? {}),
};

export function logContext(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}
