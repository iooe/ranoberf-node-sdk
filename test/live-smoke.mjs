import assert from "node:assert/strict";
import { RanobeRfClient } from "../dist/index.js";

const client = new RanobeRfClient({
  maxConcurrency: 6,
  timeoutMs: 30_000,
  maxRetries: 3,
});

const catalog = await client.listCatalog({ page: 1, pageSize: 10, source: "v3" });
assert.ok(catalog.items.length > 0, "Live catalog returned no books");

let selectedBook = null;
let selectedChapter = null;
for (const summary of catalog.items) {
  const book = await client.getBook(summary.slug);
  const chapter = [...book.chapters]
    .reverse()
    .find((item) => !item.isDonate && !item.isSubscription);
  if (chapter) {
    selectedBook = book;
    selectedChapter = chapter;
    break;
  }
}

assert.ok(selectedBook, "No book with a public chapter was found on the first catalog page");
assert.ok(selectedChapter, "No public chapter was found");

const chapter = await client.getChapter(selectedBook.slug, selectedChapter.slug);
assert.ok(chapter.available, "Selected public chapter has no content");
assert.ok(chapter.content?.rawHtml.length > 0, "Chapter rawHtml is empty");
assert.ok(chapter.content?.formattedHtml.length > 0, "Chapter formattedHtml is empty");

console.log(
  JSON.stringify(
    {
      buildId: await client.getBuildId(),
      catalogItems: catalog.items.length,
      book: selectedBook.slug,
      chapter: selectedChapter.slug,
      rawHtmlBytes: chapter.content.rawHtml.length,
      images: chapter.content.images.length,
      translatorId: chapter.translatorId,
    },
    null,
    2,
  ),
);
