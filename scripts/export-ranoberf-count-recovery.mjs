import { mkdir, writeFile } from "node:fs/promises";
import { RanobeRfClient } from "../dist/index.js";

const OUTPUT_DIR = "out";
const MIN_CHAPTERS = 8;
const BASE_URL = "https://xn--80acm4afj.xn--p1ai";
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

function topKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 30) : [];
}

function looksLikeChapter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.some((key) => ["chapterShortNumber", "numberChapter", "chapterId", "isDonate", "isSubscription", "bookId"].includes(key));
}

function collectCountCandidates(value, context = "root", candidates = []) {
  if (Array.isArray(value)) {
    if (/chapter/i.test(context) || (value.length > 0 && value.slice(0, 3).some(looksLikeChapter))) {
      candidates.push({ count: value.length, confidence: 4, method: `Размер массива ${context}` });
    }
    for (let index = 0; index < Math.min(value.length, 5); index += 1) {
      collectCountCandidates(value[index], `${context}[${index}]`, candidates);
    }
    return candidates;
  }
  if (!value || typeof value !== "object") return candidates;

  for (const key of ["chapterCount", "chaptersCount", "countChapters", "totalChapters", "chaptersTotal"]) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) {
      candidates.push({ count: Math.trunc(number), confidence: 5, method: `Поле ${context}.${key}` });
    }
  }

  if (/chapter/i.test(context)) {
    for (const key of ["totalCount", "total", "count"]) {
      const number = Number(value[key]);
      if (Number.isFinite(number) && number >= 0) {
        candidates.push({ count: Math.trunc(number), confidence: 4, method: `Пагинация ${context}.${key}` });
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "rawHtml" || key === "description" || key === "content") continue;
    collectCountCandidates(child, `${context}.${key}`, candidates);
  }
  return candidates;
}

async function fetchProbe(path) {
  const url = new URL(path, `${BASE_URL}/`).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "catalog-count-recovery/2026-08-18",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text.trim() ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    const candidates = payload === null ? [] : collectCountCandidates(payload, path);
    candidates.sort((a, b) => b.confidence - a.confidence || b.count - a.count);
    return {
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      topKeys: topKeys(payload),
      bestCount: candidates[0] ?? null,
      bodyPreview: payload === null ? text.slice(0, 500) : "",
    };
  } catch (error) {
    return { url, error: String(error?.stack ?? error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeChapterCount(summary) {
  const id = encodeURIComponent(asText(summary.id));
  const slug = encodeURIComponent(summary.slug);
  const paths = [
    `/v3/books/${id}?expand=chapters,genres,country,lastChapter`,
    `/v3/books/${id}?expand=chapters`,
    `/v3/books/${slug}?expand=chapters`,
    `/v3/books/${id}/chapters?page=1&pageSize=10000`,
    `/v3/books/${id}/chapters?page=1&perPage=10000`,
    `/v3/chapters?bookId=${id}&page=1&pageSize=10000`,
    `/v3/chapters?book=${id}&page=1&pageSize=10000`,
    `/v3/chapters?filter%5BbookId%5D=${id}&page=1&pageSize=10000`,
    `/v2/books/${id}?expand=chapters`,
    `/v1/books/${id}?expand=chapters`,
  ];
  const probes = [];
  let best = null;
  for (const path of paths) {
    const probe = await fetchProbe(path);
    probes.push(probe);
    if (probe.bestCount && (!best || probe.bestCount.confidence > best.confidence || (probe.bestCount.confidence === best.confidence && probe.bestCount.count > best.count))) {
      best = probe.bestCount;
    }
    if (best?.confidence >= 5) break;
  }
  return { count: best?.count ?? null, method: best?.method ?? null, probes };
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
  userAgent: "catalog-count-recovery/2026-08-18",
});

const catalog = await client.listCatalog({ page: 1, pageSize: 10_000, source: "v3" });
if (catalog.pageInfo.totalCount !== null && catalog.items.length !== catalog.pageInfo.totalCount) {
  throw new Error(`Expected ${catalog.pageInfo.totalCount} catalog rows, got ${catalog.items.length}.`);
}

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
    let chapterCount = fallbackChapterCount(summary);
    let chapterCountMethod = chapterCount === null ? "" : "Номер последней главы из каталога; карточка книги недоступна (404)";
    let probe = null;
    if (chapterCount === null) {
      probe = await probeChapterCount(summary);
      chapterCount = probe.count;
      chapterCountMethod = probe.method ?? "Не удалось определить";
    }
    return {
      source: "RanobeRF",
      id: summary.id,
      slug: summary.slug,
      url: summary.url,
      title: summary.title,
      chapterCount,
      chapterCountMethod,
      originalReason: null,
      unavailableReason: "Карточка книги возвращает 404",
      lastChapter: summary.lastChapter,
      probe,
    };
  }

  return {
    source: "RanobeRF",
    id: book.id,
    slug: book.slug,
    url: book.url,
    title: book.title,
    chapterCount: book.chapters.length,
    chapterCountMethod: "Точный размер массива chapters в карточке книги",
    originalReason: originalReason(book),
    unavailableReason: "",
    country: book.country,
    genres: book.genres.map((genre) => genre.title),
  };
});
client.clearCache();

const unresolved = rows.filter((row) => !Number.isFinite(row.chapterCount));
const originalExcluded = rows.filter((row) => row.originalReason);
const underMinimum = rows.filter((row) => !row.originalReason && Number.isFinite(row.chapterCount) && row.chapterCount < MIN_CHAPTERS);
const included = rows.filter((row) => !row.originalReason && Number.isFinite(row.chapterCount) && row.chapterCount >= MIN_CHAPTERS);

const report = {
  generatedAt: new Date().toISOString(),
  minimumChapters: MIN_CHAPTERS,
  catalogTotalCount: catalog.pageInfo.totalCount,
  catalogRowsFetched: catalog.items.length,
  resolvedChapterCounts: rows.length - unresolved.length,
  unresolvedChapterCounts: unresolved.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    lastChapter: row.lastChapter,
    probe: row.probe,
  })),
  authorOriginalCandidates: originalExcluded.length,
  underMinimum: underMinimum.length,
  includedCandidateRows: included.length,
  possibleIncludedMinimum: included.length,
  possibleIncludedMaximum: included.length + unresolved.filter((row) => !row.originalReason).length,
  exact: unresolved.length === 0,
};

await Promise.all([
  writeFile(`${OUTPUT_DIR}/ranoberf_count_rows.jsonl`, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(`${OUTPUT_DIR}/ranoberf_count_report.json`, JSON.stringify(report, null, 2)),
]);
console.log(JSON.stringify(report, null, 2));
