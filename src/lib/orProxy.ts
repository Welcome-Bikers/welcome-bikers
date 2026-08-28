import { fetchTextResponse } from "./net";

/** Resolve CORS-friendly OpenRouter proxy base (no trailing slash). Key stays on the proxy. */

const viteEnv = import.meta.env ?? {};
const DEFAULT_DISCOVERY_URLS = [
  "https://api.github.com/repos/Welcome-Bikers/welcome-bikers/contents/public/or-proxy.json?ref=proxy-url",
  "https://raw.githubusercontent.com/Welcome-Bikers/welcome-bikers/proxy-url/public/or-proxy.json",
  "or-proxy.json",
];
const configuredDiscovery = String(viteEnv.VITE_OPENROUTER_DISCOVERY_URL || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const DISCOVERY_URLS = (configuredDiscovery.length ? configuredDiscovery : DEFAULT_DISCOVERY_URLS)
  .filter((url, index, all) => all.indexOf(url) === index);

const HEALTH_CACHE_MS = 30_000;
const FAILURE_CACHE_MS = 8_000;
let resolved: string | undefined;
let resolvedAt = 0;
let unavailableUntil = 0;
let generation = 0;
let resolving: { generation: number; force: boolean; promise: Promise<string> } | null = null;
const unhealthyUntil = new Map<string, number>();

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function proxyBaseFromEnv(): string {
  return normalizeBase(String(viteEnv.VITE_OPENROUTER_PROXY_URL || ""));
}

function abortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("Request aborted", "AbortError");
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function baseFromDiscoveryPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const data = payload as { base?: unknown; content?: unknown; encoding?: unknown };
  if (typeof data.base === "string") return normalizeBase(data.base);
  if (data.encoding !== "base64" || typeof data.content !== "string") return "";
  try {
    const decoded = atob(data.content.replace(/\s/g, ""));
    const nested = JSON.parse(decoded) as { base?: unknown };
    return normalizeBase(typeof nested.base === "string" ? nested.base : "");
  } catch {
    return "";
  }
}

async function isHealthy(base: string, signal?: AbortSignal): Promise<boolean> {
  if (!base || (unhealthyUntil.get(base) ?? 0) > Date.now()) return false;
  try {
    const { response } = await fetchTextResponse(
      `${base}/health`,
      { cache: "no-store", signal },
      4_000,
    );
    if (response.ok) {
      unhealthyUntil.delete(base);
      return true;
    }
  } catch {
    if (signal?.aborted) throw abortError(signal);
    // Cache a short failure so parallel requests do not stampede a dead tunnel.
  }
  unhealthyUntil.set(base, Date.now() + FAILURE_CACHE_MS);
  return false;
}

async function discoverProxyBase(targetGeneration: number): Promise<string> {
  for (const url of DISCOVERY_URLS) {
    if (targetGeneration !== generation) return "";
    try {
      const separator = url.includes("?") ? "&" : "?";
      const { response, text } = await fetchTextResponse(
        `${url}${separator}t=${Date.now()}`,
        { cache: "no-store" },
        6_000,
      );
      if (!response.ok) continue;
      const base = baseFromDiscoveryPayload(JSON.parse(text));
      if (/^https:\/\//i.test(base) && await isHealthy(base)) return base;
    } catch {
      /* try next */
    }
  }
  return "";
}

/** Resolve proxy base: stable build-time URL first, then a health-checked discovery document. */
export async function resolveProxyBase(forceRefresh = false, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError(signal);
  if (forceRefresh) {
    if (resolving?.force) return awaitWithSignal(resolving.promise, signal);
    generation += 1;
    resolved = undefined;
    resolvedAt = 0;
    unavailableUntil = 0;
    resolving = null;
  }
  if (!forceRefresh && resolved && Date.now() - resolvedAt < HEALTH_CACHE_MS) return resolved;
  if (!forceRefresh && unavailableUntil > Date.now()) return "";

  const targetGeneration = generation;
  if (resolving?.generation === targetGeneration) {
    return awaitWithSignal(resolving.promise, signal);
  }

  const accept = (base: string) => {
    if (targetGeneration !== generation) return "";
    resolved = base || undefined;
    resolvedAt = base ? Date.now() : 0;
    unavailableUntil = base ? 0 : Date.now() + FAILURE_CACHE_MS;
    return base;
  };
  const promise = (async () => {
    const fromEnv = proxyBaseFromEnv();
    if (fromEnv && await isHealthy(fromEnv)) return accept(fromEnv);
    if (resolved && await isHealthy(resolved)) return accept(resolved);

    const base = await discoverProxyBase(targetGeneration);
    return accept(base);
  })();
  resolving = { generation: targetGeneration, force: forceRefresh, promise };
  const clearResolving = () => {
    if (resolving?.promise === promise) resolving = null;
  };
  void promise.then(clearResolving, clearResolving);
  return awaitWithSignal(promise, signal);
}

export function chatUrl(base: string): string {
  return `${normalizeBase(base)}/chat`;
}

export function speechUrl(base: string): string {
  return `${normalizeBase(base)}/speech`;
}

export function transcribeUrl(base: string): string {
  return `${normalizeBase(base)}/transcribe`;
}
