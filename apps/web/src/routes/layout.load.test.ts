import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
	bootProvider: vi.fn(),
	serverV1Context: vi.fn(),
	getScheduleEdition: vi.fn(),
	getCityCatalog: vi.fn(),
}));

vi.mock('#lib/v1/boot.ts', () => ({
	bootProvider: (...args: unknown[]) => harness.bootProvider(...args),
}));

vi.mock('#lib/v1/serverContext.ts', () => ({
	serverV1Context: (...args: unknown[]) => harness.serverV1Context(...args),
}));

import { load as loadServerLayout } from './+layout.server';
vi.mock('#lib/server/engine.ts', () => ({
	getCityCatalog: (...args: unknown[]) => harness.getCityCatalog(...args),
	getScheduleEdition: (...args: unknown[]) => harness.getScheduleEdition(...args),
}));
import { load as loadUniversalLayout } from './+layout';

const manifest = {
	provider: 'stm',
	generated_utc: '2026-07-15T12:00:00Z',
	labels: {},
};

function v1(lang: 'en' | 'fr', version: string) {
	return { manifest: { ...manifest, version }, labels: {}, lang };
}

function selection(context: ReturnType<typeof v1> | null) {
	return {
		providerId: 'stm',
		provider: null,
		providers: [],
		discoveryError: false,
		redirectHref: null,
		v1: context,
	};
}

const city = {
	id: 'stm',
	labels: {
		en: { city: 'Montréal', operator: 'Transit' },
		fr: { city: 'Montréal', operator: 'Transport' },
	},
	timezone: 'America/Toronto',
	bounds: [-74, 45, -73, 46],
	inputs: { vehicle_positions: true },
	alert_links: {},
	lines_without_live_data: [],
};

function serverEvent(lang: 'fr' | undefined, pathname: string, binding = true) {
	return {
		params: lang ? { lang } : {},
		url: new URL(`https://transit.yesid.dev${pathname}`),
		fetch: vi.fn(),
		request: new Request(`https://transit.yesid.dev${pathname}`),
		route: { id: '/[[lang=locale]]' + new URL(pathname, 'http://localhost').pathname },
		locals: { v1Cache: new Map<string, unknown>() } as {
			v1Cache: Map<string, unknown>;
			locale?: 'en' | 'fr';
		},
		platform: binding ? { env: { DATA: { fetch: vi.fn() } } } : undefined,
	} as unknown as Parameters<typeof loadServerLayout>[0];
}

function universalEvent(
	lang: 'en' | 'fr',
	pathname: string,
	serverV1: ReturnType<typeof v1> | null,
	serverBoot: 'succeeded' | 'failed' = serverV1 ? 'succeeded' : 'failed',
) {
	return {
		url: new URL(`https://transit.yesid.dev${pathname}`),
		fetch: vi.fn(),
		data: { ...selection(serverV1), lang, serverBoot },
	} as unknown as Parameters<typeof loadUniversalLayout>[0];
}

beforeEach(() => {
	harness.bootProvider.mockReset();
	harness.bootProvider.mockResolvedValue(selection(null));
	harness.serverV1Context.mockReset();
	harness.getScheduleEdition.mockReset().mockResolvedValue({ routes: [] });
});

