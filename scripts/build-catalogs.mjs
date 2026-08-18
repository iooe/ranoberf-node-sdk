import { mkdir, writeFile } from "node:fs/promises";
import { RanobeRfClient } from "../dist/index.js";
import { RulateClient } from "../../rulate-node-sdk/dist/index.js";

const OUTPUT_DIR = "out";
const MIN_CHAPTERS = 8;
const GENERATED_AT = new Date().toISOString();
const RULATE_SORT = "2"; // Stable translated-title ordering.
const RULATE_SECTIONS = [
  { id: 2, name: "Книги" },
  { id: 44, name: "AI-переводы вебновелл" },
];

await mkdir(OUTPUT_DIR, { recursive: true });

const report = {
  generatedAt: GENERATED_AT,
  minimumChapters: MIN_CHAPTERS,
  rules: {
    rulate: "Server-side type=1 (Только переводы); catalog sections 2 and 44; exact catalog chapter total >= 8.",
    ranoberf: "All /v3/books entries; exact book.chapters.length >= 8; explicit local/original-work indicators excluded.",
  },
  rulate: {},
  ranoberf: {},
  validation: {},
};

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

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : asText(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, columns) {
  const lines = [columns.map((column) => csvCell(column.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function decodeEntities(value) {
  return asText(value)
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripHtml(value) {
  return decodeEntities(asText(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => asText(value).trim()).filter(Boolean))];
}

function normalizeForSort(value) {
  return asText(value).trim().toLocaleLowerCase("ru");
}

function sortBooks(rows) {
  return rows.sort((a, b) => {
    const title = normalizeForSort(a.title).localeCompare(normalizeForSort(b.title), "ru");
    if (title !== 0) return title;
    return asText(a.id).localeCompare(asText(b.id), "en", { numeric: true });
  });
}

function extractRulateLeafCategory(rawHtml) {
  const match = /<small[^>]*class=["'][^"']*\bcat\b[^"']*["'][^>]*>([\s\S]*?)<\/small>/i.exec(rawHtml);
  return match ? stripHtml(match[1]) : "";
}

function rulateOriginalSafetyReason(rawHtml, leafCategory) {
  const category = normalizeForSort(leafCategory);
  if (/авторск/.test(category)) return `Категория: ${leafCategory}`;
  const plain = stripHtml(rawHtml);
  if (/(?:^|\s)Автор\s+от(?:\s|:)/i.test(plain)) return "Маркер «Автор от»";
  if (/авторское\s+произведение/i.test(plain)) return "Маркер авторского произведения";
  return null;
}

function mergeRulateBook(previous, next) {
  if (!previous) return next;
  const previousCount = Number.isFinite(previous.chapterCount) ? previous.chapterCount : null;
  const nextCount = Number.isFinite(next.chapterCount) ? next.chapterCount : null;
  return {
    ...previous,
    ...next,
    chapterCount:
      previousCount === null ? nextCount : nextCount === null ? previousCount : Math.max(previousCount, nextCount),
    paidChapterCount: Math.max(previous.paidChapterCount ?? 0, next.paidChapterCount ?? 0) || null,
    catalogSections: uniqueStrings([...(previous.catalogSections ?? []), ...(next.catalogSections ?? [])]),
    leafCategories: uniqueStrings([...(previous.leafCategories ?? []), ...(next.leafCategories ?? [])]),
    genres: uniqueStrings([...(previous.genres ?? []), ...(next.genres ?? [])]),
    tags: uniqueStrings([...(previous.tags ?? []), ...(next.tags ?? [])]),
  };
}

let rulateSearchRequests = 0;
let rulateFilterViolations = 0;
const rulateFetch = async (input, init) => {
  const originalUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(originalUrl);
  if (url.hostname === "tl.rulate.ru" && url.pathname.startsWith("/search")) {
    url.searchParams.set("type", "1");
    rulateSearchRequests += 1;
    if (url.searchParams.get("type") !== "1") rulateFilterViolations += 1;
  }
  return globalThis.fetch(url, init);
};

const rulate = new RulateClient({
  fetch: rulateFetch,
  maxConcurrency: 6,
  minRequestIntervalMs: 220,
  timeoutMs: 60_000,
  maxResponseBytes: 12 * 1024 * 1024,
  maxRetries: 7,
  retryBaseDelayMs: 800,
  retryMaxDelayMs: 45_000,
  metadataCacheTtlMs: 0,
  chapterCacheTtlMs: 0,
  userAgent: "catalog-audit/2026-08-18 (+https://github.com/iooe/rulate-node-sdk)",
});

const rulateAll = new Map();
const rulateDuplicateIds = new Set();
const rulateSafetyExcluded = [];
const rulateSectionReports = [];

function consumeRulatePage(page, section) {
  for (const item of page.items) {
    const leafCategory = extractRulateLeafCategory(item.rawHtml);
    const safetyReason = rulateOriginalSafetyReason(item.rawHtml, leafCategory);
    const compact = {
      source: "Rulate",
      id: item.id,
      url: item.url,
      title: item.title,
      originalTitle: item.originalTitle ?? "",
      chapterCount: item.chapters.total,
      paidChapterCount: item.chapters.paid,
      catalogSections: [section.name],
      leafCategories: leafCategory ? [leafCategory] : [],
      genres: item.genres,
      tags: item.tags,
      status: item.status ?? "",
      lastActivityAt: item.lastActivityAt ?? "",
      rating: item.rating.value,
      ratingVotes: item.rating.votes,
      translationRating: item.translationRating.value,
      translationRatingVotes: item.translationRating.votes,
      likes: item.likes,
      translator: item.translator?.name ?? "",
      posterUrl: item.poster?.url ?? "",
      authorshipFilter: "type=1 (Только переводы)",
    };
    if (safetyReason) {
      rulateSafetyExcluded.push({ ...compact, exclusionReason: safetyReason });
      continue;
    }
    if (rulateAll.has(item.id)) rulateDuplicateIds.add(item.id);
    rulateAll.set(item.id, mergeRulateBook(rulateAll.get(item.id), compact));
  }
}

async function fetchRulateCatalogPage(section, pageNumber) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const page = await rulate.getCatalog({
        page: pageNumber,
        category: section.id,
        sort: RULATE_SORT,
        refresh: true,
      });
      if (page.page !== pageNumber) throw new Error(`Expected page ${pageNumber}, got ${page.page}.`);
      return page;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 2_000 + Math.round(Math.random() * 1_000));
    }
  }
  throw lastError;
}

for (const section of RULATE_SECTIONS) {
  console.log(`[Rulate] Reading section ${section.id} (${section.name})...`);
  const firstPage = await fetchRulateCatalogPage(section, 1);
  if (firstPage.totalPages === null || firstPage.totalPages < 1) {
    throw new Error(`Rulate section ${section.id} did not expose a finite total page count.`);
  }
  const totalPages = firstPage.totalPages;
  consumeRulatePage(firstPage, section);
  let completed = 1;
  let rawItems = firstPage.items.length;
  const remainingPages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2);
  await mapLimit(remainingPages, 10, async (pageNumber) => {
    const page = await fetchRulateCatalogPage(section, pageNumber);
    if (page.items.length === 0 && pageNumber < totalPages) {
      throw new Error(`Rulate section ${section.id} page ${pageNumber}/${totalPages} unexpectedly returned zero items.`);
    }
    consumeRulatePage(page, section);
    rawItems += page.items.length;
    completed += 1;
    if (completed % 100 === 0 || completed === totalPages) {
      console.log(`[Rulate] ${section.name}: ${completed}/${totalPages} pages; ${rawItems} raw rows.`);
    }
  });
  rulateSectionReports.push({
    id: section.id,
    name: section.name,
    totalPages,
    fetchedPages: completed,
    rawItems,
    firstPageItems: firstPage.items.length,
  });
}

