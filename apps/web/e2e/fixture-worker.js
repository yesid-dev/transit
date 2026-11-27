import { AsyncLocalStorage } from 'node:async_hooks';
import worker from '../.svelte-kit/cloudflare/_worker.js';

const header = 'x-transit-fixture-scope';
const context = new AsyncLocalStorage();
const workerFetch = globalThis.fetch.bind(globalThis);

// Each held scenario belongs to one incoming request, including its streamed answers.
globalThis.fetch = (input, init) => {
	const fixture = context.getStore();
	if (!fixture || !(input instanceof Request)) return workerFetch(input, init);
	const url = new URL(input.url);
	if (url.origin !== fixture.origin || !url.pathname.startsWith('/v2/'))
		return workerFetch(input, init);
	if (
		url.searchParams.get('measure') !== 'alert_counts' &&
		!url.pathname.endsWith('/schedule-index') &&
		fixture.scope !== 'overview-stream' &&
		fixture.scope !== 'overview-stop-ranking' &&
		!(fixture.scope === 'record-yesterday' && url.pathname === '/v2/cities') &&
		!(fixture.scope === 'stops-search' && url.searchParams.get('group') === 'stop_id')
	)
		return workerFetch(input, init);
	const headers = new Headers(input.headers);
	headers.set(header, fixture.scope);
	return workerFetch(new Request(input, { headers }), init);
};

export default {
	fetch(request, env, ctx) {
		const origin = env.QUESTION_FIXTURE_ORIGIN;
		const scope = request.headers.get(header);
		return context.run(origin && scope && !env.QUESTION_PROXY ? { origin, scope } : null, () =>
			worker.fetch(request, env, ctx),
		);
	},
};
