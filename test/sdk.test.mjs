import assert from "node:assert/strict";
import test from "node:test";
import {
  ChapterUnavailableError,
  RanobeRfClient,
  extractBuildId,
  normalizeChapterHtml,
} from "../dist/index.js";

const baseUrl = "https://xn--80acm4afj.xn--p1ai";

function home(buildId = "build-1") {
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    buildId,
    page: "/",
    props: {},
  })}</script></body></html>`;
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function html(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/html" } });
}

function createRouter(routes) {
  const calls = [];
  const fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    const key = new URL(url).pathname + new URL(url).search;
    const handler = routes.get(key) ?? routes.get(new URL(url).pathname);
    if (!handler) return new Response("missing", { status: 404 });
    return typeof handler === "function" ? handler(url, calls) : handler.clone();
  };
  return { fetch, calls };
}

const bookRaw = {
  id: 4270,
  title: "Бездна небес",
  titleEn: "Heavenly Abyss",
  slug: "bezdna-nebes",
  url: "/bezdna-nebes",
  description: "<p>Описание</p>",
  status: "active",
  views: 100,
  likes: 4,
  dislikes: 1,
  author: "Author",
  country: { id: 3, title: "Китай", code: "cn" },
  genres: [{ id: 2, title: "Приключения", slug: "adventure" }],
  verticalImage: {
    id: 10,
    url: "/images/books/4270/vertical.jpeg",
    path: "/images/books/4270",
    name: "vertical.jpeg",
    alt: "cover",
  },
  chapters: [
    {
      id: 1,
      bookId: 4270,
      title: "Глава 1. Начало",
      slug: "glava-1-nachalo",
      url: "/bezdna-nebes/glava-1-nachalo",
      numberChapter: "Глава 1",
      chapterShortNumber: 1,
      tom: 1,
      isDonate: false,
      isSubscription: false,
      isSponsored: false,
      isEdited: true,
    },
    {
      id: 2,
      bookId: 4270,
      title: "Глава 2. Дальше",
      slug: "glava-2-dalshe",
      url: "/bezdna-nebes/glava-2-dalshe",
      numberChapter: "Глава 2",
      chapterShortNumber: 2,
      tom: 1,
      isDonate: false,
      isSubscription: false,
      isSponsored: false,
      isEdited: true,
    },
  ],
};

function chapterPayload(id, slug, rawHtml, extras = {}) {
  return {
    pageProps: {
      chapter: {
        id,
        bookId: 4270,
        translatorId: 10954,
        editorId: 55,
        title: `Глава ${id}`,
        slug,
        url: `/bezdna-nebes/${slug}`,
        status: "published",
        numberChapter: `Глава ${id}`,
        chapterShortNumber: id,
        isDonate: false,
        isSubscription: false,
        isSponsored: false,
        isUserPaid: false,
        content: rawHtml === null ? null : { text: rawHtml, symbolsCount: 123 },
        book: {
          id: 4270,
          title: "Бездна небес",
          titleEn: "Heavenly Abyss",
          slug: "bezdna-nebes",
          url: "/bezdna-nebes",
        },
        ...extras,
      },
    },
  };
}

test("extracts the current Next.js build ID", () => {
  assert.equal(extractBuildId(home("abc-123")), "abc-123");
  assert.equal(
    extractBuildId('<script src="/_next/static/static-build/_buildManifest.js"></script>'),
    "static-build",
  );
});

test("normalizes catalog and complete book metadata", async () => {
  const routes = new Map([
    ["/", html(home())],
    [
      "/v3/books?page=1&pageSize=20&expand=lastChapter%2CverticalImage%2ChorizontalImage%2CsquareImage%2CuserRating",
      json({
        items: [bookRaw],
        pagesData: { totalCount: 1, pageCount: 1, currentPage: 1, perPage: 20 },
      }),
    ],
    ["/_next/data/build-1/bezdna-nebes.json", json({ pageProps: { book: bookRaw } })],
  ]);
  const router = createRouter(routes);
  const client = new RanobeRfClient({ fetch: router.fetch });

  const catalog = await client.listCatalog({ page: 1, pageSize: 20 });
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.source, "v3");
  assert.equal(catalog.items[0].title, "Бездна небес");
  assert.equal(catalog.items[0].images[0].url, `${baseUrl}/images/books/4270/vertical.jpeg`);
  assert.equal(catalog.pageInfo.totalCount, 1);

  const book = await client.getBook("bezdna-nebes");
  assert.equal(book.titleEn, "Heavenly Abyss");
  assert.equal(book.country.code, "cn");
  assert.equal(book.genres[0].title, "Приключения");
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[1].number, 2);
});

test("preserves raw HTML and creates safe formatted HTML, text and lazy images", async () => {
  const rawHtml = [
    '<p style="text-align:center;color:red" onclick="bad()">Текст <strong>жирный</strong></p>',
    '<img data-lazy-src="/images/chapter/a.jpg" onerror="bad()" alt="Иллюстрация">',
    '<script>alert(1)</script>',
    '<a href="/bezdna-nebes">книга</a>',
  ].join("");
  const routes = new Map([
    ["/", html(home())],
    [
      "/_next/data/build-1/bezdna-nebes/glava-1-nachalo.json",
      json(chapterPayload(1, "glava-1-nachalo", rawHtml)),
    ],
  ]);
  const router = createRouter(routes);
  const client = new RanobeRfClient({ fetch: router.fetch });
  const chapter = await client.getChapter("bezdna-nebes", "glava-1-nachalo");

  assert.equal(chapter.content.rawHtml, rawHtml);
  assert.match(chapter.content.formattedHtml, /<p style="text-align:center">/);
  assert.match(chapter.content.formattedHtml, /src="https:\/\/xn--80acm4afj\.xn--p1ai\/images\/chapter\/a\.jpg"/);
  assert.doesNotMatch(chapter.content.formattedHtml, /script|onclick|onerror|color:red/);
  assert.equal(chapter.content.images[0].url, `${baseUrl}/images/chapter/a.jpg`);
  assert.match(chapter.content.text, /Текст жирный/);
  assert.equal(chapter.translators[0].id, 10954);
  assert.equal(chapter.editors[0].id, 55);
});

test("standalone HTML normalizer drops invalid images and dangerous blocks", () => {
  const result = normalizeChapterHtml(
    '<p>Hello&nbsp;world</p><img data-src="javascript:bad"><iframe>x</iframe>',
    baseUrl,
  );
  assert.equal(result.formattedHtml, "<p>Hello&nbsp;world</p>");
  assert.equal(result.text, "Hello world");
  assert.deepEqual(result.images, []);
});

test("refreshes a stale build ID after a Next data 404", async () => {
  let homeCalls = 0;
  const routes = new Map([
    [
      "/",
      () => {
        homeCalls += 1;
        return html(home(homeCalls === 1 ? "old-build" : "new-build"));
      },
    ],
    ["/_next/data/old-build/bezdna-nebes.json", new Response("gone", { status: 404 })],
    ["/_next/data/new-build/bezdna-nebes.json", json({ pageProps: { book: bookRaw } })],
  ]);
  const router = createRouter(routes);
  const client = new RanobeRfClient({ fetch: router.fetch, maxRetries: 0 });
  const book = await client.getBook("bezdna-nebes");
  assert.equal(book.id, 4270);
  assert.equal(homeCalls, 2);
});

test("deduplicates simultaneous identical requests", async () => {
  let bookCalls = 0;
  const routes = new Map([
    ["/", html(home())],
    [
      "/_next/data/build-1/bezdna-nebes.json",
      async () => {
        bookCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json({ pageProps: { book: bookRaw } });
      },
    ],
  ]);
  const router = createRouter(routes);
  const client = new RanobeRfClient({ fetch: router.fetch });
  const [first, second] = await Promise.all([
    client.getBook("bezdna-nebes"),
    client.getBook("bezdna-nebes"),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(bookCalls, 1);
});

test("retries 429 using Retry-After", async () => {
  let attempts = 0;
  const routes = new Map([
    ["/", html(home())],
    [
      "/_next/data/build-1/bezdna-nebes.json",
      () => {
        attempts += 1;
        if (attempts === 1) return json({ error: "slow down" }, 429, { "retry-after": "0" });
        return json({ pageProps: { book: bookRaw } });
      },
    ],
  ]);
  const router = createRouter(routes);
  const client = new RanobeRfClient({
    fetch: router.fetch,
    maxRetries: 1,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
  });
  const book = await client.getBook("bezdna-nebes");
  assert.equal(book.id, 4270);
  assert.equal(attempts, 2);
});

test("does not bypass unavailable paid chapters", async () => {
  const routes = new Map([
    ["/", html(home())],
    [
      "/_next/data/build-1/bezdna-nebes/paid.json",
      json(
        chapterPayload(10, "paid", null, {
          isDonate: true,
          price: 4,
          content: null,
        }),
      ),
    ],
  ]);
  const router = createRouter(routes);
  const client = new RanobeRfClient({ fetch: router.fetch });
  await assert.rejects(
    () => client.getChapter("bezdna-nebes", "paid"),
    ChapterUnavailableError,
  );
  const metadata = await client.getChapter("bezdna-nebes", "paid", {
    allowUnavailable: true,
  });
  assert.equal(metadata.available, false);
  assert.equal(metadata.isDonate, true);
  assert.equal(metadata.content, null);
});

test("streams chapters concurrently while yielding source order", async () => {
  let active = 0;
  let maxActive = 0;
  const chapter = (id, slug, delay) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return json(chapterPayload(id, slug, `<p>${id}</p>`));
  };
  const threeChapterBook = {
    ...bookRaw,
    chapters: [
      ...bookRaw.chapters,
      {
        ...bookRaw.chapters[1],
        id: 3,
        title: "Глава 3",
        slug: "glava-3",
        url: "/bezdna-nebes/glava-3",
        chapterShortNumber: 3,
      },
    ],
  };
  const routes = new Map([
    ["/", html(home())],
    ["/_next/data/build-1/bezdna-nebes.json", json({ pageProps: { book: threeChapterBook } })],
    ["/_next/data/build-1/bezdna-nebes/glava-1-nachalo.json", chapter(1, "glava-1-nachalo", 35)],
    ["/_next/data/build-1/bezdna-nebes/glava-2-dalshe.json", chapter(2, "glava-2-dalshe", 5)],
    ["/_next/data/build-1/bezdna-nebes/glava-3.json", chapter(3, "glava-3", 1)],
  ]);
  const router = createRouter(routes);
  const client = new RanobeRfClient({ fetch: router.fetch, maxConcurrency: 3 });
  const results = [];
  for await (const result of client.streamChapters("bezdna-nebes", { concurrency: 3 })) {
    results.push(result.chapter.id);
  }
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(maxActive, 3);
});
