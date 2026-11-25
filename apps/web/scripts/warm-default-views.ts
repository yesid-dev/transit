import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	defaultCityQuestions,
	defaultPeriod,
	sharedDefaultQuestion,
	type WarmCity,
} from '../src/lib/server/defaultQuestions.ts';
import { citiesQuestion, questionUrl } from '../src/lib/server/engineQuestion.ts';

// Keep one request in flight and leave room below the public limit of 30 new
// questions per minute, even when every request is a cache miss.
const START_INTERVAL_MS = 2_200;
const REQUEST_TIMEOUT_MS = 30_000;

function requestOptions() {
	return { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' } as const;
}

export async function warmQuestions(
	urls: string[],
	{
		fetcher = fetch,
		now = () => performance.now(),
		wait = delay,
	}: { fetcher?: typeof fetch; now?: () => number; wait?: (ms: number) => Promise<void> } = {},
) {
	const start = now();
	let nextStart = start;
	const requests = [];
	for (const url of urls) {
		const pause = nextStart - now();
		if (pause > 0) await wait(pause);
		const sent = now();
		nextStart = sent + START_INTERVAL_MS;
		let outcome: 'answered' | 'busy' | 'deferred' | 'failed' = 'failed';
		let answer: string | null = null;
		let cache: string | null = null;
		let edge: string | null = null;
		try {
			const response = await fetcher(url, requestOptions());
			answer = response.headers.get('x-transit-answer');
			cache = response.headers.get('cache-status');
			edge = response.headers.get('cf-ray')?.split('-').at(-1) ?? null;
			if (response.status === 409) {
				const { reason } = await response.json();
				if (
					reason === 'segment_runs_version_required' ||
					reason === 'network_corridors_unsupported' ||
					reason === 'delay_distribution_unsupported'
				)
					outcome = 'deferred';
			} else {
				await response.arrayBuffer();
				if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
					if (answer !== 'last-good') outcome = 'answered';
				} else if (response.status === 503 && response.headers.has('retry-after')) {
					outcome = 'busy';
				}
			}
		} catch {
			// A transport failure is counted and the remaining questions still run.
		}
		requests.push({ outcome, answer, cache, edge, elapsedMs: Math.round(now() - sent) });
	}
	return { requests, elapsedMs: Math.round(now() - start) };
}

async function publicCities(): Promise<WarmCity[]> {
	const response = await fetch(questionUrl(citiesQuestion), {
		...requestOptions(),
		headers: { 'cache-control': 'no-cache' },
	});
	if (!response.ok) throw new Error(`Public city catalog returned HTTP ${response.status}`);
	const { providers } = (await response.json()) as { providers?: WarmCity[] };
	if (
		!Array.isArray(providers) ||
		providers.length === 0 ||
		providers.some(
			(city) =>
				!/^[a-z0-9][a-z0-9_-]*$/.test(city?.id) ||
				typeof city.timezone !== 'string' ||
				typeof city.inputs !== 'object' ||
				!city.inputs,
		) ||
		new Set(providers.map(({ id }) => id)).size !== providers.length
	) {
		throw new Error('Invalid public city catalog');
	}
	return providers;
}

async function main(args: string[]) {
	const dryRun = args.includes('--dry-run');
	const verifyCache = args.includes('--verify-cache');
	if (
		args.some((arg) => arg !== '--dry-run' && arg !== '--verify-cache') ||
		(dryRun && verifyCache)
	) {
		throw new Error('Usage: bun warm-default-views.ts [--dry-run | --verify-cache]');
	}
	const started = performance.now();
	const now = new Date();
	const cities = await publicCities();
	const root = process.env.ENGINE_CLEAN_ROOT;
	const version = process.env.ENGINE_CLEANING_VERSION;
	if (!dryRun && (!root || !version || !/^[1-9][0-9]*$/.test(version))) {
		throw new Error('Set ENGINE_CLEAN_ROOT and ENGINE_CLEANING_VERSION for the local clean mirror');
	}
	const counts: Record<string, number> = {};
	const periods: { from: string; to: string }[] = [];
	const missing: string[] = [];
	const urls: string[] = [];
	for (const city of cities) {
		const period = defaultPeriod(now, city.timezone, city.record_through);
		const healthPeriod = defaultPeriod(now, city.timezone);
		if (!period || !healthPeriod) throw new Error('Default Record period unavailable');
		periods.push(period);
		if (root && version && !dryRun) {
			try {
				await access(join(root, city.id, period.to, `v${version}`, 'manifest.json'));
			} catch {
				missing.push(city.id);
				continue;
			}
		}
		const cityUrls = defaultCityQuestions(city, period, healthPeriod);
		counts[city.id] = cityUrls.length;
		urls.push(...cityUrls);
	}
	urls.push(sharedDefaultQuestion);
	if (dryRun) {
		console.log(urls.join('\n'));
		console.log(JSON.stringify({ perCity: counts, shared: 1, total: urls.length }));
		return;
	}

	const probeUrl = verifyCache && urls[0] !== sharedDefaultQuestion ? urls[0] : null;
	const { requests } = await warmQuestions(probeUrl ? [...urls, probeUrl] : urls);
	const repeat = probeUrl ? requests.pop() : undefined;
	const answered = requests.filter(({ outcome }) => outcome === 'answered').length;
	const busy = requests.filter(({ outcome }) => outcome === 'busy').length;
	const deferred = requests.filter(({ outcome }) => outcome === 'deferred').length;
	const failed = requests.length - answered - busy - deferred;
	console.log(
		JSON.stringify({
			period: {
				from: periods.map(({ from }) => from).sort()[0],
				to: periods
					.map(({ to }) => to)
					.sort()
					.at(-1),
			},
			perCity: counts,
			shared: 1,
			missing,
			sent: requests.length,
			answered,
			busy,
			deferred,
			failed,
			elapsedMs: Math.round(performance.now() - started),
			...(repeat && { probe: { first: requests[0], repeat } }),
		}),
	);
	if (missing.length || busy || failed || (verifyCache && !repeat?.cache?.includes('; hit'))) {
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2)).catch((error: Error) => {
		console.error(`Transit warm-up: ${error.message}`);
		process.exitCode = 1;
	});
}
