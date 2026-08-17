import { LruTtlCache } from "./cache.js";
import { ChapterUnavailableError, InvalidPayloadError, NotFoundError } from "./errors.js";
import { htmlToText } from "./html.js";
import { NextDataSource } from "./next-data.js";
import {
  extractBookFromPayload,
  extractCatalogData,
  extractChapterFromPayload,
  normalizeBookDetails,
  normalizeBookSummary,
  normalizeChapterDetails,
  normalizePageInfo,
} from "./normalize.js";
import { HttpTransport } from "./transport.js";
import type {
  BookDetails,
  BookSummary,
  CatalogIteratorOptions,
  CatalogPage,
  CatalogQuery,
  ChapterDetails,
  ChapterDownloadResult,
  ChapterSummary,
  DownloadBookResult,
  GetChapterOptions,
  QueryEntries,
  RanobeRfClientOptions,
  SearchBooksOptions,
  StreamChaptersOptions,
} from "./types.js";
import {
  chapterSlugsFromInput,
  mergeQuery,
  objectToSearchParams,
  slugFromBookInput,
} from "./utils.js";

const DEFAULT_BASE_URL = "https://xn--80acm4afj.xn--p1ai";

interface ResolvedCacheOptions {
  buildIdTtlMs: number;
  catalogTtlMs: number;
  bookTtlMs: number;
  chapterTtlMs: number;
  pageHtmlTtlMs: number;
}

export class RanobeRfClient {
  public readonly baseUrl: string;
  readonly #transport: HttpTransport;
  readonly #source: NextDataSource;
  readonly #cacheTtls: ResolvedCacheOptions;
  readonly #defaultConcurrency: number;