const unresolvedRulate = [...rulateAll.values()].filter((book) => !Number.isFinite(book.chapterCount));
if (unresolvedRulate.length > 0) {
  console.log(`[Rulate] Resolving ${unresolvedRulate.length} missing chapter totals from book pages...`);
  await mapLimit(unresolvedRulate, 4, async (compact, index) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const details = await rulate.getBook(compact.id, { refresh: true });
        compact.chapterCount = details.chapterStats.total;
        compact.paidChapterCount = details.chapterStats.paid;
        if ((index + 1) % 100 === 0 || index + 1 === unresolvedRulate.length) {
          console.log(`[Rulate] Resolved ${index + 1}/${unresolvedRulate.length} missing chapter totals.`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 2_000);
      }
    }
    compact.chapterResolutionError = String(lastError?.stack ?? lastError);
  });
}

const stillUnresolvedRulate = [...rulateAll.values()].filter((book) => !Number.isFinite(book.chapterCount));
if (stillUnresolvedRulate.length > 0) {
  await writeFile(`${OUTPUT_DIR}/rulate-unresolved.json`, JSON.stringify(stillUnresolvedRulate, null, 2));
  throw new Error(`Rulate has ${stillUnresolvedRulate.length} books with unresolved chapter totals.`);
}

const rulateIncluded = sortBooks([...rulateAll.values()].filter((book) => book.chapterCount >= MIN_CHAPTERS));
const rulateUnderEight = sortBooks([...rulateAll.values()].filter((book) => book.chapterCount < MIN_CHAPTERS).map((book) => ({
  ...book,
  exclusionReason: `Меньше ${MIN_CHAPTERS} глав`,
})));

