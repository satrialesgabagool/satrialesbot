export interface FetchRetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts?: FetchRetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 3;
  const initialBackoff = opts?.initialBackoffMs ?? 1000;
  const timeoutMs = opts?.timeoutMs ?? 10000;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const combinedSignal = opts?.signal;

      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      if (combinedSignal?.aborted) {
        clearTimeout(timeout);
        throw new Error("Request aborted");
      }

      combinedSignal?.addEventListener("abort", () => controller.abort(), { once: true });

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) return response;

      // Don't retry 4xx errors (except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (lastError.message === "Request aborted" || opts?.signal?.aborted) {
        throw lastError;
      }
    }

    if (attempt < maxRetries) {
      const backoff = initialBackoff * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastError ?? new Error(`fetchWithRetry failed after ${maxRetries + 1} attempts`);
}
