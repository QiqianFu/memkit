// Minimal JSON-over-HTTP helper with bounded retries. Node's global fetch only;
// no SDK dependency, so the plugin installs with zero runtime packages.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export async function postJson(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs?: number; retries?: number; signal?: AbortSignal } = {},
): Promise<any> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 30000)];
    if (opts.signal) signals.push(opts.signal);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      if (res.ok) return await res.json();
      // Do not echo the response body into errors verbatim beyond a short prefix:
      // provider errors can reflect the submitted evidence back.
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const err = new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}: ${text}`);
      if (!RETRYABLE.has(res.status) || attempt === retries) throw err;
      lastErr = err;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (opts.signal?.aborted || attempt === retries) throw e;
      lastErr = e;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
