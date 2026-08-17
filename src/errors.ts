import type { UnknownRecord } from "./types.js";

export class RanobeRfError extends Error {
  public readonly code: string;
  public readonly context: UnknownRecord;

  public constructor(message: string, code: string, context: UnknownRecord = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.context = context;
  }
}

export class HttpError extends RanobeRfError {
  public readonly status: number;
  public readonly url: string;
  public readonly retryAfterMs: number | null;
  public readonly body: string;

  public constructor(
    message: string,
    options: {
      status: number;
      url: string;
      retryAfterMs?: number | null;
      body?: string;
      code?: string;
    },
  ) {
    super(message, options.code ?? "HTTP_ERROR", {
      status: options.status,
      url: options.url,
      retryAfterMs: options.retryAfterMs ?? null,
      bodyPreview: (options.body ?? "").slice(0, 500),
    });
    this.status = options.status;
    this.url = options.url;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.body = options.body ?? "";
  }
}

export class NotFoundError extends HttpError {
  public constructor(url: string, body = "") {
    super(`RanobeRF resource was not found: ${url}`, {
      status: 404,
      url,
      body,
      code: "NOT_FOUND",
    });
  }
}

export class InvalidPayloadError extends RanobeRfError {
  public constructor(message: string, context: UnknownRecord = {}) {
    super(message, "INVALID_PAYLOAD", context);
  }
}

export class BuildIdNotFoundError extends RanobeRfError {
  public constructor(url: string) {
    super("Could not discover the current RanobeRF Next.js build ID.", "BUILD_ID_NOT_FOUND", {
      url,
    });
  }
}

export class ResponseTooLargeError extends RanobeRfError {
  public constructor(url: string, limit: number) {
    super(`RanobeRF response exceeded ${limit} bytes.`, "RESPONSE_TOO_LARGE", { url, limit });
  }
}

export class ChapterUnavailableError extends RanobeRfError {
  public constructor(options: {
    bookSlug: string;
    chapterSlug: string;
    isDonate: boolean;
    isSubscription: boolean;
    price: number | null;
  }) {
    super(
      "Chapter content is unavailable to the current public session. The SDK does not bypass paid or access-controlled content.",
      "CHAPTER_UNAVAILABLE",
      options,
    );
  }
}
