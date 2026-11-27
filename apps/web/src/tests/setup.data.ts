vi.mock('$app/env/public', async () => (await import('./publicEnv.ts')).PUBLIC_ENV);
import { vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {}, waitUntil: () => {} }));
// Outside a served page there is no request event; a test can serve one with mockReturnValue.
vi.mock('$app/server', () => ({
	getRequestEvent: vi.fn(() => {
		throw new Error('No page is being served');
	}),
}));
export {};
