import { mkdir, writeFile } from "node:fs/promises";
import { RulateClient } from "../../rulate-node-sdk/dist/index.js";

const OUTPUT_DIR = "out";
const SHARD_INDEX = Number.parseInt(process.env.SHARD_INDEX ?? "0", 10);
const SHARD_COUNT = Number.parseInt(process.env.SHARD_COUNT ?? "1", 10);
const MIN_CHAPTERS = 8;
const SORT = "2";
const SECTIONS = [
  { id: 2, name: "Книги" },
  { id: 44, name: "AI-переводы вебновелл" },
];

if (!Number.isInteger(SHARD_INDEX) || !Number.isInteger(SHARD_COUNT) || SHARD_COUNT < 1 || SHARD_INDEX < 0 || SHARD_INDEX >= SHARD_COUNT) {
  throw new Error(`Invalid shard ${SHARD_INDEX}/${SHARD_COUNT}.`);
}
await mkdir(OUTPUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(values, concurrency, worker) {
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length || 1) }, run));
}

function asText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function detachedString(value) {
  const text = asText(value);
  return text === "" ? "" : Buffer.from(text, "utf8").toString("utf8");
}

function detachedStrings(values) {
  return values.map(detachedString);
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

function extractLeafCategory(rawHtml) {
  const match = /<small[^>]*class=["'][^"']*\bcat\b[^"']*["'][^>]*>([\s\S]*?)<\/small>/i.exec(rawHtml);
  return match ? stripHtml(match[1]) : "";
}

function authorOriginalReason(rawHtml, leafCategory) {
  if (/авторск/i.test(leafCategory)) return `Категория: ${leafCategory}`;
  const plain = stripHtml(rawHtml);
  if (/(?:^|\s)Автор\s+от(?:\s|:)/i.test(plain)) return "Маркер «Автор от»";
  if (/авторское\s+произведение/i.test(plain)) return "Маркер авторского произведения";
  return null;
}

let searchRequests = 0;
const filteredFetch = async (input, init) => {
  const originalUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(originalUrl);
  if (url.hostname === "tl.rulate.ru" && url.pathname.startsWith("/search")) {
    url.searchParams.set("type", "1");
    searchRequests += 1;
  }
  return globalThis.fetch(url, init);
};

const client = new RulateClient({
  fetch: filteredFetch,
  maxConcurrency: 5,
  minRequestIntervalMs: 350,
  timeoutMs: 60_000,
  maxResponseBytes: 12 * 1024 * 1024,
  maxRetries: 7,
  retryBaseDelayMs: 800,
  retryMaxDelayMs: 45_000,
  metadataCacheTtlMs: 0,
  chapterCacheTtlMs: 0,
  userAgent: `catalog-audit-shard/${SHARD_INDEX + 1}-of-${SHARD_COUNT}`,
});

async function fetchPage(section, pageNumber) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const page = await client.getCatalog({
        page: pageNumber,
        category: section.id,
        sort: SORT,
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

const rows = [];
const sectionReports = [];

function consume(page, section) {
  for (const item of page.items) {
    const leafCategory = extractLeafCategory(item.rawHtml);
    rows.push({
      source: "Rulate",
      id: item.id,
      url: detachedString(item.url),
      title: detachedString(item.title),
      originalTitle: detachedString(item.originalTitle),
      chapterCount: item.chapters.total,
      paidChapterCount: item.chapters.paid,
      catalogSectionId: section.id,
      catalogSection: detachedString(section.name),
      leafCategory: detachedString(leafCategory),
      genres: detachedStrings(item.genres),
      tags: detachedStrings(item.tags),
      status: detachedString(item.status),
      lastActivityAt: detachedString(item.lastActivityAt),
      rating: item.rating.value,
      ratingVotes: item.rating.votes,
      translationRating: item.translationRating.value,
      translationRatingVotes: item.translationRating.votes,
      likes: item.likes,
      translator: detachedString(item.translator?.name),
      posterUrl: detachedString(item.poster?.url),
      authorOriginalReason: authorOriginalReason(item.rawHtml, leafCategory),
      authorshipFilter: "type=1 (Только переводы)",
    });
  }
}

for (const section of SECTIONS) {
  const firstPage = await fetchPage(section, 1);
  const totalPages = firstPage.totalPages;
  if (totalPages === null || totalPages < 1) throw new Error(`No total page count for section ${section.id}.`);
  const startPage = Math.floor((totalPages * SHARD_INDEX) / SHARD_COUNT) + 1;
  const endPage = Math.floor((totalPages * (SHARD_INDEX + 1)) / SHARD_COUNT);
  const pageNumbers = Array.from({ length: Math.max(0, endPage - startPage + 1) }, (_, index) => startPage + index);
  let fetchedPages = 0;
  let rawRows = 0;

  await mapLimit(pageNumbers, 8, async (pageNumber) => {
    const page = pageNumber === 1 ? firstPage : await fetchPage(section, pageNumber);
    if (page.items.length === 0 && pageNumber < totalPages) {
      throw new Error(`Section ${section.id} page ${pageNumber}/${totalPages} returned zero items.`);
    }
    consume(page, section);
    fetchedPages += 1;
    rawRows += page.items.length;
    if (fetchedPages % 100 === 0 || fetchedPages === pageNumbers.length) {
      const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`[Rulate shard ${SHARD_INDEX}] ${section.name}: ${fetchedPages}/${pageNumbers.length} assigned pages (${startPage}-${endPage}); ${rawRows} rows; heap ${heapMb} MB.`);
    }
  });

  sectionReports.push({
    id: section.id,
    name: section.name,
    totalPages,
    startPage,
    endPage,
    assignedPages: pageNumbers.length,
    fetchedPages,
    rawRows,
  });
}

const unresolved = rows.filter((row) => !Number.isFinite(row.chapterCount));
if (unresolved.length > 0) {
  console.log(`[Rulate shard ${SHARD_INDEX}] Resolving ${unresolved.length} missing chapter totals.`);
  await mapLimit(unresolved, 4, async (row) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const book = await client.getBook(row.id, { refresh: true });
        row.chapterCount = book.chapterStats.total;
        row.paidChapterCount = book.chapterStats.paid;
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 2_000);
      }
    }
    row.chapterResolutionError = String(lastError?.stack ?? lastError);
  });
}

const stillUnresolved = rows.filter((row) => !Number.isFinite(row.chapterCount));
if (stillUnresolved.length > 0) {
  throw new Error(`Shard ${SHARD_INDEX} has ${stillUnresolved.length} unresolved chapter totals.`);
}

client.close();

const report = {
  generatedAt: new Date().toISOString(),
  shardIndex: SHARD_INDEX,
  shardCount: SHARD_COUNT,
  minimumChapters: MIN_CHAPTERS,
  searchRequests,
  sections: sectionReports,
  rows: rows.length,
  authorOriginalCandidates: rows.filter((row) => row.authorOriginalReason).length,
  underMinimum: rows.filter((row) => row.chapterCount < MIN_CHAPTERS).length,
  includedCandidateRows: rows.filter((row) => !row.authorOriginalReason && row.chapterCount >= MIN_CHAPTERS).length,
};

await Promise.all([
  writeFile(`${OUTPUT_DIR}/rulate_shard_${SHARD_INDEX}.jsonl`, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`),
  writeFile(`${OUTPUT_DIR}/rulate_shard_${SHARD_INDEX}_report.json`, JSON.stringify(report, null, 2)),
]);
console.log(JSON.stringify(report, null, 2));