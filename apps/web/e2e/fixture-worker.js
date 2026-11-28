import { AsyncLocalStorage } from 'node:async_hooks';
import worker from '../.svelte-kit/cloudflare/_worker.js';
import { fixtureWorkerBindings } from './fixture-worker-bindings.js';

const header = 'x-transit-fixture-scope';
const scheduleHoldHeader = 'x-transit-fixture-schedule-hold';
// A test that holds its Record answers names its own hold, so tests on the same dates never
// hold or release each other's questions.
const holdHeader = 'x-transit-fixture-hold';
const context = new AsyncLocalStorage();
const workerFetch = globalThis.fetch.bind(globalThis);

// Each held scenario belongs to one incoming request, including its streamed answers.
globalThis.fetch = (input, init) => {
	const fixture = context.getStore();
	if (!fixture || !(input instanceof Request)) return workerFetch(input, init);
	const url = new URL(input.url);
	if (url.origin !== fixture.origin || !url.pathname.startsWith('/v2/'))
		return workerFetch(input, init);
	const holding =
		Boolean(fixture.hold) && /\/(?:measure|ranking|data-health|how-we-measure)$/.test(url.pathname);
	const scoped = !(
		url.searchParams.get('measure') !== 'alert_counts' &&
		!url.pathname.endsWith('/schedule-index') &&
		fixture.scope !== 'overview-stream' &&
		fixture.scope !== 'overview-stop-ranking' &&
		!(fixture.scope === 'record-yesterday' && url.pathname === '/v2/cities') &&
		!(fixture.scope?.startsWith('stops-search:') && url.searchParams.get('group') === 'stop_id')
	);
	if (!scoped && !holding) return workerFetch(input, init);
	const headers = new Headers(input.headers);
	if (scoped && fixture.scope) headers.set(header, fixture.scope);
	if (holding) headers.set(holdHeader, fixture.hold);
	if (fixture.scheduleHold && url.pathname.endsWith('/schedule-index')) {
		headers.set(scheduleHoldHeader, fixture.scheduleHold);
	}
	return workerFetch(new Request(input, { headers }), init);
};

export default {
	fetch(request, env, ctx) {
		const origin = env.QUESTION_FIXTURE_ORIGIN;
		const scope = request.headers.get(header);
		const scheduleHold = request.headers.get(scheduleHoldHeader);
		const hold = request.headers.get(holdHeader);
		const binding = Object.hasOwn(fixtureWorkerBindings, scope) && fixtureWorkerBindings[scope];
		if (binding && env[binding]) {
			return env[binding].fetch(request);
		}
		return context.run(
			origin && (scope || scheduleHold || hold) && !env.QUESTION_PROXY
				? { origin, scope, scheduleHold, hold }
				: null,
			() => worker.fetch(request, env, ctx),
		);
	},
};
