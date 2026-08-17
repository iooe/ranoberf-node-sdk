export type UnknownRecord = Record<string, unknown>;
export type QueryValue = string | number | boolean | null | undefined;
export type QueryEntries = Record<string, QueryValue | readonly QueryValue[]>;

export interface Logger {
  debug(message: string, context?: UnknownRecord): void;
  info(message: string, context?: UnknownRecord): void;
  warn(message: string, context?: UnknownRecord): void;
  error(message: string, context?: UnknownRecord): void;
}

export interface CacheOptions {
  maxEntries?: number;
  buildIdTtlMs?: number;
  catalogTtlMs?: number;
  bookTtlMs?: number;
  chapterTtlMs?: number;
  pageHtmlTtlMs?: number;
}

export interface RanobeRfClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  userAgent?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxConcurrency?: number;
  minRequestIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  cache?: CacheOptions | false;
  logger?: Logger | null;
}

export interface PageInfo {
  totalCount: number | null;
  pageCount: number | null;
  currentPage: number;
  perPage: number | null;
}

export interface ImageAsset {
  id: number | string | null;
  url: string;
  path: string | null;
  name: string | null;
  alt: string | null;
  kind: "vertical" | "horizontal" | "square" | "content" | "unknown";
  raw: unknown;
}

export interface PersonRef {
  id: number | string | null;
  name: string | null;
  username: string | null;
  url: string | null;
  role: "translator" | "editor" | "creator" | "team" | "unknown";
  raw: unknown;
}

export interface ChapterSummary {
  id: number | string | null;
  bookId: number | string | null;
  slug: string;
  url: string;
  title: string;
  numberLabel: string | null;
  number: number | null;
  volume: number | null;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  views: number | null;
  price: number | null;
  isDonate: boolean;
  isSubscription: boolean;
  isSponsored: boolean;
  isEdited: boolean | null;
  isUserPaid: boolean | null;
  raw: unknown;
}

export interface BookSummary {
  id: number | string | null;
  slug: string;
  url: string;
  title: string;
  titleEn: string | null;
  descriptionHtml: string | null;
  status: string | null;
  views: number | null;
  likes: number | null;
  dislikes: number | null;
  lastChapter: ChapterSummary | null;
  images: ImageAsset[];
  raw: unknown;
}

export interface BookDetails extends BookSummary {
  fullTitle: string | null;
  fullTitleEn: string | null;
  author: string | null;
  country: {
    id: number | string | null;
    title: string | null;
    code: string | null;
    raw: unknown;
  } | null;
  genres: Array<{
    id: number | string | null;
    title: string;
    slug: string | null;
    raw: unknown;
  }>;
  additionalInfoHtml: string | null;
  importantInfoHtml: string | null;
  chapterCost: number | null;
  chapters: ChapterSummary[];
  contributors: PersonRef[];
}

export interface CatalogPage {
  items: BookSummary[];
  pageInfo: PageInfo;
  source: "v3" | "next";
  route: "/books" | "/";
  raw: unknown;
}

export interface CatalogQuery {
  page?: number;
  pageSize?: number;
  order?: string;
  route?: "/books" | "/";
  source?: "auto" | "v3" | "next";
  params?: QueryEntries;
  signal?: AbortSignal;
}

export interface SearchBooksOptions {
  maxPages?: number;
  pageSize?: number;
  includeDescription?: boolean;
  signal?: AbortSignal;
}

export interface CatalogIteratorOptions extends Omit<CatalogQuery, "page"> {
  startPage?: number;
  maxPages?: number;
}

export interface GetChapterOptions {
  includePageHtml?: boolean;
  allowUnavailable?: boolean;
  signal?: AbortSignal;
}

export interface ChapterContent {
  rawHtml: string;
  formattedHtml: string;
  text: string;
  symbolsCount: number | null;
  images: ImageAsset[];
}

export interface ChapterDetails extends ChapterSummary {
  status: string | null;
  editorId: number | string | null;
  translatorId: number | string | null;
  translators: PersonRef[];
  editors: PersonRef[];
  content: ChapterContent | null;
  available: boolean;
  pageHtml: string | null;
  book: Pick<BookSummary, "id" | "slug" | "url" | "title" | "titleEn"> | null;
  nextChapter: ChapterSummary | null;
  previousChapter: ChapterSummary | null;
}

export interface StreamChaptersOptions extends GetChapterOptions {
  concurrency?: number;
  from?: number;
  to?: number;
  order?: "source" | "ascending" | "descending";
  stopOnError?: boolean;
}

export interface ChapterDownloadResult {
  index: number;
  summary: ChapterSummary;
  chapter: ChapterDetails | null;
  error: Error | null;
}

export interface DownloadBookResult {
  book: BookDetails;
  chapters: ChapterDownloadResult[];
  succeeded: number;
  failed: number;
}

export interface TransportRequestOptions {
  signal?: AbortSignal;
  cacheTtlMs?: number;
  cacheKey?: string;
  accept?: string;
}
