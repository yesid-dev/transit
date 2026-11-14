import { expect } from '@playwright/test';
import { test } from './layout-test';
import { forwardRoute } from './layout-helpers';
import { copy as healthCopy } from '../src/lib/features/health/health.copy';
import { copy as receiptCopy } from '../src/lib/features/receipt/receipt.copy';
import { navPillCopy } from '../src/lib/i18n/messages';

for (const locale of ['en', 'fr'] as const)
	test(`${locale} status summary keeps its place while the page hydrates and refreshes`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		let release = (): void => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/_app/immutable/**/*.js', (route) => held.then(() => route.fallback()));
		let releaseStyles = (): void => {};
		const stylesHeld = new Promise<void>((resolve) => (releaseStyles = resolve));
		// Force the component CSS to arrive before the global typography and layout CSS.
		await page.route('**/_app/immutable/**/*.css', async (route) => {
			const response = await route.fetch();
			const body = await response.text();
			if (!body.includes('.health-summary')) await stylesHeld;
			await route.fulfill({ response, body });
		});
		await page.goto(`${locale === 'fr' ? '/fr' : ''}/status`, { waitUntil: 'commit' });
		const summary = page.locator('[data-slot="health-summary"]');
		await expect(summary).toHaveAttribute('aria-busy', 'true');
		await page.addStyleTag({ content: 'html { font-size: 200%; }' });
		await expect(summary).toHaveCSS('display', 'flex');
		releaseStyles();
		// The component can be styled before global typography and frame widths arrive.
		// WebKit's load also waits for the held scripts; wait only for parsed, applied CSS.
		await page.waitForLoadState('domcontentloaded');
		await page.waitForFunction(() =>
			[...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every(
				(link) => link.disabled || link.sheet != null,
			),
		);
		// WebKit settles fonts only after the held scripts load: wait for them, at most 2 s.
		await page.evaluate(() =>
			Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2e3))]),
		);
		// The block after the summary starts at its bottom: hold the summary's own height. Shifts
		// above it (the header settling) or below it (resource regions reloading) are not its own.
		const nextTop = async () => (await summary.boundingBox())!.height;
		const before = await nextTop();
		release();
		await expect(summary).toHaveAttribute('aria-busy', 'false');
		expect(Math.abs((await nextTop()) - before)).toBeLessThanOrEqual(1);
		const failing = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/historic/history/index.json', (route) =>
			failing.then(() => route.abort()),
		);
		const pending = page.waitForRequest('**/historic/history/index.json');
		await page.getByRole('button', { name: navPillCopy[locale].refresh }).click();
		await pending;
		expect(Math.abs((await nextTop()) - before)).toBeLessThanOrEqual(1);
		release(); // the history request fails
		await expect(page.locator('[data-slot="refresh-result"]')).not.toBeEmpty();
		expect(Math.abs((await nextTop()) - before)).toBeLessThanOrEqual(1);
	});

// Replay the same missing observations for each provider so both layouts exercise
// absence rather than relying on the state of an agency's live feed.
for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		for (const surface of ['receipt', 'status'])
			test(`${provider} ${locale} ${surface} rider layout`, async ({ page }) => {
				await page.clock.setFixedTime(Date.parse('2026-08-29T12:00:30Z'));
				await page.route('**/v1/**', (route) =>
					forwardRoute(page, async () => {
						const url = new URL(route.request().url());
						if (!/^\/(?:data\/)?v1\//.test(url.pathname)) {
							await route.fallback();
							return;
						}
						url.port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
						url.pathname = `/__layout/missing${url.pathname.replace(/^\/data\//, '/').replace('/octranspo/', '/stm/')}`;
						const response = await route.fetch({ url: url.href });
						if (url.pathname.endsWith('/manifest.json')) {
							const manifest = await response.json();
							await route.fulfill({ response, json: { ...manifest, provider } });
						} else await route.fulfill({ response });
					}),
				);
				await page.goto(`${locale === 'fr' ? '/fr' : ''}/${surface}?provider=${provider}`);
				if (surface === 'status') {
					await expect(page.getByRole('heading', { level: 1 })).toHaveText(
						healthCopy[locale].heading,
					);
					const summary = page.locator('[data-slot="health-summary"]');
					await expect(summary).toHaveAttribute('aria-busy', 'false');
					for (const line of await summary.locator('p').all()) {
						const fits = await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
						expect(fits, await line.textContent()).toBe(true);
					}
					for (const title of await page.locator('.health-detail .section-title:visible').all()) {
						const fits = await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
						expect(fits, await title.textContent()).toBe(true);
					}
				} else {
					const missing = page.locator('[data-slot="receipt-affected"] [data-slot="absent-value"]');
					await expect(missing.first()).toBeVisible();
					for (const absence of await missing.all()) {
						await expect(absence).toHaveAttribute('data-density', 'compact');
						await expect(absence).not.toContainText('·');
					}
					const open = page.getByRole('button', { name: receiptCopy[locale].rail.open });
					if (await open.isVisible()) await open.click();
					const date = page.locator('input[type="date"]:visible');
					await expect(date).toHaveValue('2026-08-29');
					expect(new URL(page.url()).searchParams.has('date')).toBe(false);
					await expect(page.locator('[data-slot="receipt-incomplete-day"]')).toHaveCount(0);
					const fits = await date.evaluate((input) => {
						const label = input.closest('label')!;
						const caption = label.querySelector('span')!;
						return (
							input.getBoundingClientRect().top >= caption.getBoundingClientRect().bottom &&
							input.clientWidth >= 150
						);
					});
					expect(fits, 'full date gets its own row and space for the year').toBe(true);
				}
			});
