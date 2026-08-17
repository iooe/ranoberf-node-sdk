# @iooe/ranoberf-sdk

Production-oriented TypeScript SDK for the public RanobeRF catalog, book pages, chapter metadata and publicly available chapter content.

The SDK uses RanobeRF's public JSON interfaces. Catalog requests prefer `/v3/books`; book and chapter pages use the current Next.js data build and automatically refresh a stale build ID after deployment.

## Features

- full catalog pagination and local full-catalog search;
- normalized book metadata, genres, country, chapter list and posters;
- chapter metadata, translator/editor IDs and public contributor objects when exposed by the source;
- exact source chapter HTML as `rawHtml`;
- safe format-only HTML as `formattedHtml`, plain text and content image list;
- support for legacy lazy image attributes (`data-src`, `data-lazy-src`, `data-original`, and others);
- batch and async-stream chapter downloads with configurable concurrency;
- retry with exponential backoff, `Retry-After`, timeout and response-size limits;
- TTL/LRU caching and in-flight deduplication of identical requests;
- automatic recovery when RanobeRF changes its Next.js build ID;
- no runtime dependencies; Node.js 20.12+.

The SDK does not bypass authentication, subscriptions or paid chapter restrictions. An unavailable chapter raises `ChapterUnavailableError`, or returns metadata only when `allowUnavailable: true` is explicitly selected.

## Install

```bash
npm install @iooe/ranoberf-sdk
```

## Basic usage

```ts
import { RanobeRfClient } from "@iooe/ranoberf-sdk";

const client = new RanobeRfClient();

const catalog = await client.listCatalog({ page: 1, pageSize: 100 });
const book = await client.getBook(catalog.items[0].slug);

const freeChapter = [...book.chapters]
  .reverse()
  .find((chapter) => !chapter.isDonate && !chapter.isSubscription);

if (freeChapter) {
  const chapter = await client.getChapter(book.slug, freeChapter.slug);
  console.log(chapter.content?.rawHtml);       // exact source HTML
  console.log(chapter.content?.formattedHtml); // safe formatting-only HTML
  console.log(chapter.content?.text);          // plain text
  console.log(chapter.content?.images);        // absolute image URLs
}
```

A complete chapter URL is also accepted:

```ts
const chapter = await client.getChapter(
  "https://xn--80acm4afj.xn--p1ai/bezdna-nebes/glava-1-vozvraschenie-iz-bezdny-nebes",
);
```

## Catalog traversal and search

```ts
for await (const page of client.iterateCatalog({ pageSize: 100 })) {
  for (const book of page.items) console.log(book.title);
}

const matches = await client.searchBooks("маг", {
  maxPages: 50,
  includeDescription: true,
});
```

`searchBooks` performs a deterministic local search over the pages it reads, so it does not depend on undocumented server-side search parameters. Advanced consumers can pass raw catalog filters through `params` or use `requestJson()`.

## High-throughput chapter streaming

```ts
for await (const result of client.streamChapters("bezdna-nebes", {
  concurrency: 24,
  order: "ascending",
  from: 0,
  to: 199,
})) {
  if (result.error) {
    console.error(result.summary.slug, result.error);
    continue;
  }
  await saveChapter(result.chapter!);
}
```

Results are yielded in the requested order even when network requests complete out of order.

To collect everything in memory:

```ts
const download = await client.downloadBook("bezdna-nebes", {
  concurrency: 24,
  order: "ascending",
});

console.log(download.succeeded, download.failed);
```

## Full page HTML

Chapter content comes from the source JSON payload. The rendered page HTML is optional because it requires an additional request:

```ts
const chapter = await client.getChapter("bezdna-nebes", "glava-1-vozvraschenie-iz-bezdny-nebes", {
  includePageHtml: true,
});

console.log(chapter.pageHtml);
```

## Translator data

RanobeRF's public chapter payload consistently exposes `translatorId`/`editorId`. When the source additionally embeds translator, editor or team objects, the SDK normalizes their names, usernames and URLs. When it exposes only an ID, the corresponding `PersonRef` intentionally contains the ID and `null` for unavailable public fields rather than inventing data.

## Configuration

```ts
const client = new RanobeRfClient({
  maxConcurrency: 24,
  minRequestIntervalMs: 0,
  timeoutMs: 30_000,
  maxRetries: 4,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 8_000,
  cache: {
    maxEntries: 2_000,
    buildIdTtlMs: 5 * 60_000,
    catalogTtlMs: 30_000,
    bookTtlMs: 5 * 60_000,
    chapterTtlMs: 15 * 60_000,
  },
});
```

Node's built-in `fetch`/Undici handles persistent connection reuse. A custom `fetch` implementation, headers, logger and `AbortSignal` can be supplied where needed.

## Public API

- `listCatalog()`
- `iterateCatalog()`
- `searchBooks()`
- `getBook()`
- `getChapters()`
- `getChapter()`
- `getChapterPageHtml()`
- `streamChapters()`
- `downloadBook()`
- `getBuildId()`
- `getRawNextData()`
- `requestJson()`
- `clearCache()`

## Development

```bash
npm ci
npm run check
```

The test suite uses an injected `fetch` implementation and does not contact RanobeRF.
