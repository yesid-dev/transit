import { beforeEach, describe, expect, it, vi } from 'vitest';
import catalog from '../../../e2e/providers.json';
import { GET } from './+server';

const engine = vi.hoisted(() => ({ getCityCatalog: vi.fn(), getScheduleEdition: vi.fn() }));
vi.mock('#lib/server/engine.ts', () => engine);
vi.mock('#lib/site/config.ts', () => ({
	readPublicSiteConfig: () => ({ siteOrigin: 'https://transit1.yesid.dev', indexing: true }),
}));

const origin = 'https://transit1.yesid.dev';

function event(search = '') {
	const url = new URL(origin + '/sitemap.xml' + search);
	const request = new Request(url);
	return { url, request } as Parameters<typeof GET>[0];
}

beforeEach(() => {
	engine.getCityCatalog.mockReset().mockResolvedValue(catalog);
	engine.getScheduleEdition.mockReset().mockImplementation(async (id: string) => ({
		routes: [{ id: id === 'stm' ? '11' : '5' }],
		stops: [{ id: id === 'stm' ? '10001' : 'OC1' }],
	}));
});

describe('sitemap.xml', () => {
	it('lists bilingual addresses from every city’s clean schedule edition', async () => {
		const response = await GET(event());
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/xml');
		const xml = await response.text();
		expect(xml).toContain('<loc>' + origin + '/fr/lines/11</loc>');
		expect(xml).toContain('<loc>' + origin + '/stop/10001</loc>');
		expect(xml).toContain('<loc>' + origin + '/lines/5?provider=octranspo</loc>');
		expect(xml).toContain('hreflang="fr" href="' + origin + '/fr/stop/OC1?provider=octranspo"');
		expect(xml).not.toContain('provider=sto');
	});

	it('keeps another city’s addresses when a schedule is unavailable', async () => {
		engine.getScheduleEdition.mockImplementation(async (id) =>
			id === 'stm' ? null : { routes: [{ id: '5' }], stops: [] },
		);
		const xml = await (await GET(event())).text();
		expect(xml).toContain('/lines/5?provider=octranspo');
		expect(xml).not.toContain('/lines/11');
	});

	it.each(['unknown', 'sto'])('normalizes %s before requesting a schedule', async (provider) => {
		const response = await GET(event('?provider=' + provider));
		expect(response.status).toBe(307);
		expect(response.headers.get('location')).toBe('/sitemap.xml?provider=stm');
		expect(engine.getScheduleEdition).not.toHaveBeenCalled();
	});

	it('falls back to static routes when city discovery is unavailable', async () => {
		engine.getCityCatalog.mockRejectedValue(new Error('catalog unavailable'));
		const xml = await (await GET(event())).text();
		expect(xml).toContain('<loc>' + origin + '/vehicles</loc>');
		expect(xml).not.toContain('/lines/');
		expect(engine.getScheduleEdition).not.toHaveBeenCalled();
	});
});
