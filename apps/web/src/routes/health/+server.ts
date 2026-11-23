import { env } from 'cloudflare:workers';
import { json } from '@sveltejs/kit';
import { getEngineHealth } from '#lib/server/engine.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const MEMO_MS = 30_000;
const FAILURE_MEMO_MS = 4_000;
type Probe = ReturnType<typeof getEngineHealth>;
let memo: { until: number; result: Probe } | undefined;

function probe() {
	if (memo && Date.now() < memo.until) return memo.result;
	const entry = { until: Date.now() + MEMO_MS, result: getEngineHealth() };
	memo = entry;
	void entry.result.then(({ engine }) => {
		if (engine !== 'ok') entry.until = Date.now() + FAILURE_MEMO_MS;
	});
	return entry.result;
}

export const GET: RequestHandler = async () => {
	const { engine, proxy } = await probe();
	const healthy = engine === 'ok';
	return json(
		{
			status: healthy ? 'ok' : 'unavailable',
			engine,
			proxy,
			service: 'transit1-web',
			commit: env.TRANSIT_COMMIT_SHA ?? null,
			branch: env.TRANSIT_BRANCH ?? null,
			time: new Date().toISOString(),
		},
		{ status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } },
	);
};
