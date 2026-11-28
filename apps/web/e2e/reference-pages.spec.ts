import { expect, test } from '@playwright/test';

const dates = 'frameMode=record&recordFrom=2026-11-14&recordTo=2026-11-20';

for (const [locale, prefix, provider] of [
	['en', '', 'stm'],
	['fr', '/fr', 'octranspo'],
] as const) {
	test(`Search has one field and a working example in ${locale}`, async ({ page, hasTouch }) => {
		await page.goto(`${prefix}/search?provider=${provider}`);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const main = page.getByRole('main');
		const field = main.getByRole('textbox');
		await expect(field).toBeVisible();
		await expect(page.locator('body')).toBeFocused();
		if (hasTouch) await field.tap();
		else await field.click();
		await expect(field).toBeFocused();
		await expect(page.locator('[data-slot="app-frame-chrome"] input[type="search"]')).toHaveCount(
			0,
		);
		const examples = main.getByRole('link').filter({ hasText: /^\d+$/ });
		await expect(examples.first()).toBeVisible();
		const example = (await examples.first().textContent())!.trim();
		await examples.first().press('Enter');
		await expect(field).toBeFocused();
		await expect(field).toHaveValue(example);
		await expect(
			main.getByRole('link', {
				name: new RegExp(`^${locale === 'fr' ? 'Ligne' : 'Line'} ${example}\\b`),
			}),
		).toHaveAttribute('href', new RegExp(`^${prefix}/lines/`));
		await expect(
			page.getByTestId('footer').getByRole('link', {
				name: locale === 'fr' ? 'Recherche' : 'Search',
				exact: true,
			}),
		).toHaveAttribute('href', new RegExp(`^${prefix}/search`));
	});
}

test('dark Daily report and How we measure print with readable ink and no site controls', async ({
	page,
}) => {
	await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
	await page.emulateMedia({ media: 'screen', colorScheme: 'dark' });
	for (const path of ['/receipt', '/metrics']) {
		await page.goto(`${path}?provider=stm&${dates}`);
		const main = page.getByRole('main');
		const citation = main.locator('.site-print-citation');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		if (path === '/metrics') {
			await expect(main.getByRole('heading', { level: 1, name: 'How we measure' })).toBeVisible();
			await expect(main.getByRole('button', { name: 'On-time share', exact: true })).toBeVisible();
		} else {
			await expect(main.locator('[data-slot="record-card"]').first()).toBeVisible();
		}
		await expect(citation).toBeHidden();
		await page.emulateMedia({ media: 'print' });
		if (path === '/receipt') {
			await expect(citation).toHaveCount(0);
		} else {
			await expect(citation).toBeVisible();
			await expect(citation).toContainText(new URL(page.url()).pathname);
		}
		await expect(page.locator('[data-slot="app-frame-chrome"]')).toBeHidden();
		await expect(page.getByTestId('footer')).toBeHidden();
		await expect(main.getByRole('button', { name: 'Cite', exact: true })).toBeHidden();
		await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
		const ink = await main.evaluate((node) => getComputedStyle(node).color);
		expect(ink).toBe('rgb(19, 25, 35)');
		const card = await page
			.locator('html')
			.evaluate((node) => getComputedStyle(node).getPropertyValue('--card').trim());
		expect(card).toBe('#fff');
		const contrast = await main.evaluate((scope) => {
			function luminance(color: string) {
				const channels = color
					.match(/[\d.]+/g)!
					.slice(0, 3)
					.map(Number);
				const [red, green, blue] = channels.map((channel) => {
					const value = channel / 255;
					return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
			}

			function background(element: Element) {
				for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
					const color = getComputedStyle(ancestor).backgroundColor;
					if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
				}
				return 'rgb(255, 255, 255)';
			}

			let texts = 0;
			const lowContrast: string[] = [];
			for (const element of scope.querySelectorAll('p, td, th, dt, dd, h1, h2, h3, span, a, li')) {
				if (
					![...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())
				)
					continue;
				const { width, height } = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				if (width < 2 || height < 2 || style.display === 'none' || style.visibility === 'hidden')
					continue;
				texts++;
				const ink = luminance(style.color);
				const paper = luminance(background(element));
				const ratio = (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05);
				if (ratio < 3) lowContrast.push(element.textContent!.trim() + ' ' + ratio.toFixed(1));
			}
			return { texts, lowContrast };
		});
		expect(contrast.texts).toBeGreaterThan(0);
		expect(contrast.lowContrast).toEqual([]);
		await page.emulateMedia({ media: 'screen' });
	}
});
