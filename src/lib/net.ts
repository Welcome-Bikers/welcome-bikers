export async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);

  try {
    return await run(controller.signal);
  } finally {
    window.clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  return withAbortTimeout(
    (signal) => fetch(input, { ...init, signal }),
    timeoutMs,
    init.signal ?? undefined,
  );
}

export async function fetchTextResponse(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<{ response: Response; text: string }> {
  return withAbortTimeout(async (signal) => {
    const response = await fetch(input, { ...init, signal });
    const text = await response.text();
    return { response, text };
  }, timeoutMs, init.signal ?? undefined);
}

export async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const { response, text } = await fetchTextResponse(url, {}, timeoutMs);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return JSON.parse(text) as T;
}
