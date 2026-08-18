import { mkdir, writeFile } from "node:fs/promises";
import { RanobeRfClient } from "../dist/index.js";

const OUTPUT_DIR = "out";
const MIN_CHAPTERS = 8;
await mkdir(OUTPUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(values, concurrency, worker) {
  const output = new Array(values.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length || 1) }, run));
  return output;
}

function asText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function normalized(value) {
  return asText(value).trim().toLocaleLowerCase("ru");
}

function stripHtml(value) {
  return asText(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function explicitBooleanFlag(raw, keys) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  for (const key of keys) {
    if (raw[key] === true || raw[key] === 1 || raw[key] === "1") return key;
  }
  return null;
}

function originalReason(book) {
  const code = normalized(book.country?.code);
  const country = normalized(book.country?.title);
  if (["ru", "rus", "russia", "russian"].includes(code) || /росси|русск/.test(country)) {
    return `Страна произведения: ${book.country?.title || book.country?.code}`;
  }
  const genreText = normalized(book.genres.map((genre) => genre.title).join(" "));
  if (/авторск|оригинальн(?:ое|ая)\s+произвед/.test(genreText)) return "Жанр/тип помечен как авторское произведение";
  const flag = explicitBooleanFlag(book.raw, [
    "isAuthorWork", "isAuthorBook", "isOriginalWork", "isUserOriginal", "authorWork", "originalWork",
  ]);
  if (flag) return `Явный флаг ${flag}=true`;
  const info = normalized(`${stripHtml(book.additionalInfoHtml)} ${stripHtml(book.importantInfoHtml)}`);
  if (/авторское\s+произведение|оригинальное\s+произведение\s+пользователя/.test(info)) return "Явная пометка в информации книги";
  const typeValue = book.raw && typeof book.raw === "object" && !Array.isArray(book.raw)
    ? [book.raw.type, book.raw.bookType, book.raw.originType, book.raw.categoryType].filter(Boolean).join(" ")
    : "";
  if (/авторск|user[-_ ]?original|author[-_ ]?work/i.test(asText(typeValue))) return `Тип книги: ${typeValue}`;
  return null;
}

function isNotFound(error) {
  return error && typeof error === "object" && (error.code === "NOT_FOUND" || error.status === 404);
}

function fallbackChapterCount(summary) {
  if (Number.isFinite(summary.lastChapter?.number)) {
    return Math.max(0, Math.trunc(summary.lastChapter.number));
  }
  const text = `${summary.lastChapter?.numberLabel ?? ""} ${summary.lastChapter?.title ?? ""}`;
  const matches = [...text.matchAll(/(?:глава|chapter)?\s*(\d+(?:[.,]\d+)?)/gi)];
  if (matches.length === 0) return null;
  const value = Number(matches.at(-1)[1].replace(",", "."));
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

const client = new RanobeRfClient({
  maxConcurrency: 12,
  minRequestIntervalMs: 90,
  timeoutMs: 60_000,
  maxResponseBytes: 96 * 1024 * 1024,
  maxRetries: 7,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 30_000,
  cache: false,
  userAgent: "catalog-audit-ranoberf/2026-08-18",
});

const catalog = await client.listCatalog({ page: 1, pageSize: 10_000, source: "v3" });
if (catalog.pageInfo.totalCount !== null && catalog.items.length !== catalog.pageInfo.totalCount) {
  throw new Error(`Expected ${catalog.pageInfo.totalCount} catalog rows, got ${catalog.items.length}.`);
}

const countryCounts = new Map();
const unavailable = [];
const rows = await mapLimit(catalog.items, 12, async (summary, index) => {
  let book = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      book = await client.getBook(summary.slug);
      break;
    } catch (error) {
      lastError = error;
      if (isNotFound(error)) break;
      if (attempt < 3) await sleep(attempt * 1_500 + Math.round(Math.random() * 500));
    }
  }

  if (!book) {
    if (!isNotFound(lastError)) throw lastError;
    const fallbackCount = fallbackChapterCount(summary);
    const row = {
      source: "RanobeRF",
      id: summary.id,
      slug: summary.slug,
      url: summary.url,
      title: summary.title,
      titleEn: summary.titleEn ?? "",
      descriptionHtml: summary.descriptionHtml ?? "",
      fullTitle: "",
      fullTitleEn: "",
      chapterCount: fallbackCount,
      chapterCountMethod: "Номер последней главы из каталога; карточка книги недоступна (404)",
      author: "",
      country: "",
      countryCode: "",
      genres: [],
      status: summary.status ?? "",
      views: summary.views,
      likes: summary.likes,
      dislikes: summary.dislikes,
      chapterCost: null,
      lastChapterTitle: summary.lastChapter?.title ?? "",
      lastChapterNumber: summary.lastChapter?.number,
      lastChapterPublishedAt: summary.lastChapter?.publishedAt ?? "",
      posterUrl: summary.images.find((image) => image.kind === "vertical")?.url ?? summary.images[0]?.url ?? "",
      originalReason: null,
      unavailableReason: "Карточка книги возвращает 404",
    };
    unavailable.push({ slug: summary.slug, id: summary.id, title: summary.title, chapterCount: fallbackCount });
    return row;
  }

  const countryKey = `${book.country?.code ?? ""}|${book.country?.title ?? "Не указана"}`;
  countryCounts.set(countryKey, (countryCounts.get(countryKey) ?? 0) + 1);
  return {
    source: "RanobeRF",
    id: book.id,
    slug: book.slug,
    url: book.url,
    title: book.title,
    titleEn: book.titleEn ?? "",
    descriptionHtml: book.descriptionHtml ?? "",
    fullTitle: book.fullTitle ?? "",
    fullTitleEn: book.fullTitleEn ?? "",
    chapterCount: book.chapters.length,
    chapterCountMethod: "Точный размер массива chapters в карточке книги",
    author: book.author ?? "",
    country: book.country?.title ?? "",
    countryCode: book.country?.code ?? "",
    genres: book.genres.map((genre) => genre.title),
    status: book.status ?? "",
    views: book.views,
    likes: book.likes,
    dislikes: book.dislikes,
    chapterCost: book.chapterCost,
    lastChapterTitle: book.lastChapter?.title ?? "",
    lastChapterNumber: book.lastChapter?.number,
    lastChapterPublishedAt: book.lastChapter?.publishedAt ?? "",
    posterUrl: book.images.find((image) => image.kind === "vertical")?.url ?? book.images[0]?.url ?? "",
    originalReason: originalReason(book),
    unavailableReason: "",
  };
});

const unresolved = rows.filter((row) => !Number.isFinite(row.chapterCount));
if (unresolved.length > 0) {
  throw new Error(`${unresolved.length} RanobeRF catalog rows have no usable chapter count: ${unresolved.map((row) => row.slug).join(", ")}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  minimumChapters: MIN_CHAPTERS,
  source: catalog.source,
  catalogTotalCount: catalog.pageInfo.totalCount,
  catalogRowsFetched: catalog.items.length,
  resolvedBookDetails: rows.length - unavailable.length,
  unavailableBookCards: unavailable,
  countryDistribution: Object.fromEntries([...countryCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  authorOriginalCandidates: rows.filter((row) => row.originalReason).length,
  underMinimum: rows.filter((row) => !row.originalReason && row.chapterCount < MIN_CHAPTERS).length,
  includedCandidateRows: rows.filter((row) => !row.originalReason && row.chapterCount >= MIN_CHAPTERS).length,
};

await Promise.all([
  writeFile(`${OUTPUT_DIR}/ranoberf_all.jsonl`, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(`${OUTPUT_DIR}/ranoberf_report.json`, JSON.stringify(report, null, 2)),
]);
console.log(JSON.stringify(report, null, 2));