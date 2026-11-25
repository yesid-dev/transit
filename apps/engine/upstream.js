const gatewayFailures = new Set([502, 504, 530]);
// Allow five seconds beyond ENGINE_TIMEOUT_MS in apps/web/src/lib/server/engine.ts.
const originTimeoutMs = 25_000;
const recordTimeoutMs = 45_000;

export async function fetchEngine(request, env, fetchOrigin = fetch) {
  const requested = Number(request.headers.get("x-transit-record-deadline"));
  const deadline = Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, Date.now() + recordTimeoutMs)
    : undefined;
  const signal = deadline === undefined ? request.signal : AbortSignal.any([
    request.signal, AbortSignal.timeout(Math.max(0, deadline - Date.now())),
  ]);
  const first = await fetchOnce(request, env, fetchOrigin, signal, deadline);
  const retryAfter = first.headers.get("retry-after");
  if (deadline === undefined || first.status !== 503 || retryAfter === null ||
      !/^\d+$/.test(retryAfter) || signal.aborted) return first;

  const delay = Math.max(100, Number(retryAfter) * 1_000) + Math.random() * 250;
  if (Date.now() + delay + 250 >= deadline) return first;
  await first.body?.cancel();
  if (!signal.aborted) {
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  if (!signal.aborted) {
    try {
      const retried = await fetchOnce(request, env, fetchOrigin, signal, deadline);
      if (!signal.aborted) return retried;
      await retried.body?.cancel();
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  return Response.json({ message: "busy, try again" }, {
    status: 503, headers: { "retry-after": retryAfter },
  });
}

async function fetchOnce(request, env, fetchOrigin, requestSignal, deadline) {
  if (env.ENGINE_ORIGIN) {
    const origin = URL.parse(env.ENGINE_ORIGIN);
    if (origin?.protocol === "https:" && origin.href === origin.origin + "/") {
      const incoming = new URL(request.url);
      // Set URL components directly so even a path starting with // stays on the configured host.
      origin.pathname = incoming.pathname;
      origin.search = incoming.search;
      const signal = deadline === undefined
        ? AbortSignal.any([AbortSignal.timeout(originTimeoutMs), requestSignal])
        : requestSignal;
      const upstream = new Request(origin, request);
      upstream.headers.delete("x-transit-record-deadline");
      let response;
      try {
        response = await fetchOrigin(upstream, {
          redirect: "manual",
          cache: "no-store",
          signal,
        });
      } catch {
        if (signal.aborted) {
          return Response.json({ message: "Engine origin timed out" }, {
            status: 504,
            headers: { "Cache-Control": "no-store" },
          });
        }
      }
      if (response) {
        const unavailable = gatewayFailures.has(response.status) ||
          (response.status === 503 && !response.headers.has("Retry-After"));
        if (!unavailable) {
          return response;
        }
        await response.body?.cancel().catch(() => {});
      }
    }
  }
  const upstream = new Request(request, { signal: requestSignal, redirect: "manual" });
  upstream.headers.delete("Authorization");
  upstream.headers.delete("x-transit-record-deadline");
  return env.ENGINE.getByName("network").fetch(upstream);
}
