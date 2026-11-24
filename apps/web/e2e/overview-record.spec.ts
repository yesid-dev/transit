import { closeCompactFrameControls, openFrameControls } from './frame-controls';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const period = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const recordHref = '/?provider=stm&frameMode=record&' + period;

for (const width of [390, 1440]) {
	for (const [provider, city] of [
		['stm', 'Montréal'],
		['octranspo', 'Ottawa'],
	] as const) {
		for (const locale of ['en', 'fr'] as const) {
			const fr = locale === 'fr';
			test(`${provider} ${locale} at ${width}px shows Overview and its evidence`, async ({
				page,
				request,
			}) => {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(`${fr ? '/fr' : '/'}?provider=${provider}&frameMode=record&${period}`);
				await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
				const main = page.getByRole('main');
				const title = fr
					? provider === 'stm'
						? 'Réseau de Montréal'
						: 'Réseau d’Ottawa'
					: `${city} network`;
				const record = main.getByRole('article', { name: fr ? 'Relevé' : 'Record', exact: true });
				const about = main.getByRole('article', {
					name: fr ? 'À propos de ces chiffres' : 'About these figures',
				});
				await expect(main.getByRole('heading', { level: 1 })).toHaveText(title);
				await expect(
					record.getByText(provider === 'stm' ? /81[,.]2\s?%/ : /70\s?%/, { exact: true }).first(),
				).toBeVisible();
				await expect(record).toContainText(fr ? /90 sur 100/ : /90 of 100/);
				await expect(record).toContainText(fr ? 'Période précédente' : 'Previous period');
				await expect(about).toContainText(fr ? 'Faible couverture' : 'Low coverage');
				await expect(about).toContainText(
					fr
						? 'La plupart de ces heures proviennent de prévisions.'
						: 'Most times come from predictions.',
				);
				const ranking = main.getByRole('article', {
					name: fr ? 'Lignes et arrêts à examiner' : 'Lines and stops to investigate',
				});
				await expect(ranking.getByRole('listitem')).toHaveCount(6);
				await expect(ranking.getByRole('link')).toHaveCount(7);

				const firstLink = record.getByRole('link').first();
				const copy = record.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' });
				await copy.focus();
				await expect(copy).toBeFocused();
				const download = record.getByRole('button', { name: fr ? 'Télécharger' : 'Download' });
				await page.keyboard.press('Tab');
				await expect(download).toBeFocused();
				const cite = record.getByRole('button', { name: fr ? 'Citer' : 'Cite' });
				await page.keyboard.press('Tab');
				await expect(cite).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(firstLink).toBeFocused();

				await download.click();
				const exports = page.getByRole('dialog');
				await expect(exports.getByRole('link')).toHaveCount(6);
				const exportHref = await exports.getByRole('link').first().getAttribute('href');
				const csv = await request.get(exportHref!);
				expect(await csv.text()).toBe('measure,from,to\npunctuality,2026-11-08,2026-11-14\n');
				await page.keyboard.press('Escape');
				await expect(download).toBeFocused();
				await cite.click();
				await expect(
					page
						.getByRole('dialog')
						.getByText(/Method v2|Méthode v2/)
						.first(),
				).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(cite).toBeFocused();
				expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
			});
		}
	}
}

for (const colorScheme of ['light', 'dark'] as const) {
	for (const provider of ['stm', 'octranspo'] as const) {
		for (const locale of ['en', 'fr'] as const) {
			const fr = locale === 'fr';
			test(`Overview ${provider} ${locale} satisfies WCAG AA in ${colorScheme}`, async ({
				page,
			}) => {
				await page.addInitScript((theme) => localStorage.setItem('theme', theme), colorScheme);
				await page.emulateMedia({ colorScheme });
				await page.goto(`${fr ? '/fr' : '/'}?provider=${provider}&frameMode=record&${period}`);
				await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
				await expect(
					page.getByRole('heading', {
						name: fr ? 'À propos de ces chiffres' : 'About these figures',
					}),
				).toBeVisible();
				const results = await new AxeBuilder({ page })
					.include('main')
					.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
					.analyze();
				expect(results.violations).toEqual([]);
			});
		}
	}
}

test('a slow stop ranking shows patience while the other parts remain usable', async ({
	page,
	request,
}) => {
	await page.goto('/?provider=stm&frameMode=record&recordFrom=2026-11-09&recordTo=2026-11-15', {
		waitUntil: 'commit',
	});
	const main = page.getByRole('main');
	await expect(main.getByText('of observed stop events were on time.')).toBeVisible();
	await expect(main.getByText('These records take longer')).toBeVisible();
	await main.getByRole('button', { name: 'Cite' }).click();
	await expect(
		page
			.getByRole('dialog')
			.getByText(/Method v2/)
			.first(),
	).toBeVisible();
	await page.keyboard.press('Escape');
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${dataPort}/__overview/release?fixture=overview-stop-ranking`,
	);
	expect(release.status()).toBe(204);
	await expect(
		main.getByRole('article', { name: 'Lines and stops to investigate' }).getByRole('listitem'),
	).toHaveCount(6);
	await expect(main.getByText('These records take longer')).toHaveCount(0);
});

test('Live and Record show the same punctuality for the same week (OV1)', async ({ page }) => {
	await page.goto(recordHref);
	const main = page.getByRole('main');
	const reading = main
		.getByRole('article', { name: 'Record', exact: true })
		.getByText('81.2%', { exact: true })
		.first();
	await expect(reading).toBeVisible();
	const value = await reading.innerText();
	await (await openFrameControls(page)).getByRole('radio', { name: 'Live now' }).click();
	await closeCompactFrameControls(page);
	await expect(page).toHaveURL(/frameMode=live/);
	await expect(main.getByRole('region', { name: 'Record for the selected period' })).toContainText(
		value,
	);
});

test('changing the custom period reloads Record and Live now still opens the existing homepage', async ({
	page,
}) => {
	await page.goto('/?provider=stm&' + period);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const main = page.getByRole('main');
	const record = main.getByRole('article', { name: 'Record', exact: true });
	await expect(record.getByText('Record · 8 to 14 Nov 2026').first()).toBeVisible();
	await (await openFrameControls(page)).getByRole('button', { name: 'Choose other dates' }).click();
	const dialog = page.getByRole('dialog', { name: 'Period', exact: true });
	await dialog.getByLabel('From', { exact: true }).fill('2026-11-08');
	await dialog.getByLabel('To', { exact: true }).fill('2026-11-08');
	await dialog.getByRole('button', { name: 'Show these dates' }).click();
	await expect(dialog).toBeHidden();
	await closeCompactFrameControls(page);
	await expect(record.getByText('Record · 8 Nov 2026').first()).toBeVisible();
	await expect(page).toHaveURL(/recordTo=2026-11-08/);
	await expect(record.getByText(/Same weekday last week · 1 Nov 2026/)).toBeVisible();
	await (await openFrameControls(page)).getByRole('radio', { name: 'Live now' }).click();
	await closeCompactFrameControls(page);
	await expect(main.getByText(/how the Montréal · STM network actually runs/)).toBeVisible();
	await expect(main.getByRole('navigation', { name: 'Explore everything' })).toBeVisible();
	await page.goBack();
	await expect(record.getByText('Record · 8 Nov 2026').first()).toBeVisible();
});
