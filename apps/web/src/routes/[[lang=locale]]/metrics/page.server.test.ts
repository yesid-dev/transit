import { expect, it, vi } from 'vitest';
import { load } from './+page.server';

const fetcher = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());
vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: { fetch: fetcher } } }));

it('streams the global catalog without passing the selected city, dates or language upstream', async () => {
	let finish!: (response: Response) => void;
	fetcher.mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const url = new URL(
		'https://transit1.yesid.dev/fr/metrics?provider=octranspo&recordFrom=2026-11-11&recordTo=2026-11-14',
	);
	const request = new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.11' } });
	const data = await load({ url, request } as Parameters<typeof load>[0]);
	expect(data?.period).toMatchObject({ from: '2026-11-11', to: '2026-11-14' });
	expect(fetcher.mock.calls[0]?.[0].url).toBe('https://data.yesid.dev/v2/how-we-measure');
	expect(fetcher.mock.calls[0]?.[0].headers.get('x-transit-visitor-ip')).toBe('192.0.2.11');
	finish(Response.json({ invalid: 'Expected a registry array' }));
	await expect(data?.catalog).resolves.toEqual({ kind: 'unreachable' });
});
