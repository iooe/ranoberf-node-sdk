import { mkdir, writeFile } from "node:fs/promises";
import { RanobeRfClient } from "../dist/index.js";
import { RulateClient } from "../../rulate-node-sdk/dist/index.js";

await mkdir("out", { recursive: true });
const report = { generatedAt: new Date().toISOString(), ranoberf: {}, rulate: {} };

const rf = new RanobeRfClient({
  maxConcurrency: 8,
  minRequestIntervalMs: 50,
  timeoutMs: 45_000,
  maxRetries: 5,
});

for (const pageSize of [5, 100, 500, 1000, 5000, 10000]) {
  try {
    const page = await rf.listCatalog({ page: 1, pageSize, source: "auto" });
    report.ranoberf[`pageSize${pageSize}`] = {
      count: page.items.length,
      pageInfo: page.pageInfo,
      source: page.source,
      first: page.items[0] ?? null,
      last: page.items.at(-1) ?? null,
      rawTopKeys: page.raw && typeof page.raw === "object" ? Object.keys(page.raw) : [],
    };
  } catch (error) {
    report.ranoberf[`pageSize${pageSize}`] = { error: String(error?.stack ?? error) };
  }
}

try {
  const samplePage = await rf.listCatalog({ page: 1, pageSize: 10 });
  report.ranoberf.samples = [];
  for (const summary of samplePage.items.slice(0, 5)) {
    try {
      const book = await rf.getBook(summary.slug);
      report.ranoberf.samples.push({
        summary,
        details: {
          ...book,
          chapters: book.chapters.slice(0, 12),
          chapterCount: book.chapters.length,
          raw: undefined,
        },
      });
    } catch (error) {
      report.ranoberf.samples.push({ summary, error: String(error?.stack ?? error) });
    }
  }
} catch (error) {
  report.ranoberf.sampleError = String(error?.stack ?? error);
}

const ru = new RulateClient({
  maxConcurrency: 4,
  minRequestIntervalMs: 300,
  timeoutMs: 45_000,
  maxRetries: 5,
});

for (const category of [undefined, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const key = category === undefined ? "default" : `category${category}`;
  try {
    const page = await ru.getCatalog({ page: 1, ...(category === undefined ? {} : { category }) });
    report.rulate[key] = {
      count: page.items.length,
      totalPages: page.totalPages,
      hasNextPage: page.hasNextPage,
      items: page.items.slice(0, 6).map((item) => ({
        id: item.id,
        title: item.title,
        originalTitle: item.originalTitle,
        chapters: item.chapters,
        genres: item.genres,
        tags: item.tags,
        url: item.url,
      })),
    };
    if (category === undefined) {
      await writeFile("out/rulate-search-page.html", page.rawHtml);
    }
  } catch (error) {
    report.rulate[key] = { error: String(error?.stack ?? error) };
  }
}

try {
  const defaultPage = await ru.getCatalog({ page: 1 });
  report.rulate.formMatches = [...defaultPage.rawHtml.matchAll(/<select[\s\S]*?<\/select>/gi)].map((m) => m[0].slice(0, 10000));
  report.rulate.categoryMentions = [...defaultPage.rawHtml.matchAll(/.{0,100}(?:Авторск|перевод|категор).{0,200}/gi)].slice(0, 100).map((m) => m[0]);
} catch (error) {
  report.rulate.formError = String(error?.stack ?? error);
}

await writeFile("out/diagnostic.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ generatedAt: report.generatedAt, keys: { ranoberf: Object.keys(report.ranoberf), rulate: Object.keys(report.rulate) } }, null, 2));
