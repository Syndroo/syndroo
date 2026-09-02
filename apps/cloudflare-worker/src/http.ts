const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_REQUEST_BYTES = 64 * 1024;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export async function requireBearer(
  request: Request,
  expected: string,
): Promise<void> {
  const provided = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];

  if (!provided || !(await verifyToken(provided, expected))) {
    throw new ApiError("Unauthorized", 401, "UNAUTHORIZED");
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(
      "Content-Type must be application/json",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);

  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new ApiError("Request body is too large", 413, "BODY_TOO_LARGE");
  }

  if (!request.body) {
    throw new ApiError("Request body is required", 400, "INVALID_JSON");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      length += value.byteLength;

      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel("Request body exceeded size limit");
        throw new ApiError("Request body is too large", 413, "BODY_TOO_LARGE");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("Request body contains invalid JSON", 400, "INVALID_JSON");
  }
}

async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}
