import type {
  BookDetails,
  BookSummary,
  ChapterDetails,
  ChapterSummary,
  ImageAsset,
  PageInfo,
  PersonRef,
  UnknownRecord,
} from "./types.js";
import {
  absoluteUrl,
  asArray,
  asBoolean,
  asInteger,
  asNumber,
  asRecord,
  asString,
  firstId,
  firstString,
  isRecord,
  uniqueBy,
} from "./utils.js";
import { normalizeChapterHtml } from "./html.js";

export function extractPageProps(payload: unknown): UnknownRecord {
  return asRecord(asRecord(payload).pageProps);
}

export function extractCatalogData(payload: unknown): { items: unknown[]; pagesData: unknown } {
  const root = asRecord(payload);
  const props = extractPageProps(payload);
  const candidates = [root, root.totalData, props.totalData, props.books, props.data, props.catalog, props];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (Array.isArray(record.items)) {
      return { items: record.items, pagesData: record.pagesData ?? record.pagination ?? null };
    }
    if (Array.isArray(record.data)) {
      return { items: record.data, pagesData: record.pagesData ?? record.pagination ?? null };
    }
  }
  return { items: [], pagesData: null };
}

export function normalizePageInfo(raw: unknown, fallbackPage: number): PageInfo {
  const record = asRecord(raw);
  return {
    totalCount: asInteger(record.totalCount ?? record.total),
    pageCount: asInteger(record.pageCount ?? record.pages),
    currentPage: asInteger(record.currentPage ?? record.page) ?? fallbackPage,
    perPage: asInteger(record.perPage ?? record.pageSize ?? record.limit),
  };
}

export function normalizeBookSummary(raw: unknown, baseUrl: string): BookSummary {
  const record = asRecord(raw);
  const slug = bookSlug(record, baseUrl);
  const url = absoluteUrl(asString(record.url) ?? `/${slug}`, baseUrl) ?? `${baseUrl}/${slug}`;
  return {
    id: firstId(record.id, record.bookId),
    slug,
    url,
    title: firstString(record.title, record.name) ?? slug,
    titleEn: firstString(record.titleEn, record.title_en, record.englishTitle),
    descriptionHtml: asString(record.description),
    status: asString(record.status),
    views: asInteger(record.views),
    likes: asInteger(record.likes),
    dislikes: asInteger(record.dislikes),
    lastChapter: isRecord(record.lastChapter)
      ? normalizeChapterSummary(record.lastChapter, baseUrl, slug)
      : null,
    images: normalizeBookImages(record, baseUrl),
    raw,
  };
}

export function normalizeBookDetails(raw: unknown, baseUrl: string): BookDetails {
  const record = asRecord(raw);
  const summary = normalizeBookSummary(record, baseUrl);
  const countryRecord = isRecord(record.country) ? record.country : null;
  const contributors = [
    ...extractPeople(record, "translator"),
    ...extractPeople(record, "editor"),
    ...extractPeople(record, "creator"),
    ...extractPeople(record, "team"),
  ];
  return {
    ...summary,
    fullTitle: firstString(record.fullTitle, record.full_title),
    fullTitleEn: firstString(record.fullTitleEn, record.full_title_en),
    author: firstString(record.author, record.authorName),
    country: countryRecord
      ? {
          id: firstId(countryRecord.id),
          title: firstString(countryRecord.title, countryRecord.name),
          code: firstString(countryRecord.code, countryRecord.slug),
          raw: countryRecord,
        }
      : null,
    genres: asArray(record.genres)
      .filter(isRecord)
      .map((genre) => ({
        id: firstId(genre.id),
        title: firstString(genre.title, genre.name) ?? "",
        slug: firstString(genre.slug, genre.code),
        raw: genre,
      }))
      .filter((genre) => genre.title !== ""),
    additionalInfoHtml: asString(record.additionalInfo),
    importantInfoHtml: asString(record.importantInfo),
    chapterCost: asNumber(record.chapterCost),
    chapters: asArray(record.chapters).map((chapter) =>
      normalizeChapterSummary(chapter, baseUrl, summary.slug),
    ),
    contributors: uniquePeople(contributors),
  };
}