rulate.close();

const ranobeRf = new RanobeRfClient({
  maxConcurrency: 12,
  minRequestIntervalMs: 90,
  timeoutMs: 60_000,
  maxResponseBytes: 96 * 1024 * 1024,
  maxRetries: 7,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 30_000,
  cache: false,
  userAgent: "catalog-audit/2026-08-18 (+https://github.com/iooe/ranoberf-node-sdk)",
});

console.log("[RanobeRF] Reading complete v3 catalog...");
const ranobeRfPage = await ranobeRf.listCatalog({ page: 1, pageSize: 10_000, source: "v3" });
if (ranobeRfPage.pageInfo.totalCount !== null && ranobeRfPage.items.length !== ranobeRfPage.pageInfo.totalCount) {
  throw new Error(`RanobeRF expected ${ranobeRfPage.pageInfo.totalCount} catalog rows, received ${ranobeRfPage.items.length}.`);
}

const ranobeRfCountryCounts = new Map();
const ranobeRfRawKeyCounts = new Map();

function countTopLevelKeys(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const key of Object.keys(raw)) ranobeRfRawKeyCounts.set(key, (ranobeRfRawKeyCounts.get(key) ?? 0) + 1);
}

function explicitBooleanFlag(raw, keys) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  for (const key of keys) {
    if (raw[key] === true || raw[key] === 1 || raw[key] === "1") return key;
  }
  return null;
}

function ranobeRfOriginalReason(book) {
  const code = normalizeForSort(book.country?.code);
  const country = normalizeForSort(book.country?.title);
  if (["ru", "rus", "russia", "russian"].includes(code) || /росси|русск/.test(country)) {
    return `Страна произведения: ${book.country?.title || book.country?.code}`;
  }
  const genreText = normalizeForSort(book.genres.map((genre) => genre.title).join(" "));
  if (/авторск|оригинальн(?:ое|ая)\s+произвед/.test(genreText)) return "Жанр/тип помечен как авторское произведение";
  const flag = explicitBooleanFlag(book.raw, [
    "isAuthorWork",
    "isAuthorBook",
    "isOriginalWork",
    "isUserOriginal",
    "authorWork",
    "originalWork",
  ]);
  if (flag) return `Явный флаг ${flag}=true`;
  const info = normalizeForSort(`${stripHtml(book.additionalInfoHtml)} ${stripHtml(book.importantInfoHtml)}`);
  if (/авторское\s+произведение|оригинальное\s+произведение\s+пользователя/.test(info)) {
    return "Явная пометка в информации книги";
  }
  const typeValue = book.raw && typeof book.raw === "object" && !Array.isArray(book.raw)
    ? [book.raw.type, book.raw.bookType, book.raw.originType, book.raw.categoryType].filter(Boolean).join(" ")
    : "";
  if (/авторск|user[-_ ]?original|author[-_ ]?work/i.test(asText(typeValue))) return `Тип книги: ${typeValue}`;
  return null;
}

const ranobeRfRows = await mapLimit(ranobeRfPage.items, 12, async (summary, index) => {
  let book;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      book = await ranobeRf.getBook(summary.slug);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 1_500 + Math.round(Math.random() * 500));
    }
  }
  if (!book) throw lastError;
  countTopLevelKeys(book.raw);
  const countryKey = `${book.country?.code ?? ""}|${book.country?.title ?? "Не указана"}`;
  ranobeRfCountryCounts.set(countryKey, (ranobeRfCountryCounts.get(countryKey) ?? 0) + 1);
  if ((index + 1) % 50 === 0 || index + 1 === ranobeRfPage.items.length) {
    console.log(`[RanobeRF] ${index + 1}/${ranobeRfPage.items.length} book pages.`);
  }
  const originalReason = ranobeRfOriginalReason(book);
  return {
    source: "RanobeRF",
    id: book.id,
    slug: book.slug,
    url: book.url,
    title: book.title,
    titleEn: book.titleEn ?? "",
    fullTitle: book.fullTitle ?? "",
    fullTitleEn: book.fullTitleEn ?? "",
    chapterCount: book.chapters.length,
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
    originalReason,
  };
});

