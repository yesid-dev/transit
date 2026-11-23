const unavailable = new Set([502, 503, 504, 530]);
const originTimeoutMs = 10_000;

export async function fetchEngine(request, env, fetchOrigin = fetch) {
  if (env.ENGINE_ORIGIN) {
    const origin = URL.parse(env.ENGINE_ORIGIN);
    if (origin?.protocol === "https:" && origin.href === origin.origin + "/") {
      const incoming = new URL(request.url);
      // Set URL components directly so even a path starting with // stays on the configured host.
      origin.pathname = incoming.pathname;
      origin.search = incoming.search;
      const signal = AbortSignal.timeout(originTimeoutMs);
      try {
        const response = await fetchOrigin(new Request(origin, request.clone()), {
          redirect: "manual",
          cache: "no-store",
          signal,
        });
        if (!unavailable.has(response.status) && !(response.status >= 300 && response.status < 400)) {
          return response;
        }
        await response.body?.cancel();
      } catch {
        // A failed or timed-out origin leaves the Container available.
      }
    }
  }
  const upstream = new Request(request);
  upstream.headers.delete("Authorization");
  return env.ENGINE.getByName("network").fetch(upstream);
}
