import { expect, it } from 'vitest';
import { GET } from '../../routes/[[lang=locale]]/manifest.webmanifest/+server';

it('installs with a provider-neutral name in either locale', async () => {
	for (const lang of [undefined, 'fr'] as const) {
		const response = GET({ params: { lang } } as Parameters<typeof GET>[0]);
		const manifest = await (await response).json();
		expect(manifest.name).toBe('Transit');
		expect(manifest.short_name).toBe('Transit');
		expect(manifest.lang).toBe(lang ?? 'en');
		expect(manifest.description).not.toMatch(/STM|Montréal/);
	}
});

it('opens the French install on the French home page, as one app with the English one', async () => {
	const read = async (lang?: 'fr') =>
		(await GET({ params: { lang } } as Parameters<typeof GET>[0])).json();
	const [en, fr] = await Promise.all([read(), read('fr')]);
	expect(en.start_url).toBe('/');
	expect(fr.start_url).toBe('/fr');
	expect(fr.id).toBe(en.id);
	expect(fr.icons).toContainEqual(
		expect.objectContaining({ src: '/apple-touch-icon-180.png', sizes: '180x180' }),
	);
});

it('serves the touch icon at the paths browsers ask for without reading the page', async () => {
	const { readFileSync } = await import('node:fs');
	const icon = (name: string) => readFileSync(new URL(`../../../static/${name}`, import.meta.url));
	const source = icon('apple-touch-icon-180.png');
	expect(icon('apple-touch-icon.png').equals(source)).toBe(true);
	expect(icon('apple-touch-icon-precomposed.png').equals(source)).toBe(true);
});
