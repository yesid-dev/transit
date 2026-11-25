import { readdirSync, readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { transitTerms } from '../src/lib/i18n/transitTerms.copy';

function terminalPanelChunk(): string {
	const chunks = new URL('../.svelte-kit/cloudflare/_app/immutable/chunks/', import.meta.url);
	const match = readdirSync(chunks).find((name) => {
		if (!name.endsWith('.js')) return false;
		const source = readFileSync(new URL(name, chunks), 'utf8');
		return source.includes('terminal-titlebar-main') && source.includes('terminal-footer-label');
	});
	if (!match) throw new Error('Missing compiled TerminalPanel asset for the Line replay test');
	return match;
}

test.use({ bypassCSP: true });
test.describe.configure({ mode: 'parallel' });
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					(window as unknown as { __recordLink?: string }).__recordLink = text;
				},
			},
		});
	});
});

const cases = ['stm', 'octranspo'].flatMap((provider) =>
	(['en', 'fr'] as const).flatMap((locale) =>
		[320, 1280].map((width) => ({ provider, locale, width })),
	),
);

for (const { provider, locale, width } of cases) {
	test(
		provider +
			' ' +
			locale +
			' ' +
			width +
			': a copied Line Record link preserves its scope and evidence',
		async ({ page }) => {
			await page.setViewportSize({ width, height: 1000 });
			const path = localizeHref('/lines/24', locale, provider);
			await page.goto(path + '&recordFrom=2026-11-08&recordTo=2026-11-14&direction=1');
			const section = page.locator('#punctuality');
			const cite = section.getByText(locale === 'fr' ? 'Citer' : 'Cite', { exact: true });
			const dialog = page.getByRole('dialog');
			const evidence = dialog.getByText(
				locale === 'fr'
					? /40 sur 100.*Méthode v1, nettoyage v7/u
					: /40 of 100.*Method v1, cleaning v7/u,
			);
			await cite.click();
			await expect(evidence).toBeVisible();
			await dialog.getByRole('button', { name: locale === 'fr' ? 'Fermer' : 'Close' }).click();
			const copy = section.getByRole('button', { name: transitTerms[locale].action.copyLink });
			expect((await copy.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
			await copy.focus();
			await expect(copy).toBeFocused();
			await copy.press('Enter');
			const link = () =>
				page.evaluate(() => (window as unknown as { __recordLink?: string }).__recordLink ?? '');
			await expect.poll(link).not.toBe('');
			const copied = new URL(await link());
			expect(copied.pathname).toBe(locale === 'fr' ? '/fr/lines/24' : '/lines/24');
			expect(copied.searchParams.get('provider')).toBe(provider);
			expect(copied.searchParams.get('recordFrom')).toBe('2026-11-08');
			expect(copied.searchParams.get('recordTo')).toBe('2026-11-14');
			expect(copied.searchParams.get('direction')).toBe('1');
			expect(copied.hash).toBe('#punctuality');

			if (provider === 'octranspo' && locale === 'en' && width === 320) {
				// A method/health widget must not gate hydration of a copied Line Record link.
				await page.route(`**/_app/immutable/chunks/${terminalPanelChunk()}`, (route) =>
					route.abort('failed'),
				);
			}
			await page.goto(copied.href);
			await cite.click();
			await expect(evidence).toBeVisible();
			expect(
				(await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations,
			).toEqual([]);
		},
	);
}