const ranobeRfOriginals = sortBooks(ranobeRfRows.filter((book) => book.originalReason).map((book) => ({
  ...book,
  exclusionReason: book.originalReason,
})));
const ranobeRfNonOriginals = ranobeRfRows.filter((book) => !book.originalReason);
const ranobeRfIncluded = sortBooks(ranobeRfNonOriginals.filter((book) => book.chapterCount >= MIN_CHAPTERS));
const ranobeRfUnderEight = sortBooks(ranobeRfNonOriginals.filter((book) => book.chapterCount < MIN_CHAPTERS).map((book) => ({
  ...book,
  exclusionReason: `Меньше ${MIN_CHAPTERS} глав`,
})));

const rulateColumns = [
  ["source", "Источник"], ["id", "ID"], ["title", "Название"], ["originalTitle", "Оригинальное название"],
  ["url", "URL"], ["chapterCount", "Глав"], ["paidChapterCount", "Платных глав"], ["catalogSections", "Раздел каталога"],
  ["leafCategories", "Категория"], ["genres", "Жанры"], ["tags", "Теги"], ["status", "Статус перевода"],
  ["lastActivityAt", "Последняя активность"], ["rating", "Рейтинг"], ["ratingVotes", "Оценок"],
  ["translationRating", "Качество перевода"], ["translationRatingVotes", "Оценок перевода"], ["likes", "Лайки"],
  ["translator", "Переводчик/команда"], ["posterUrl", "Постер"], ["authorshipFilter", "Фильтр авторского"],
].map(([key, header]) => ({ key, header }));

const ranobeRfColumns = [
  ["source", "Источник"], ["id", "ID"], ["slug", "Slug"], ["title", "Название"], ["titleEn", "Название EN"],
  ["fullTitle", "Полное название"], ["fullTitleEn", "Полное название EN"], ["url", "URL"], ["chapterCount", "Глав"],
  ["author", "Автор"], ["country", "Страна"], ["countryCode", "Код страны"], ["genres", "Жанры"], ["status", "Статус"],
  ["views", "Просмотры"], ["likes", "Лайки"], ["dislikes", "Дизлайки"], ["chapterCost", "Цена главы"],
  ["lastChapterTitle", "Последняя глава"], ["lastChapterNumber", "Номер последней главы"],
  ["lastChapterPublishedAt", "Дата последней главы"], ["posterUrl", "Постер"],
].map(([key, header]) => ({ key, header }));

const exclusionColumns = [
  { key: "source", header: "Источник" }, { key: "id", header: "ID" }, { key: "title", header: "Название" },
  { key: "url", header: "URL" }, { key: "chapterCount", header: "Глав" }, { key: "exclusionReason", header: "Причина исключения" },
];

const excludedRows = sortBooks([
  ...rulateUnderEight,
  ...rulateSafetyExcluded,
  ...ranobeRfUnderEight,
  ...ranobeRfOriginals,
]);

