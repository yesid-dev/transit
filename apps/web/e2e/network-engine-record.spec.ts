import { expect, test } from '@playwright/test';
import { installHealthCapture } from './capture-fixture';

const period = 'recordFrom=2026-11-20&recordTo=2026-11-22';

for (const locale of ['en', 'fr'] as const) {
	for (const city of ['stm', 'octranspo'] as const) {
		test(`Network health Record and Live for ${city} in ${locale}`, async ({ page }) => {
			const forbidden: string[] = [];
			page.on('request', (request) => {
				if (/\/(?:data\/)?v1\//.test(request.url())) forbidden.push(request.url());
			});
			const root = locale === 'fr' ? '/fr' : '';
			await page.goto(`${root}/network?provider=${city}&frameMode=record&${period}`);
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName(
				locale === 'fr' ? 'Santé du réseau' : 'Network health',
			);
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(/80[.,]7\s*%/);
			const delay = main.locator('#delay');
			await expect(delay.locator('[data-slot="chart-frame"]')).toBeVisible();
			const tableLabel = locale === 'fr' ? 'Tableau' : 'Table';
			const chartLabel = locale === 'fr' ? 'Graphique' : 'Chart';
			for (const id of ['delay', 'trend', 'hours']) {
				const card = main.locator('#' + id);
				const footer = card.locator('footer');
				const controls = `network-${id}`;
				await expect(card.locator(`button[aria-controls="${controls}"]`)).toHaveCount(1);
				const tableToggle = footer.getByRole('button', { name: tableLabel, exact: true });
				await expect(tableToggle).toHaveAttribute('aria-controls', controls);
				await expect(footer.locator('.hand-drawn-line')).toBeVisible();
				await tableToggle.click();
				const chartToggle = footer.getByRole('button', { name: chartLabel, exact: true });
				await expect(chartToggle).toHaveAttribute('aria-expanded', 'true');
				await expect(card.getByRole('table')).toBeVisible();
				if (id === 'delay') {
					await expect(card.getByRole('cell', { name: /^14[,\s]500$/u })).toBeVisible();
				}
				await chartToggle.click();
				await expect(tableToggle).toHaveAttribute('aria-expanded', 'false');
			}
			await expect(main.locator('#delivery dl dd').first()).toHaveCSS('text-align', 'right');
			await expect(
				main
					.locator('#hours [data-slot="hour-grid"]')
					.getByRole('listitem')
					.filter({ hasText: locale === 'fr' ? /^Non mesuré$/ : /^Not measured$/ }),
			).toBeVisible();
			await expect(
				main.getByRole('heading', { name: locale === 'fr' ? 'Places à bord' : 'Crowding' }),
			).toBeVisible();
			await expect(
				main.getByRole('heading', {
					name: locale === 'fr' ? 'Par heure et jour de la semaine' : 'By hour and weekday',
				}),
			).toBeVisible();
			await expect(
				main.getByText(locale === 'fr' ? 'Vérifications réussies des flux' : 'Feed check success'),
			).toHaveCount(0);

			await page.goto(`${root}/network?provider=${city}&frameMode=live&${period}`);
			await expect(
				main.getByRole('heading', {
					name: locale === 'fr' ? 'Véhicules par état' : 'Vehicles by status',
				}),
			).toBeVisible();
			await expect(
				main.getByRole('heading', {
					name: locale === 'fr' ? 'Trajets sans signalement' : 'Silent trips',
				}),
			).toBeVisible();
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
				locale === 'fr' ? 'véhicule transmet sa position.' : 'vehicle is reporting now.',
			);
			expect(forbidden).toEqual([]);
		});
	}
}

test('Network health reads scheduled trips and individual silent trips from the live capture', async ({
	page,
}) => {
	const refresh = await installHealthCapture(page);
	await page.goto('/network?provider=stm&frameMode=live');
	await refresh();
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'364 vehicles are reporting now, for 1,306 trips scheduled at this moment.',
	);
	await expect(main.getByText('1,262', { exact: true })).toBeVisible();
	await expect(main.getByText('of 1,306', { exact: true })).toBeVisible();
	await expect(
		main.getByText('A count of vehicles at this moment, not a percentage.'),
	).toBeVisible();
	const silent = main.getByRole('table', { name: 'Scheduled trips with no vehicle reporting' });
	await expect(silent.getByRole('row')).toHaveCount(9);
	for (const name of ['Line', 'Departure', 'Toward', 'Silent for'])
		await expect(silent.getByRole('columnheader', { name })).toBeVisible();
	await expect(silent.getByRole('cell', { name: '40 min' })).toBeVisible();
	await expect(silent.getByRole('cell', { name: /Unknown/ }).first()).toBeVisible();
	await expect(silent.getByRole('link', { name: 'Sherbrooke' })).toHaveAttribute(
		'href',
		/\/lines\/24\?.*frameMode=live/u,
	);
	await expect(silent.getByRole('link', { name: /99999/u })).toHaveAttribute(
		'href',
		/\/lines\/99999\?/u,
	);
	await expect(main.getByText('Showing 8 of 12')).toBeVisible();
	await expect(main.getByText('44', { exact: true })).toBeVisible();
	await main.getByRole('button', { name: 'Show 4 more' }).click();
	await expect(silent.getByRole('row')).toHaveCount(13);
	await expect(main.getByText('Showing 12 of 12')).toBeVisible();
});

test('Network shows the unavailable state when the live capture fails after a successful reading', async ({
	page,
}) => {
	await page.clock.install();
	await page.route('**/api/live?city=stm', (route) =>
		route.fulfill({ status: 503, json: { state: 'unavailable' } }),
	);
	await page.goto('/network?provider=stm&frameMode=live');
	await expect(page.getByText('vehicle is reporting now.')).toBeVisible();
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
	await page.clock.runFor(21_000);
	await expect(page.getByText('No live data', { exact: true }).first()).toBeVisible();
	if (process.env.TRANSIT_E2E_HEALTH_SCREENSHOTS) {
		await page.screenshot({
			fullPage: true,
			path: 'test-results/health-evidence/pr20/stm-en-live-failing.png',
		});
	}
});
