const gatewayFailures = new Set([502, 504, 530]);
// Allow five seconds beyond ENGINE_TIMEOUT_MS in apps/web/src/lib/server/engine.ts.
const originTimeoutMs = 25_000;

export async function fetchEngine(request, env, fetchOrigin = fetch) {
  if (env.ENGINE_ORIGIN) {
    const origin = URL.parse(env.ENGINE_ORIGIN);
    if (origin?.protocol === "https:" && origin.href === origin.origin + "/") {
      const incoming = new URL(request.url);
      // Set URL components directly so even a path starting with // stays on the configured host.
      origin.pathname = incoming.pathname;
      origin.search = incoming.search;
      const signal = AbortSignal.timeout(originTimeoutMs);
      let response;
      try {
        response = await fetchOrigin(new Request(origin, request.clone()), {
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
  const upstream = new Request(request);
  upstream.headers.delete("Authorization");
  return env.ENGINE.getByName("network").fetch(upstream);
}