export function normalizeChapterSummary(
  raw: unknown,
  baseUrl: string,
  fallbackBookSlug = "",
): ChapterSummary {
  const record = asRecord(raw);
  const rawUrl = asString(record.url);
  const slug = firstString(record.slug, lastPathSegment(rawUrl)) ?? "";
  const inferredBookSlug = firstString(
    asString(asRecord(record.book).slug),
    firstPathSegment(rawUrl),
    fallbackBookSlug,
  ) ?? "";
  const path = rawUrl ?? `/${inferredBookSlug}/${slug}`;
  return {
    id: firstId(record.id, record.chapterId),
    bookId: firstId(record.bookId, asRecord(record.book).id),
    slug,
    url: absoluteUrl(path, baseUrl) ?? `${baseUrl}/${inferredBookSlug}/${slug}`,
    title: firstString(record.title, record.name) ?? slug,
    numberLabel: firstString(record.numberChapter, record.numberLabel),
    number:
      asNumber(record.chapterShortNumber ?? record.number) ??
      parseChapterNumber(firstString(record.numberChapter, record.title)),
    volume: asNumber(record.tom ?? record.volume),
    publishedAt: firstString(record.publishedAt, record.published_at),
    createdAt: firstString(record.createdAt, record.created_at),
    updatedAt: firstString(record.updatedAt, record.updated_at),
    views: asInteger(record.views),
    price: asNumber(record.price),
    isDonate: asBoolean(record.isDonate),
    isSubscription: asBoolean(record.isSubscription),
    isSponsored: asBoolean(record.isSponsored),
    isEdited: record.isEdited === undefined ? null : asBoolean(record.isEdited),
    isUserPaid: record.isUserPaid === undefined ? null : asBoolean(record.isUserPaid),
    raw,
  };
}

export function normalizeChapterDetails(
  raw: unknown,
  options: {
    baseUrl: string;
    bookSlug: string;
    pageHtml: string | null;
  },
): ChapterDetails {
  const record = asRecord(raw);
  const summary = normalizeChapterSummary(record, options.baseUrl, options.bookSlug);
  const contentRecord = asRecord(record.content);
  const rawHtml = asString(contentRecord.text);
  const normalized = rawHtml === null ? null : normalizeChapterHtml(rawHtml, options.baseUrl);
  const translatorId = firstId(record.translatorId, asRecord(record.translator).id);
  const editorId = firstId(record.editorId, asRecord(record.editor).id);
  const translators = extractPeople(record, "translator");
  const editors = extractPeople(record, "editor");
  if (translatorId !== null && !translators.some((person) => person.id === translatorId)) {
    translators.push({
      id: translatorId,
      name: null,
      username: null,
      url: null,
      role: "translator",
      raw: null,
    });
  }
  if (editorId !== null && !editors.some((person) => person.id === editorId)) {
    editors.push({
      id: editorId,
      name: null,
      username: null,
      url: null,
      role: "editor",
      raw: null,
    });
  }
  const bookRecord = asRecord(record.book);
  const bookSlug = firstString(bookRecord.slug, firstPathSegment(asString(bookRecord.url)), options.bookSlug);
  return {
    ...summary,
    status: asString(record.status),
    editorId,
    translatorId,
    translators: uniquePeople(translators),
    editors: uniquePeople(editors),
    content:
      rawHtml === null || normalized === null
        ? null
        : {
            rawHtml,
            formattedHtml: normalized.formattedHtml,
            text: normalized.text,
            symbolsCount: asInteger(contentRecord.symbolsCount),
            images: normalized.images,
          },
    available: rawHtml !== null,
    pageHtml: options.pageHtml,
    book:
      Object.keys(bookRecord).length > 0
        ? {
            id: firstId(bookRecord.id, record.bookId),
            slug: bookSlug ?? options.bookSlug,
            url:
              absoluteUrl(asString(bookRecord.url) ?? `/${bookSlug ?? options.bookSlug}`, options.baseUrl) ??
              `${options.baseUrl}/${bookSlug ?? options.bookSlug}`,
            title: firstString(bookRecord.title, bookRecord.name) ?? options.bookSlug,
            titleEn: firstString(bookRecord.titleEn, bookRecord.title_en),
          }
        : null,
    nextChapter: isRecord(record.nextChapter)
      ? normalizeChapterSummary(record.nextChapter, options.baseUrl, options.bookSlug)
      : null,
    previousChapter: isRecord(record.previousChapter)
      ? normalizeChapterSummary(record.previousChapter, options.baseUrl, options.bookSlug)
      : null,
  };
}

