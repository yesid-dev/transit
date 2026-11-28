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
