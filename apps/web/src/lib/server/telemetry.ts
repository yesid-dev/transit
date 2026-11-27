import { env } from 'cloudflare:workers';

export async function admitTelemetry(
	channel: 'vitals' | 'relay',
	address: string | null,
): Promise<Response | null> {
	try {
		const admission = await env.TELEMETRY_RATE_LIMITER?.limit({
			key: `${channel}:${address?.trim() || 'unknown'}`,
		});
		if (admission?.success === true) return null;
		if (admission?.success === false)
			return new Response(null, {
				status: 429,
				headers: { 'cache-control': 'no-store', 'retry-after': '60' },
			});
	} catch {
		// The enabled receiver needs admission before accepting a body.
	}
	return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
}

export async function readTelemetryJson(
	request: Request,
	limit: number,
): Promise<
	{ value: unknown } | { error: 'payload_too_large' | 'unreadable_body' | 'invalid_json' }
> {
	if (Number(request.headers.get('content-length')) > limit) return { error: 'payload_too_large' };
	const reader = request.body?.getReader();
	if (!reader) return { error: 'invalid_json' };
	let bytes = 0;
	let body = '';
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > limit) {
				void reader.cancel().catch(() => {});
				return { error: 'payload_too_large' };
			}
			body += decoder.decode(chunk.value, { stream: true });
		}
		body += decoder.decode();
	} catch {
		return { error: 'unreadable_body' };
	} finally {
		reader.releaseLock();
	}
	try {
		return { value: JSON.parse(body) };
	} catch {
		return { error: 'invalid_json' };
	}
}
