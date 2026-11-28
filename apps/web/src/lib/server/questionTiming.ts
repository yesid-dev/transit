import { getRequestEvent } from '$app/server';

type QuestionTiming = {
	name: string;
	settled: boolean;
	webMs?: number;
	source?: string;
	cache?: string;
	engineMs?: number;
	queueMs?: number;
};

const byPage = new WeakMap<object, QuestionTiming[]>();

function servedPage() {
	try {
		return getRequestEvent();
	} catch {
		return null;
	}
}

/**
 * What the proxy's Server-Timing says about one answer: where it came from, whether a cache held
 * it, and the engine's queue and query time. Unknown or malformed metrics are left out.
 */
export function readProxyTiming(header: string | null) {
	const timing: Pick<QuestionTiming, 'source' | 'cache' | 'engineMs' | 'queueMs'> = {};
	for (const metric of (header ?? '').split(',')) {
		const [name, ...parameters] = metric.split(';').map((part) => part.trim());
		const value = (key: string) =>
			parameters
				.find((parameter) => parameter.startsWith(`${key}=`))
				?.slice(key.length + 1)
				.replace(/^"(.*)"$/, '$1');
		const description = value('desc');
		const duration = Number(value('dur'));
		if (name === 'src' && description && /^[a-z-]{1,16}$/.test(description))
			timing.source = description;
		else if (name === 'cache' && description && /^(?:hit|miss|stale)$/.test(description))
			timing.cache = description;
		else if (name === 'engine' && value('dur') !== undefined && Number.isFinite(duration))
			timing.engineMs = duration;
		else if (name === 'queue' && value('dur') !== undefined && Number.isFinite(duration))
			timing.queueMs = duration;
	}
	return timing;
}

/**
 * Starts timing one engine question for the page being served. The returned function settles it
 * with the answer's headers, once; outside a page request it does nothing.
 */
export function timeQuestion(name: string) {
	const page = servedPage();
	if (!page) return () => {};
	let timings = byPage.get(page);
	if (!timings) byPage.set(page, (timings = []));
	const timing: QuestionTiming = {
		name: /^[a-z0-9_/-]{1,40}$/.test(name) ? name : 'question',
		settled: false,
	};
	timings.push(timing);
	const started = performance.now();
	return (headers?: Headers | null) => {
		if (timing.settled) return;
		timing.settled = true;
		timing.webMs = performance.now() - started;
		Object.assign(timing, readProxyTiming(headers?.get('server-timing') ?? null));
	};
}

const ms = (value: number) => value.toFixed(1);

/**
 * The document's Server-Timing: the page's questions answered before its headers left, by
 * source, their engine and queue time and the slowest one, and how many were still waiting (they
 * stream in after the first byte).
 */
export function documentServerTiming(page: object): string | null {
	const timings = byPage.get(page);
	if (!timings?.length) return null;
	const answered = timings.filter(({ settled }) => settled);
	const sources = new Map<string, number>();
	for (const { cache, source } of answered) {
		const key = cache === 'hit' || cache === 'stale' ? 'cache' : (source ?? 'web');
		sources.set(key, (sources.get(key) ?? 0) + 1);
	}
	const bySource = [...sources].map(([source, count]) => `${source} ${count}`).join(', ');
	const metrics = [
		`questions;desc="answered ${answered.length}${bySource ? ` (${bySource})` : ''}, waiting ${timings.length - answered.length}"`,
	];
	const engine = answered.filter(({ engineMs }) => engineMs !== undefined);
	if (engine.length)
		metrics.push(`engine;dur=${ms(engine.reduce((sum, { engineMs }) => sum + engineMs!, 0))}`);
	const queue = answered.reduce((sum, { queueMs }) => sum + (queueMs ?? 0), 0);
	if (queue > 0) metrics.push(`queue;dur=${ms(queue)}`);
	const slowest = answered.reduce<QuestionTiming | null>(
		(worst, timing) => (!worst || (timing.webMs ?? 0) > (worst.webMs ?? 0) ? timing : worst),
		null,
	);
	if (slowest?.webMs !== undefined)
		metrics.push(`slowest;desc="${slowest.name}";dur=${ms(slowest.webMs)}`);
	return metrics.join(', ');
}
