import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	defaultCityQuestions,
	defaultPeriod,
	sharedDefaultQuestion,
	type WarmCity,
} from '../src/lib/server/defaultQuestions.ts';
import { frameClock, presetPeriod } from '../src/lib/site/frameState.ts';
import { citiesQuestion, questionUrl } from '../src/lib/server/engineQuestion.ts';

// Leave the engine slot available for rider traffic between background requests,
// including after slow responses. The public limit is 30 misses per minute.
const REQUEST_GAP_MS = 2_200;
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
	const requests = [];
	for (const url of urls) {
		if (requests.length) await wait(REQUEST_GAP_MS);
		const sent = now();
		let outcome: 'answered' | 'busy' | 'deferred' | 'failed' = 'failed';
		let hit = false;
		let edge: string | null = null;
		let status: number | null = null;
		try {
			const response = await fetcher(url, requestOptions());
			status = response.status;
			hit =
				response.headers.get('cache-status')?.includes('Transit; hit') === true ||
				response.headers.get('x-transit-cache')?.toLowerCase() === 'hit';
			edge = response.headers.get('cf-ray')?.match(/-([A-Z]{3})$/)?.[1] ?? null;
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
					if (response.headers.get('x-transit-answer') !== 'last-good') outcome = 'answered';
				} else if (response.status === 503 && response.headers.has('retry-after')) {
					outcome = 'busy';
				}
			}
		} catch {
			// A transport failure is counted and the remaining questions still run.
		}
		requests.push({ outcome, status, hit, edge, elapsedMs: Math.round(now() - sent) });
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
	const missing: string[] = [];
	const defaults = [];
	const followUps = [];
	for (const city of cities) {
		const clock = frameClock(city, now);
		const period = defaultPeriod(clock);
		if (!period) {
			missing.push(city.id);
			continue;
		}
		if (root && version && !dryRun) {
			try {
				await access(join(root, city.id, period.to, `v${version}`, 'manifest.json'));
			} catch {
				missing.push(city.id);
				continue;
			}
		}
		const defaultUrls = defaultCityQuestions(city, period);
		defaults.push({ city: city.id, pass: 'default', urls: defaultUrls });
		const uniqueUrls = new Set(defaultUrls);
		for (const preset of ['28-days', 'this-month'] as const) {
			const extraPeriod = presetPeriod(preset, clock);
			if (extraPeriod?.to === period.to) {
				for (const url of defaultCityQuestions(city, extraPeriod, extraPeriod)) uniqueUrls.add(url);
			}
		}
		const extraUrls = [...uniqueUrls].slice(defaultUrls.length);
		if (extraUrls.length) followUps.push({ city: city.id, pass: 'follow-up', urls: extraUrls });
	}
	const batches = [
		...defaults,
		{ city: null, pass: 'default', urls: [sharedDefaultQuestion] },
		...followUps,
	];
	if (dryRun) {
		console.log(batches.flatMap(({ urls }) => urls).join('\n'));
		return;
	}

	let sent = 0;
	let answered = 0;
	let busy = 0;
	let deferred = 0;
	let failed = 0;
	for (const { city, pass, urls } of batches) {
		if (sent) await delay(REQUEST_GAP_MS);
		const { requests, elapsedMs } = await warmQuestions(urls);
		const outcomes = { answered: 0, busy: 0, deferred: 0, failed: 0 };
		for (const [index, request] of requests.entries()) {
			outcomes[request.outcome]++;
			if (request.outcome !== 'answered') {
				console.log(JSON.stringify({ city, pass, url: urls[index], ...request }));
			}
		}
		console.log(JSON.stringify({ city, pass, sent: requests.length, ...outcomes, elapsedMs }));
		sent += requests.length;
		answered += outcomes.answered;
		busy += outcomes.busy;
		deferred += outcomes.deferred;
		failed += outcomes.failed;
	}
	let probesPassed = true;
	if (verifyCache) {
		const probeUrls = [
			...defaults.flatMap(({ urls }) => urls.slice(0, 1)),
			...defaults.flatMap(({ urls }) => urls.slice(1, 3)),
		].slice(0, 3);
		await delay(REQUEST_GAP_MS);
		const { requests } = await warmQuestions(probeUrls);
		const probes = requests.map((request, index) => ({ url: probeUrls[index], ...request }));
		console.log(JSON.stringify({ probes }));
		probesPassed =
			probes.length === 3 && probes.every(({ outcome, hit }) => outcome === 'answered' && hit);
	}
	console.log(
		JSON.stringify({
			missing,
			sent,
			answered,
			busy,
			deferred,
			failed,
			elapsedMs: Math.round(performance.now() - started),
		}),
	);
	if (missing.length || busy || failed || !probesPassed) {
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2)).catch((error: Error) => {
		console.error(`Transit warm-up: ${error.message}`);
		process.exitCode = 1;
	});
}