export function extractBookFromPayload(payload: unknown): unknown {
  const props = extractPageProps(payload);
  for (const candidate of [props.book, props.data, asRecord(props.totalData).book]) {
    if (isRecord(candidate) && Object.keys(candidate).length > 0) return candidate;
  }
  return null;
}

export function extractChapterFromPayload(payload: unknown): unknown {
  const props = extractPageProps(payload);
  for (const candidate of [props.chapter, props.data, asRecord(props.totalData).chapter]) {
    if (isRecord(candidate) && Object.keys(candidate).length > 0) return candidate;
  }
  return null;
}

function normalizeBookImages(record: UnknownRecord, baseUrl: string): ImageAsset[] {
  const values: Array<[unknown, ImageAsset["kind"]]> = [
    [record.verticalImage, "vertical"],
    [record.horizontalImage, "horizontal"],
    [record.squareImage, "square"],
    [record.imageVertical, "vertical"],
    [record.imageHorizontal, "horizontal"],
    [record.imageSquare, "square"],
  ];
  const output: ImageAsset[] = [];
  for (const [raw, kind] of values) {
    if (!isRecord(raw)) continue;
    const url = absoluteUrl(firstString(raw.url, raw.path), baseUrl);
    if (!url) continue;
    output.push({
      id: firstId(raw.id),
      url,
      path: asString(raw.path),
      name: asString(raw.name),
      alt: asString(raw.alt),
      kind,
      raw,
    });
  }
  return uniqueBy(output, (image) => image.url);
}

function extractPeople(record: UnknownRecord, role: PersonRef["role"]): PersonRef[] {
  const roleKeys: Record<PersonRef["role"], string[]> = {
    translator: ["translator", "translators", "translationTeam", "translationTeams"],
    editor: ["editor", "editors", "redactor", "redactors"],
    creator: ["creator", "creators", "authorUser"],
    team: ["team", "teams", "translationGroup", "translationGroups"],
    unknown: [],
  };
  const output: PersonRef[] = [];
  for (const key of roleKeys[role]) {
    const raw = record[key];
    const candidates = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const person = normalizePerson(candidate, role);
      if (person.id !== null || person.name !== null || person.username !== null) output.push(person);
    }
  }
  return output;
}

function normalizePerson(raw: UnknownRecord, role: PersonRef["role"]): PersonRef {
  return {
    id: firstId(raw.id, raw.userId, raw.teamId),
    name: firstString(raw.displayName, raw.name, raw.title, raw.fullName),
    username: firstString(raw.username, raw.login, raw.nickname, raw.slug),
    url: firstString(raw.url, raw.profileUrl),
    role,
    raw,
  };
}

function uniquePeople(values: PersonRef[]): PersonRef[] {
  return uniqueBy(values, (person) =>
    [person.role, person.id ?? "", person.username ?? "", person.name ?? ""].join(":"),
  );
}

function bookSlug(record: UnknownRecord, baseUrl: string): string {
  const direct = firstString(record.slug);
  if (direct) return direct;
  const url = asString(record.url);
  if (url) {
    try {
      const path = new URL(url, `${baseUrl}/`).pathname;
      const segment = path.split("/").filter(Boolean)[0];
      if (segment) return decodeURIComponent(segment);
    } catch {
      // Fall through to ID-based slug.
    }
  }
  return String(firstId(record.id, record.bookId) ?? "unknown-book");
}

function parseChapterNumber(value: string | null): number | null {
  if (!value) return null;
  const match = /(?:глава|chapter)\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number(match[1].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstPathSegment(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value, "https://example.invalid/").pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)[0] ?? null;
  } catch {
    return null;
  }
}

function lastPathSegment(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value, "https://example.invalid/").pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
      .at(-1) ?? null;
  } catch {
    return null;
  }
}