  public constructor(options: RanobeRfClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const cacheOptions = options.cache === false ? null : options.cache ?? {};
    const cache = cacheOptions
      ? new LruTtlCache(cacheOptions.maxEntries ?? 2_000)
      : null;
    this.#cacheTtls = {
      buildIdTtlMs: cacheOptions?.buildIdTtlMs ?? 5 * 60_000,
      catalogTtlMs: cacheOptions?.catalogTtlMs ?? 30_000,
      bookTtlMs: cacheOptions?.bookTtlMs ?? 5 * 60_000,
      chapterTtlMs: cacheOptions?.chapterTtlMs ?? 15 * 60_000,
      pageHtmlTtlMs: cacheOptions?.pageHtmlTtlMs ?? 5 * 60_000,
    };
    this.#defaultConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 24));
    this.#transport = new HttpTransport({
      baseUrl: this.baseUrl,
      fetch: options.fetch ?? globalThis.fetch,
      headers: options.headers ?? {},
      userAgent: options.userAgent ?? "@iooe/ranoberf-sdk/0.1.0",
      timeoutMs: options.timeoutMs ?? 30_000,
      maxResponseBytes: options.maxResponseBytes ?? 64 * 1024 * 1024,
      maxConcurrency: this.#defaultConcurrency,
      minRequestIntervalMs: options.minRequestIntervalMs ?? 0,
      maxRetries: options.maxRetries ?? 4,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 250,
      retryMaxDelayMs: options.retryMaxDelayMs ?? 8_000,
      cache,
      logger: options.logger ?? null,
    });
    this.#source = new NextDataSource({
      transport: this.#transport,
      baseUrl: this.baseUrl,
      buildIdTtlMs: this.#cacheTtls.buildIdTtlMs,
    });
  }

  public async getBuildId(signal?: AbortSignal): Promise<string> {
    return this.#source.getBuildId(signal);
  }

  public clearCache(): void {
    this.#source.invalidateBuildId();
    this.#transport.clearCache();
  }

  public async requestJson<T = unknown>(
    path: string,
    query: QueryEntries = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const params = objectToSearchParams(query);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#transport.getJson<T>(`${path}${suffix}`, { signal });
  }

  public async getRawNextData<T = unknown>(
    route: string,
    query: QueryEntries = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#source.fetchRoute<T>(route, { query, signal });
  }

  public async listCatalog(query: CatalogQuery = {}): Promise<CatalogPage> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.max(1, Math.floor(query.pageSize ?? 100));
    const route = query.route ?? "/books";
    const params = mergeQuery(query.params, {
      page,
      pageSize,
      order: query.order,
      expand:
        query.params?.expand ??
        "lastChapter,verticalImage,horizontalImage,squareImage,userRating",
    });
    const normalizedParams = searchParamsToQuery(params);
    const requestedSource = query.source ?? "auto";

    if (requestedSource !== "next") {
      try {
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        const payload = await this.#transport.getJson(`/v3/books${suffix}`, {
          signal: query.signal,
          cacheTtlMs: this.#cacheTtls.catalogTtlMs,
        });
        const data = extractCatalogData(payload);
        if (data.items.length > 0 || normalizePageInfo(data.pagesData, page).totalCount === 0) {
          return {
            items: data.items.map((item) => normalizeBookSummary(item, this.baseUrl)),
            pageInfo: normalizePageInfo(data.pagesData, page),
            source: "v3",
            route,
            raw: payload,
          };
        }
        if (requestedSource === "v3") {
          throw new InvalidPayloadError("RanobeRF v3 catalog response has no items.", { page });
        }
      } catch (error) {
        if (requestedSource === "v3" || query.signal?.aborted) throw error;
      }
    }

    let payload: unknown;
    let resolvedRoute = route;
    try {
      payload = await this.#source.fetchRoute(route, {
        query: normalizedParams,
        signal: query.signal,
        cacheTtlMs: this.#cacheTtls.catalogTtlMs,
      });
    } catch (error) {
      if (!(error instanceof NotFoundError) || route !== "/books") throw error;
      resolvedRoute = "/";
      payload = await this.#source.fetchRoute("/", {
        query: normalizedParams,
        signal: query.signal,
        cacheTtlMs: this.#cacheTtls.catalogTtlMs,
      });
    }
    const data = extractCatalogData(payload);
    return {
      items: data.items.map((item) => normalizeBookSummary(item, this.baseUrl)),
      pageInfo: normalizePageInfo(data.pagesData, page),
      source: "next",
      route: resolvedRoute,
      raw: payload,
    };
  }

  public async *iterateCatalog(
    options: CatalogIteratorOptions = {},
  ): AsyncGenerator<CatalogPage, void, undefined> {
    const startPage = Math.max(1, Math.floor(options.startPage ?? 1));
    const maxPages = Math.max(1, Math.floor(options.maxPages ?? Number.MAX_SAFE_INTEGER));
    for (let offset = 0; offset < maxPages; offset += 1) {
      const pageNumber = startPage + offset;
      const page = await this.listCatalog({
        page: pageNumber,
        pageSize: options.pageSize,
        order: options.order,
        route: options.route,
        source: options.source,
        params: options.params,
        signal: options.signal,
      });
      yield page;
      if (page.items.length === 0) return;
      if (page.pageInfo.pageCount !== null && pageNumber >= page.pageInfo.pageCount) return;
    }
  }

  public async searchBooks(
    search: string,
    options: SearchBooksOptions = {},
  ): Promise<BookSummary[]> {
    const needle = normalizeSearch(search);
    if (needle === "") return [];
    const results: BookSummary[] = [];
    for await (const page of this.iterateCatalog({
      maxPages: options.maxPages,
      pageSize: options.pageSize,
      signal: options.signal,
    })) {
      for (const book of page.items) {
        const fields = [book.title, book.titleEn ?? ""];
        if (options.includeDescription ?? true) {
          fields.push(book.descriptionHtml ? htmlToText(book.descriptionHtml) : "");
        }
        if (fields.some((field) => normalizeSearch(field).includes(needle))) results.push(book);
      }
    }
    return results;
  }

  public async getBook(input: string, signal?: AbortSignal): Promise<BookDetails> {
    const slug = slugFromBookInput(input, this.baseUrl);
    const payload = await this.#source.fetchRoute(`/${slug}`, {
      signal,
      cacheTtlMs: this.#cacheTtls.bookTtlMs,
    });
    const rawBook = extractBookFromPayload(payload);
    if (rawBook === null) {
      throw new InvalidPayloadError("RanobeRF book page has no book payload.", { slug });
    }
    return normalizeBookDetails(rawBook, this.baseUrl);
  }

  public async getChapters(input: string, signal?: AbortSignal): Promise<ChapterSummary[]> {
    return (await this.getBook(input, signal)).chapters;
  }

  public async getChapter(
    bookOrChapterInput: string,
    chapterInputOrOptions?: string | GetChapterOptions,
    maybeOptions: GetChapterOptions = {},
  ): Promise<ChapterDetails> {
    const chapterInput = typeof chapterInputOrOptions === "string" ? chapterInputOrOptions : undefined;
    const options =
      typeof chapterInputOrOptions === "object" && chapterInputOrOptions !== null
        ? chapterInputOrOptions
        : maybeOptions;
    const { bookSlug, chapterSlug } = chapterSlugsFromInput(
      bookOrChapterInput,
      chapterInput,
      this.baseUrl,
    );
    const route = `/${bookSlug}/${chapterSlug}`;
    const [payload, pageHtml] = await Promise.all([
      this.#source.fetchRoute(route, {
        signal: options.signal,
        cacheTtlMs: this.#cacheTtls.chapterTtlMs,
      }),
      options.includePageHtml
        ? this.#source.fetchPageHtml(route, {
            signal: options.signal,
            cacheTtlMs: this.#cacheTtls.pageHtmlTtlMs,
          })
        : Promise.resolve(null),
    ]);
    const rawChapter = extractChapterFromPayload(payload);
    if (rawChapter === null) {
      throw new InvalidPayloadError("RanobeRF chapter page has no chapter payload.", {
        bookSlug,
        chapterSlug,
      });
    }
    const chapter = normalizeChapterDetails(rawChapter, {
      baseUrl: this.baseUrl,
      bookSlug,
      pageHtml,
    });
    if (!chapter.available && !options.allowUnavailable) {
      throw new ChapterUnavailableError({
        bookSlug,
        chapterSlug,
        isDonate: chapter.isDonate,
        isSubscription: chapter.isSubscription,
        price: chapter.price,
      });
    }
    return chapter;
  }

  public async getChapterPageHtml(
    bookOrChapterInput: string,
    chapterInput?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { bookSlug, chapterSlug } = chapterSlugsFromInput(
      bookOrChapterInput,
      chapterInput,
      this.baseUrl,
    );
    return this.#source.fetchPageHtml(`/${bookSlug}/${chapterSlug}`, {
      signal,
      cacheTtlMs: this.#cacheTtls.pageHtmlTtlMs,
    });
  }

  public async *streamChapters(
    bookInput: string,
    options: StreamChaptersOptions = {},
  ): AsyncGenerator<ChapterDownloadResult, void, undefined> {
    const book = await this.getBook(bookInput, options.signal);
    const chapters = selectChapters(book.chapters, options);
    const concurrency = Math.max(
      1,
      Math.min(chapters.length || 1, Math.floor(options.concurrency ?? this.#defaultConcurrency)),
    );
    const running = new Map<number, Promise<ChapterDownloadResult>>();
    let nextToStart = 0;

    const start = (index: number): void => {
      const summary = chapters[index];
      if (!summary) return;
      const promise = this.getChapter(book.slug, summary.slug, options)
        .then<ChapterDownloadResult>((chapter) => ({
          index,
          summary,
          chapter,
          error: null,
        }))
        .catch<ChapterDownloadResult>((error: unknown) => ({
          index,
          summary,
          chapter: null,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      running.set(index, promise);
    };

    while (nextToStart < concurrency && nextToStart < chapters.length) {
      start(nextToStart);
      nextToStart += 1;
    }

    for (let index = 0; index < chapters.length; index += 1) {
      const promise = running.get(index);
      if (!promise) continue;
      const result = await promise;
      running.delete(index);
      if (nextToStart < chapters.length) {
        start(nextToStart);
        nextToStart += 1;
      }
      if (result.error && options.stopOnError) throw result.error;
      yield result;
    }
  }

  public async downloadBook(
    bookInput: string,
    options: StreamChaptersOptions = {},
  ): Promise<DownloadBookResult> {
    const book = await this.getBook(bookInput, options.signal);
    const chapters: ChapterDownloadResult[] = [];
    for await (const result of this.streamChapters(book.slug, options)) chapters.push(result);
    return {
      book,
      chapters,
      succeeded: chapters.filter((chapter) => chapter.error === null).length,
      failed: chapters.filter((chapter) => chapter.error !== null).length,
    };
  }
}

function searchParamsToQuery(params: URLSearchParams): QueryEntries {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    const current = result[key];
    if (current === undefined) result[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else result[key] = [current, value];
  }
  return result;
}

function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();
}

function selectChapters(
  source: ChapterSummary[],
  options: StreamChaptersOptions,
): ChapterSummary[] {
  let chapters = [...source];
  if (options.order === "ascending") {
    chapters.sort((left, right) => compareChapterNumbers(left, right));
  } else if (options.order === "descending") {
    chapters.sort((left, right) => compareChapterNumbers(right, left));
  }
  const from = Math.max(0, Math.floor(options.from ?? 0));
  const toExclusive =
    options.to === undefined ? chapters.length : Math.min(chapters.length, Math.floor(options.to) + 1);
  chapters = chapters.slice(from, Math.max(from, toExclusive));
  return chapters;
}

function compareChapterNumbers(left: ChapterSummary, right: ChapterSummary): number {
  const leftVolume = left.volume ?? 0;
  const rightVolume = right.volume ?? 0;
  if (leftVolume !== rightVolume) return leftVolume - rightVolume;
  const leftNumber = left.number ?? Number.MAX_SAFE_INTEGER;
  const rightNumber = right.number ?? Number.MAX_SAFE_INTEGER;
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.title.localeCompare(right.title, "ru");
}
