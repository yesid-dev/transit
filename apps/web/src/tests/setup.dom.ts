vi.mock('$app/env/public', async () => (await import('./publicEnv.ts')).PUBLIC_ENV);
import { vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {}, waitUntil: () => {} }));
// Outside a served page there is no request event; a test can serve one with mockReturnValue.
vi.mock('$app/server', () => ({
	getRequestEvent: vi.fn(() => {
		throw new Error('No page is being served');
	}),
}));
import { clock } from '@yesid/ui/state';
import '@testing-library/jest-dom/vitest';
import { configureTransitUi } from '#lib/ui/configure.ts';

import { dataRefresh } from '#lib/stores/refresh.svelte.ts';
import { configureV1Runtime } from '#lib/v1/runtime.ts';
import { Storage } from 'happy-dom';

// Node 25+ ships its own Web Storage globals, and Vitest keeps them over happy-dom's. Node's
// localStorage is undefined without --localstorage-file, so DOM tests get happy-dom storage.
for (const name of ['localStorage', 'sessionStorage'] as const) {
	if (!(globalThis[name] instanceof Storage)) {
		Object.defineProperty(globalThis, name, {
			value: new Storage(),
			configurable: true,
			writable: true,
		});
	}
}

configureV1Runtime({ clock, refresh: dataRefresh });
configureTransitUi();