report.rulate = {
  sections: rulateSectionReports,
  searchRequests: rulateSearchRequests,
  filterViolations: rulateFilterViolations,
  rawRowsAcrossSections: rulateSectionReports.reduce((sum, section) => sum + section.rawItems, 0),
  uniqueRowsBeforeChapterFilter: rulateAll.size,
  duplicateIdsAcrossSectionsOrPages: rulateDuplicateIds.size,
  missingChapterTotalsResolved: unresolvedRulate.length,
  safetyAuthorOriginalExclusions: rulateSafetyExcluded.length,
  excludedUnderMinimumChapters: rulateUnderEight.length,
  included: rulateIncluded.length,
};
report.ranoberf = {
  source: ranobeRfPage.source,
  catalogTotalCount: ranobeRfPage.pageInfo.totalCount,
  catalogRowsFetched: ranobeRfPage.items.length,
  bookDetailsFetched: ranobeRfRows.length,
  countryDistribution: Object.fromEntries([...ranobeRfCountryCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  rawTopLevelKeyCounts: Object.fromEntries([...ranobeRfRawKeyCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  authorOriginalExclusions: ranobeRfOriginals.length,
  excludedUnderMinimumChapters: ranobeRfUnderEight.length,
  included: ranobeRfIncluded.length,
};
report.validation = {
  rulateAllSectionsComplete: rulateSectionReports.every((section) => section.fetchedPages === section.totalPages),
  rulateServerFilterAppliedToEverySearchRequest: rulateSearchRequests > 0 && rulateFilterViolations === 0,
  rulateNoUnresolvedChapterCounts: stillUnresolvedRulate.length === 0,
  rulateIncludedAllMeetMinimum: rulateIncluded.every((book) => book.chapterCount >= MIN_CHAPTERS),
  ranoberfCatalogCountMatches: ranobeRfPage.pageInfo.totalCount === null || ranobeRfPage.items.length === ranobeRfPage.pageInfo.totalCount,
  ranoberfEveryCatalogRowResolved: ranobeRfRows.length === ranobeRfPage.items.length,
  ranoberfIncludedAllMeetMinimum: ranobeRfIncluded.every((book) => book.chapterCount >= MIN_CHAPTERS),
};

if (Object.values(report.validation).some((value) => value !== true)) {
  throw new Error(`Validation failed: ${JSON.stringify(report.validation)}`);
}

const combinedRows = sortBooks([...rulateIncluded, ...ranobeRfIncluded]);
const readme = `# Полные каталоги Rulate и RanobeRF\n\nДата снимка: ${GENERATED_AT}\n\nУсловия:\n- включены только книги с 8 и более главами;\n- Rulate: серверный фильтр \`type=1\` («Только переводы»), разделы «Книги» (cat=2) и «AI-переводы вебновелл» (cat=44);\n- RanobeRF: прочитан весь публичный каталог \`/v3/books\`, затем карточка каждой книги; локальные/авторские произведения исключены по явным признакам происхождения, жанра или типа;\n- результаты отсортированы по названию; дубли устранены по ID внутри источника.\n\nФайлы:\n- \`rulate_catalog.csv\` / \`rulate_catalog.jsonl\`;\n- \`ranoberf_catalog.csv\` / \`ranoberf_catalog.jsonl\`;\n- \`combined_catalog.csv\` / \`combined_catalog.jsonl\`;\n- \`excluded_books.csv\` — исключённые книги с причиной;\n- \`crawl_report.json\` — счётчики, распределения и проверки полноты.\n\nИтоговые количества:\n- Rulate: ${rulateIncluded.length};\n- RanobeRF: ${ranobeRfIncluded.length};\n- всего строк: ${combinedRows.length}.\n`;

await Promise.all([
  writeFile(`${OUTPUT_DIR}/rulate_catalog.csv`, toCsv(rulateIncluded, rulateColumns)),
  writeFile(`${OUTPUT_DIR}/ranoberf_catalog.csv`, toCsv(ranobeRfIncluded, ranobeRfColumns)),
  writeFile(`${OUTPUT_DIR}/combined_catalog.csv`, toCsv(combinedRows, [
    { key: "source", header: "Источник" }, { key: "id", header: "ID" }, { key: "title", header: "Название" },
    { key: "originalTitle", header: "Оригинальное название" }, { key: "titleEn", header: "Название EN" },
    { key: "url", header: "URL" }, { key: "chapterCount", header: "Глав" }, { key: "author", header: "Автор" },
    { key: "country", header: "Страна" }, { key: "genres", header: "Жанры" }, { key: "status", header: "Статус" },
    { key: "catalogSections", header: "Раздел каталога" }, { key: "leafCategories", header: "Категория" },
  ])),
  writeFile(`${OUTPUT_DIR}/excluded_books.csv`, toCsv(excludedRows, exclusionColumns)),
  writeFile(`${OUTPUT_DIR}/rulate_catalog.jsonl`, `${rulateIncluded.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(`${OUTPUT_DIR}/ranoberf_catalog.jsonl`, `${ranobeRfIncluded.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(`${OUTPUT_DIR}/combined_catalog.jsonl`, `${combinedRows.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(`${OUTPUT_DIR}/crawl_report.json`, JSON.stringify(report, null, 2)),
  writeFile(`${OUTPUT_DIR}/README.md`, readme),
]);

console.log(JSON.stringify({
  generatedAt: GENERATED_AT,
  rulate: report.rulate,
  ranoberf: report.ranoberf,
  validation: report.validation,
}, null, 2));
