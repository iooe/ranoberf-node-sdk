import { BuildIdNotFoundError, NotFoundError } from "./errors.js";
import { HttpTransport } from "./transport.js";
import type { QueryEntries } from "./types.js";
import { encodeRoutePath, objectToSearchParams } from "./utils.js";

export class NextDataSource {
  readonly #transport: HttpTransport;
  readonly #baseUrl: string;
  readonly #buildIdTtlMs: number;
  #buildId: string | null = null;
  #buildIdExpiresAt = 0;
  readonly #buildHomeCacheKey = "ranoberf:next-build-home";

  public constructor(options: {
    transport: HttpTransport;
    baseUrl: string;
    buildIdTtlMs: number;
  }) {
    this.#transport = options.transport;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#buildIdTtlMs = options.buildIdTtlMs;
  }

  public async getBuildId(signal?: AbortSignal, force = false): Promise<string> {
    if (!force && this.#buildId && this.#buildIdExpiresAt > Date.now()) {
      return this.#buildId;
    }
    if (force) {
      this.#buildId = null;
      this.#buildIdExpiresAt = 0;
      this.#transport.deleteCache(this.#buildHomeCacheKey);
    }
    const html = await this.#transport.getText("/", {
      signal,
      cacheKey: this.#buildHomeCacheKey,
      cacheTtlMs: force ? 0 : this.#buildIdTtlMs,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    });
    const buildId = extractBuildId(html);
    if (!buildId) throw new BuildIdNotFoundError(`${this.#baseUrl}/`);
    this.#buildId = buildId;
    this.#buildIdExpiresAt = Date.now() + this.#buildIdTtlMs;
    return buildId;
  }

  public invalidateBuildId(): void {
    this.#buildId = null;
    this.#buildIdExpiresAt = 0;
    this.#transport.deleteCache(this.#buildHomeCacheKey);
  }

  public async fetchRoute<T = unknown>(
    route: string,
    options: {
      query?: QueryEntries;
      signal?: AbortSignal;
      cacheTtlMs?: number;
    } = {},
  ): Promise<T> {
    try {
      return await this.#fetchRouteOnce<T>(route, options, false);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return this.#fetchRouteOnce<T>(route, options, true);
    }
  }

  public async fetchPageHtml(
    route: string,
    options: { signal?: AbortSignal; cacheTtlMs?: number } = {},
  ): Promise<string> {
    return this.#transport.getText(route, {
      signal: options.signal,
      cacheTtlMs: options.cacheTtlMs ?? 0,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    });
  }

  async #fetchRouteOnce<T>(
    route: string,
    options: { query?: QueryEntries; signal?: AbortSignal; cacheTtlMs?: number },
    forceBuild: boolean,
  ): Promise<T> {
    const buildId = await this.getBuildId(options.signal, forceBuild);
    const path = `/_next/data/${encodeURIComponent(buildId)}/${encodeRoutePath(route)}`;
    const params = objectToSearchParams(options.query);
    const url = `${path}${params.size > 0 ? `?${params.toString()}` : ""}`;
    return this.#transport.getJson<T>(url, {
      signal: options.signal,
      cacheTtlMs: options.cacheTtlMs ?? 0,
    });
  }
}

export function extractBuildId(html: string): string | null {
  const nextData = extractNextData(html);
  if (nextData && typeof nextData.buildId === "string" && nextData.buildId.trim() !== "") {
    return nextData.buildId;
  }
  const staticMatch = /\/_next\/static\/([^/"']+)\/_buildManifest\.js/i.exec(html);
  return staticMatch?.[1] ? decodeURIComponent(staticMatch[1]) : null;
}

export function extractNextData(html: string): Record<string, unknown> | null {
  const match = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return null;
  try {
    const decoded = decodeScriptEntities(match[1]);
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeScriptEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
