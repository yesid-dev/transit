import { describe, expect, it, vi } from 'vitest';
import { HistoryArtifactContractError } from '#lib/v1/history/index.ts';
import { sha256Hex } from '#lib/v1/http.ts';
import { r2Adapter } from './r2';

vi.mock('$app/env', () => ({ browser: true }));

const ISO = '2026-03-31T12:00:00Z';
const GENERATION = 'a'.repeat(64);

function manifest(historic: Record<string, unknown> = {}) {
	return {
		provider: 'stm',
		display_name: 'STM',
		bbox: [-74, 45, -73, 46],
		attribution: 'STM',
		dataset_version: 'v1',
		labels: {},
		files: { live: { generated_utc: ISO }, historic },
		surfaces: [],
	};
}

function collectionIndex(family: 'network' | 'lines' | 'stops', entityId?: string) {
	return {
		generated_utc: ISO,
		family,
		selection_mode: 'range',
		entity_id: entityId ?? null,
		collection_generation_id: GENERATION,
		partitions: [],
		metrics: [],
	};
}

function directory(family: 'lines' | 'stops') {
	return {
		generated_utc: ISO,
		family,
		selection_mode: 'range',
		collection_generation_id: GENERATION,
		entities: [],
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

async function payloadSha(value: unknown): Promise<string> {
	return sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
}

describe('r2 historic collection ports', () => {
	it('uses contract-default index paths and returns null only for 404', async () => {
		const request = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/manifest.json')) return json(manifest());
			if (url.endsWith('/historic/history/index.json')) return json({}, 404);
			throw new Error(`unexpected URL ${url}`);
		});
		const ctx = { fetch: request as unknown as typeof fetch, cache: new Map<string, unknown>() };

		await expect(r2Adapter.historic.historyIndex(ctx)).resolves.toBeNull();
		expect(request.mock.calls.map(([input]) => String(input))).toContain(
			'/data/v1/stm/historic/history/index.json',
		);
	});

	it('throws non-404 index failures instead of treating them as rollout absence', async () => {
		const request = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/manifest.json')) return json(manifest());
			return json({}, 500);
		});

		await expect(
			r2Adapter.historic.historyIndex({
				fetch: request as unknown as typeof fetch,
				cache: new Map<string, unknown>(),
			}),
		).rejects.toThrow('HTTP 500');
	});

	it('uses exact fixed family discovery paths and lowercase UTF-8 entity IDs', async () => {
		const controller = new AbortController();
		const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(init?.signal).toBe(controller.signal);
			expect(init?.cache).toBe('default');
			if (url.endsWith('/historic/history/lines/index.json')) return json(directory('lines'));
			if (url.endsWith('/historic/history/stops/index.json')) return json(directory('stops'));
			if (url.endsWith('/historic/history/lines/412f42/index.json')) {
				return json(collectionIndex('lines', 'A/B'));
			}
			if (url.endsWith('/historic/history/stops/2e2e/index.json')) {
				return json(collectionIndex('stops', '..'));
			}
			throw new Error(`unexpected URL ${url}`);
		});
		const ctx = { fetch: request as unknown as typeof fetch, signal: controller.signal };

		await expect(
			r2Adapter.historic.lineHistoryDirectory('historic/history/lines/index.json', ctx),
		).resolves.toMatchObject({
			family: 'lines',
		});
		await expect(
			r2Adapter.historic.stopHistoryDirectory('historic/history/stops/index.json', ctx),
		).resolves.toMatchObject({
			family: 'stops',
		});
		await expect(
			r2Adapter.historic.lineHistoryIndex('A/B', 'historic/history/lines/412f42/index.json', ctx),
		).resolves.toMatchObject({ entity_id: 'A/B' });
		await expect(
			r2Adapter.historic.stopHistoryIndex('..', 'historic/history/stops/2e2e/index.json', ctx),
		).resolves.toMatchObject({ entity_id: '..' });
		expect(request.mock.calls.map(([input]) => String(input))).toEqual([
			'/data/v1/stm/historic/history/lines/index.json',
			'/data/v1/stm/historic/history/stops/index.json',
			'/data/v1/stm/historic/history/lines/412f42/index.json',
			'/data/v1/stm/historic/history/stops/2e2e/index.json',
		]);
	});

	it('reads exact versioned family, directory, and awkward-entity pointer paths', async () => {
		const lines = directory('lines');
		const entity = collectionIndex('lines', 'A/B');
		const directoryPath = `historic/history/lines/generations/${await payloadSha(lines)}/index.json`;
		const entityPath = `historic/history/lines/412f42/generations/${await payloadSha(entity)}/index.json`;
		const request = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith(`/${directoryPath}`)) return json(lines);
			if (url.endsWith(`/${entityPath}`)) return json(entity);
			throw new Error(`unexpected URL ${url}`);
		});
		const ctx = { fetch: request as unknown as typeof fetch };

		await expect(
			r2Adapter.historic.lineHistoryDirectory(directoryPath, ctx),
		).resolves.toMatchObject({
			family: 'lines',
		});
		await expect(
			r2Adapter.historic.lineHistoryIndex('A/B', entityPath, ctx),
		).resolves.toMatchObject({ entity_id: 'A/B' });
		expect(request.mock.calls.map(([input]) => String(input))).toEqual([
			`/data/v1/stm/${directoryPath}`,
			`/data/v1/stm/${entityPath}`,
		]);
	});

	it('rejects a versioned pointer whose path SHA does not match the exact response bytes', async () => {
		const path = `historic/history/lines/generations/${'0'.repeat(64)}/index.json`;
		const request = vi.fn(async () => json(directory('lines')));

		await expect(
			r2Adapter.historic.lineHistoryDirectory(path, {
				fetch: request as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({
			name: 'HistoryArtifactContractError',
			path,
			message: expect.stringContaining('payload SHA-256 mismatch'),
		});
		expect(request).toHaveBeenCalledOnce();
	});

	it('rejects unsafe or cross-family pointer paths before fetch', async () => {
		const request = vi.fn(async () => json(directory('lines')));
		const ctx = { fetch: request as unknown as typeof fetch };
		const versioned = `generations/${'b'.repeat(64)}/index.json`;

		await expect(
			r2Adapter.historic.lineHistoryDirectory(`historic/history/stops/${versioned}`, ctx),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);
		await expect(
			r2Adapter.historic.lineHistoryIndex('A/B', `historic/history/lines/2e2e/${versioned}`, ctx),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);
		await expect(
			r2Adapter.historic.lineHistoryIndex(
				'A/B',
				`historic/history/lines/412f42/${versioned}?raw=1`,
				ctx,
			),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);
		expect(request).not.toHaveBeenCalled();
	});

	it('rejects unsafe or cross-entity family partition paths before fetch', async () => {
		const request = vi.fn(async () => json({}));
		const ctx = { fetch: request as unknown as typeof fetch };

		await expect(
			r2Adapter.historic.lineHistoryPartition('A/B', 'https://evil.test/x.json', ctx),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);
		await expect(
			r2Adapter.historic.lineHistoryPartition(
				'A/B',
				`historic/history/lines/2e2e/generations/${GENERATION}/2026-03.json`,
				ctx,
			),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);
		expect(request).not.toHaveBeenCalled();
	});

	it('fresh parent reads use a unique query plus browser cache reload', async () => {
		const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.cache).toBe('reload');
			return json(directory('lines'));
		});
		const ctx = {
			fetch: request as unknown as typeof fetch,
			freshHistoryParent: true,
		};

		await r2Adapter.historic.lineHistoryDirectory('historic/history/lines/index.json', ctx);
		await r2Adapter.historic.lineHistoryDirectory('historic/history/lines/index.json', ctx);

		const urls = request.mock.calls.map(([input]) => String(input));
		expect(urls[0]).toMatch(
			/^\/data\/v1\/stm\/historic\/history\/lines\/index\.json\?history_refresh=/,
		);
		expect(urls[1]).toMatch(
			/^\/data\/v1\/stm\/historic\/history\/lines\/index\.json\?history_refresh=/,
		);
		expect(urls[1]).not.toBe(urls[0]);
	});

	it('cache-busts a fixed entity-index URL when recovery reloads the stale child', async () => {
		const controller = new AbortController();
		const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.cache).toBe('reload');
			expect(init?.signal).toBe(controller.signal);
			return json(collectionIndex('lines', 'A/B'));
		});

		await expect(
			r2Adapter.historic.lineHistoryIndex('A/B', 'historic/history/lines/412f42/index.json', {
				fetch: request as unknown as typeof fetch,
				signal: controller.signal,
				freshHistoryParent: true,
			}),
		).resolves.toMatchObject({ entity_id: 'A/B' });

		expect(String(request.mock.calls[0]?.[0])).toMatch(
			/^\/data\/v1\/stm\/historic\/history\/lines\/412f42\/index\.json\?history_refresh=/,
		);
	});

	it('keeps every new discovery/index/partition 404 transport-null', async () => {
		const request = vi.fn(async () => json({}, 404));
		const ctx = { fetch: request as unknown as typeof fetch };
		const path = `historic/history/lines/412f42/generations/${GENERATION}/2026-03.json`;

		await expect(r2Adapter.historic.historyIndex(ctx)).resolves.toBeNull();
		await expect(
			r2Adapter.historic.lineHistoryDirectory('historic/history/lines/index.json', ctx),
		).resolves.toBeNull();
		await expect(
			r2Adapter.historic.stopHistoryDirectory('historic/history/stops/index.json', ctx),
		).resolves.toBeNull();
		await expect(
			r2Adapter.historic.lineHistoryIndex('A/B', 'historic/history/lines/412f42/index.json', ctx),
		).resolves.toBeNull();
		await expect(
			r2Adapter.historic.stopHistoryIndex('..', 'historic/history/stops/2e2e/index.json', ctx),
		).resolves.toBeNull();
		await expect(r2Adapter.historic.lineHistoryPartition('A/B', path, ctx)).resolves.toBeNull();
	});
});
