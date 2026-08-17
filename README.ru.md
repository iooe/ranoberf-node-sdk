# @iooe/ranoberf-sdk

Production-oriented TypeScript SDK для публичного каталога RanobeRF, данных книг, метаданных глав и публично доступного содержимого глав.

Каталог преимущественно загружается через `/v3/books`. Книги и главы читаются через актуальный JSON-интерфейс Next.js; после обновления сайта SDK автоматически обнаруживает новый `buildId` и повторяет запрос.

## Возможности

- полный каталог с пагинацией и локальным поиском по всему прочитанному каталогу;
- данные книги, жанры, страна, список глав, постеры и изображения;
- метаданные главы, идентификаторы переводчика и редактора, а также публичные объекты участников, когда источник их отдаёт;
- точный исходный HTML главы в `rawHtml`;
- безопасный HTML только с форматированием в `formattedHtml`, обычный текст и список изображений;
- сохранение иллюстраций из `data-src`, `data-lazy-src`, `data-original` и других lazy-атрибутов;
- пакетная и потоковая загрузка глав с настраиваемой параллельностью;
- retry с экспоненциальной задержкой и поддержкой `Retry-After`, timeout и ограничение размера ответа;
- TTL/LRU-кеш и объединение одновременных одинаковых запросов;
- автоматическое восстановление после смены Next.js build ID;
- отсутствие runtime-зависимостей; Node.js 20.12+.

SDK не обходит авторизацию, подписку или оплату. Для недоступной главы выбрасывается `ChapterUnavailableError`. При явном `allowUnavailable: true` возвращаются только доступные метаданные.

## Установка

```bash
npm install @iooe/ranoberf-sdk
```

## Пример

```ts
import { RanobeRfClient } from "@iooe/ranoberf-sdk";

const client = new RanobeRfClient();
const page = await client.listCatalog({ page: 1, pageSize: 100 });
const book = await client.getBook(page.items[0].slug);

const freeChapter = [...book.chapters]
  .reverse()
  .find((chapter) => !chapter.isDonate && !chapter.isSubscription);

if (freeChapter) {
  const chapter = await client.getChapter(book.slug, freeChapter.slug);
  console.log(chapter.content?.rawHtml);
  console.log(chapter.content?.formattedHtml);
  console.log(chapter.content?.text);
  console.log(chapter.content?.images);
}
```

Можно передать полный URL главы:

```ts
const chapter = await client.getChapter(
  "https://xn--80acm4afj.xn--p1ai/bezdna-nebes/glava-1-vozvraschenie-iz-bezdny-nebes",
);
```

## Потоковая загрузка

```ts
for await (const result of client.streamChapters("bezdna-nebes", {
  concurrency: 24,
  order: "ascending",
})) {
  if (result.error) {
    console.error(result.summary.slug, result.error);
    continue;
  }
  await saveChapter(result.chapter!);
}
```

Сетевые запросы выполняются параллельно, но результаты выдаются в требуемом порядке.

## Данные переводчиков

Публичный payload RanobeRF стабильно содержит `translatorId` и `editorId`. Когда в ответе также присутствуют объекты переводчика, редактора или команды, SDK извлекает имя, username и URL. Когда сайт отдаёт только ID, остальные поля остаются `null`: SDK не выдумывает отсутствующие данные.

## Полный HTML страницы

По умолчанию SDK получает содержимое главы из JSON без второго запроса. Рендер страницы можно запросить отдельно:

```ts
const chapter = await client.getChapter("bezdna-nebes", "glava-1-vozvraschenie-iz-bezdny-nebes", {
  includePageHtml: true,
});

console.log(chapter.pageHtml);
```

## Проверка

```bash
npm ci
npm run check
```
