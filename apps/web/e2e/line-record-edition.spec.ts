import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { transitTerms } from '../src/lib/i18n/transitTerms.copy';
import { reliabilityCopy } from '../src/lib/features/lines/reliability/reliability.copy';

test.use({ bypassCSP: true });
test.describe.configure({ mode: 'parallel' });
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
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

const MATRIX = ['stm', 'octranspo'].flatMap((provider) =>
	(['en', 'fr'] as const).flatMap((locale) =>
		[320, 1280].map((width) => ({ provider, locale, width })),
	),
);
const REPRESENTATIVE = [
	{ provider: 'stm', locale: 'en' as const, width: 390 },
	{ provider: 'octranspo', locale: 'fr' as const, width: 768 },
];

const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
const dataOrigin = `http://127.0.0.1:${dataPort}`;

function publicationDate(published: string, locale: 'en' | 'fr'): string {
	return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(published));
}

function lineUrl(locale: 'en' | 'fr', provider: string, id: string, query: string): string {
	const url = new URL(localizeHref(`/lines/${id}`, locale, provider), 'https://transit.local');
	for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
	return url.pathname + url.search;
}

async function settle(page: Page, url: string, width: number) {
	await page.setViewportSize({ width, height: 1000 });
	await page.goto(url, { waitUntil: 'load' });
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await expect(page.locator('[data-slot="record-figure"]')).toBeVisible();
}

async function copiedLink(page: Page, locale: 'en' | 'fr') {
	const button = page.getByRole('button', { name: transitTerms[locale].action.copyLink });
	await button.focus();
	await expect(button).toBeFocused();
	await button.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(() => (window as unknown as { __recordLink?: string }).__recordLink ?? ''),
		)
		.not.toBe('');
	return page.evaluate(() => (window as unknown as { __recordLink?: string }).__recordLink!);
}

for (const { provider, locale, width } of [...MATRIX, ...REPRESENTATIVE]) {
	test(`${provider} ${locale} ${width}: a copied Record link carries its edition and opens truthfully`, async ({
		page,
		request,
	}) => {
		const source = await (
			await request.get(`${dataOrigin}/v1/${provider}/historic/route_reliability/9002.json`)
		).json();
		const publication = {
			generation: source.publish_generation_id as string,
			published: source.generated_utc as string,
			method: source.methodology_version as string,
		};
		expect(publication.generation).toMatch(/@2026-08-30T06:00:00Z$/u);

		await settle(page, lineUrl(locale, provider, '9002', ''), width);
		const copy = page.getByRole('button', { name: transitTerms[locale].action.copyLink });
		const buttonBox = await copy.boundingBox();
		expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

		const href = await copiedLink(page, locale);
		const copied = new URL(href);
		expect(copied.pathname).toBe(locale === 'fr' ? '/fr/lines/9002' : '/lines/9002');
		expect(copied.searchParams.get('provider')).toBe(provider);
		expect(copied.searchParams.get('generation')).toBe(publication.generation);
		expect(copied.searchParams.get('published')).toBe(publication.published);
		expect(copied.searchParams.get('method')).toBe(publication.method);
		expect(await page.locator('[data-slot="record-edition"]').count()).toBe(0);

		// The same link, opened again, is not reported as corrected or different.
		await settle(page, copied.pathname + copied.search, width);
		expect(await page.locator('[data-slot="record-edition"]').count()).toBe(0);

		// A known older generation with a valid older stamp is the one corrected case.
		const correctedUrl = lineUrl(
			locale,
			provider,
			'9002',
			`generation=old@2026-08-23T06:00:00Z&published=2026-08-23T06:00:00Z&method=${publication.method}`,
		);
		await settle(page, correctedUrl, width);
		const corrected = page.locator('[data-slot="record-edition"]');
		await expect(corrected).toHaveText(
			reliabilityCopy[locale].record.edition.corrected(
				publicationDate(publication.published, locale),
			),
		);
		await expect(corrected).toHaveAttribute('role', 'status');
		const noticeBox = await corrected.boundingBox();
		expect(noticeBox?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((noticeBox?.x ?? 0) + (noticeBox?.width ?? width + 1)).toBeLessThanOrEqual(width + 1);
		expect(
			await corrected.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
		).toBe(true);

		// Same provider, a different generation and no chronology proof: neutral, never corrected.
		const differentUrl = lineUrl(
			locale,
			provider,
			'9002',
			`generation=other@2026-08-30T06:00:00Z&method=${publication.method}&focus=keep`,
		);
		await settle(page, differentUrl, width);
		await expect(page.locator('[data-slot="record-edition"]')).toHaveText(
			reliabilityCopy[locale].record.edition.different,
		);
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-slot="record-edition"]')).toBeVisible();

		if (provider === 'stm') {
			const legacy = await (
				await request.get(`${dataOrigin}/v1/stm/historic/route_reliability/9001.json`)
			).json();
			expect(legacy.publish_generation_id).toBeUndefined();
			await settle(
				page,
				lineUrl(
					locale,
					provider,
					'9001',
					`generation=${publication.generation}&published=${publication.published}&method=${publication.method}`,
				),
				width,
			);
			await expect(page.locator('[data-slot="record-edition"]')).toHaveText(
				reliabilityCopy[locale].record.edition.unverifiable,
			);
		}

		if (width === 390 || width === 768) {
			expect(
				(await new AxeBuilder({ page }).include('[data-slot="reliability-clusters"]').analyze())
					.violations,
			).toEqual([]);
		}
	});
}