describe('root server layout boot', () => {
	it.each([
		['', '/?frameMode=record'],
		['/lines', '/lines'],
		['/lines/[id]', '/lines/24?tab=schedule'],
		['/stop/[id]', '/stop/S1'],
		['/status', '/status'],
		['/receipt', '/receipt?date=2026-08-30'],
		['/metrics/archive', '/metrics/archive'],
	])('leaves snapshot transport idle on %s', async (route, path) => {
		const request = serverEvent(undefined, path);
		Object.assign(request.route, { id: '/[[lang=locale]]' + route });
		await expect(loadServerLayout(request)).resolves.toMatchObject({ loadSnapshots: false });
		expect(harness.serverV1Context).not.toHaveBeenCalled();
		expect(harness.bootProvider.mock.calls[0]?.[5]).toBe(false);
	});
	it('loads the clean edition for the selected city even without snapshot boot', async () => {
		const selected = { ...selection(null), provider: city };
		harness.bootProvider.mockResolvedValue(selected);
		const schedule = {
			date: '2026-11-21',
			routes: [{ id: '1-373', short: '1', type: 1 }],
			stops: [],
		};
		harness.getScheduleEdition.mockResolvedValueOnce(schedule);
		const request = serverEvent(undefined, '/network?frameMode=record');
		await expect(loadServerLayout(request)).resolves.toMatchObject({ schedule, v1: null });
		expect(harness.getScheduleEdition).toHaveBeenCalledExactlyOnceWith('stm', null);
	});
	it('passes request-only location to provider selection without returning coordinates', async () => {
		const request = serverEvent('fr', '/network');
		const location = { lat: 45.42, lon: -75.7 };
		Object.assign(request.locals, { approximateLocation: location });
		const result = await loadServerLayout(request);
		expect(harness.bootProvider).toHaveBeenCalledWith(
			request.url,
			'fr',
			expect.any(Function),
			undefined,
			location,
			false,
		);
		expect(JSON.stringify(result)).not.toContain('45.42');
	});
	it('prevents caching a successful fallback boot when catalog discovery failed', async () => {
		const request = serverEvent(undefined, '/');
		const setHeaders = vi.fn();
		Object.assign(request, { setHeaders });
		harness.bootProvider.mockResolvedValue({ ...selection(v1('en', 'one')), discoveryError: true });
		await loadServerLayout(request);
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});
	it.each([true, false])(
		'builds live context from the city declaration without a snapshot read (binding: %s)',
		async (binding) => {
			const request = serverEvent('fr', '/network', binding);
			harness.bootProvider.mockResolvedValue({ ...selection(null), provider: city });
			harness.getScheduleEdition.mockResolvedValue({ date: '2026-11-21', routes: [], stops: [] });

			await expect(loadServerLayout(request)).resolves.toMatchObject({
				lang: 'fr',
				v1: { lang: 'fr', manifest: { provider: 'stm', dataset_version: '2026-11-21' } },
				serverBoot: 'succeeded',
			});
			expect(harness.serverV1Context).not.toHaveBeenCalled();
			expect(harness.bootProvider).toHaveBeenCalledWith(
				request.url,
				'fr',
				expect.any(Function),
				undefined,
				undefined,
				false,
			);
		},
	);

	it('keeps the unprefixed locale fallback when no validated locale param is present', async () => {
		const request = serverEvent(undefined, '/fr/network', false);

		await expect(loadServerLayout(request)).resolves.toMatchObject({
			lang: 'en',
			v1: null,
			serverBoot: 'failed',
		});
	});

	it('uses the request locale when an error render has no validated route param', async () => {
		const request = serverEvent(undefined, '/fr/missing-route', false);
		request.locals.locale = 'fr';

		await expect(loadServerLayout(request)).resolves.toMatchObject({
			lang: 'fr',
			v1: null,
			serverBoot: 'failed',
		});
	});

	it('records one failed bound boot so the universal loader does not repeat it server-side', async () => {
		const request = serverEvent(undefined, '/network');
		harness.serverV1Context.mockReturnValue({ fetch: vi.fn(), cache: request.locals.v1Cache });
		harness.bootProvider.mockResolvedValue(selection(null));

		await expect(loadServerLayout(request)).resolves.toMatchObject({
			lang: 'en',
			v1: null,
			serverBoot: 'failed',
		});
	});
});

describe('root universal layout boot', () => {
	it('uses the locale supplied by the server layout without tracking the pathname', async () => {
		const booted = v1('fr', 'one');
		const request = universalEvent('fr', '/network', booted);

		expect(loadUniversalLayout(request)).toMatchObject({
			lang: 'fr',
			v1: booted,
			v1Error: false,
		});
		expect(harness.bootProvider).not.toHaveBeenCalled();
	});

	it('reloads server provider data on every invocation so invalidateAll stays effective', async () => {
		const request = serverEvent('fr', '/network', false);
		const first = v1('fr', 'one');
		const second = v1('fr', 'two');
		harness.bootProvider
			.mockResolvedValueOnce(selection(first))
			.mockResolvedValueOnce(selection(second));
		expect(await loadServerLayout(request)).toMatchObject({ v1: first });
		expect(await loadServerLayout(request)).toMatchObject({ v1: second });
	});

	it('does not repeat a failed bound boot through the universal server path', async () => {
		const request = universalEvent('en', '/network', null, 'failed');

		expect(loadUniversalLayout(request)).toMatchObject({
			lang: 'en',
			v1: null,
			v1Error: true,
		});
		expect(harness.bootProvider).not.toHaveBeenCalled();
	});
});
