import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/env/public', async () => ({
	...(await import('./../../tests/publicEnv.ts')).PUBLIC_ENV,
	...{},
}));

import { r2Adapter } from '#lib/v1/adapter/r2.ts';
import { clearBrowserAdapterManifestForTests } from '#lib/v1/adapter/browserManifest.ts';
import OptionalV1ContextHarness from './__fixtures__/OptionalV1ContextHarness.svelte';

const ISO = '2026-07-15T12:00:00Z';

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('optional root v1 context recovery', () => {
	afterEach(() => {
		clearBrowserAdapterManifestForTests();
		vi.unstubAllGlobals();
	});

	it('loads the default city schedule while the root context is still pending', async () => {
		render(OptionalV1ContextHarness, { props: { context: undefined } });
		const request = vi.fn(async () =>
			json({ schedule: { date: ISO.slice(0, 10), stops: [], routes: [] } }),
		);
		vi.stubGlobal('fetch', request);

		await expect(r2Adapter.static.routesIndex()).resolves.toMatchObject({ routes: [] });
		expect(request).toHaveBeenCalledExactlyOnceWith('/api/schedule-edition?city=stm');
	});
});
