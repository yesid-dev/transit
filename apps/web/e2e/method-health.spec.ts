import { expect, test } from '@playwright/test';
import { textDefects } from './layout-helpers';
import { installHealthCapture } from './capture-fixture';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	test(`How we measure disclosure defaults in ${locale}`, async ({ page }) => {
		await page.goto(fr ? '/fr/metrics' : '/metrics');
		const main = page.getByRole('main');
		const cards = main.locator('[data-record-disclosure]:not([id$="-notes"])');
		const open = main.locator('[data-record-disclosure]:not([id$="-notes"])[data-open="true"]');
		const collapse = main.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all' });
		const expand = main.getByRole('button', { name: fr ? 'Tout déplier' : 'Expand all' });
		await expect(
			main.getByText(fr ? 'méthode v3, nettoyage v12' : 'method v3, cleaning v12'),
		).toBeVisible();
		await expect(open).toHaveCount(1);
		await expect(open).toHaveAttribute('id', 'on_time');
		await expect(collapse).toBeVisible();
		await open.getByRole('button').first().press('Enter');
		await expect(expand).toBeVisible();
		const more = main.locator('[data-slot="page-section"]:has(#more-methods)');
		await expect(more).toHaveCount(1);
		await expect(more.locator('xpath=preceding-sibling::*[1]')).toHaveAttribute(
			'data-slot',
			'page-section-boundary',
		);
		await expand.click();
		await expect(open).toHaveCount(await cards.count());
		await collapse.click();
		await expect(open).toHaveCount(0);
		await expect(expand).toBeVisible();
		await expect(
			main
				.getByRole('article', {
					name: fr ? 'Ce que ce bilan n’est pas' : 'What this record is not',
				})
				.getByRole('list'),
		).toHaveCSS('list-style-position', 'inside');
	});

	test(`Download keeps the CSV column names findable in ${locale}`, async ({ page }) => {
		const path = fr ? '/fr/download' : '/download';
		await page.goto(`${path}?provider=stm`);
		const disclosure = page.locator('#measure-columns');
		const trigger = disclosure.getByRole('button', {
			name: fr ? 'Colonnes des CSV de mesures' : 'Measure CSV columns',
		});
		const content = disclosure.locator('[data-slot="collapsible-content"]');
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await expect(content).toHaveAttribute('hidden', 'until-found');
		await expect(content).toContainText(fr ? 'Mesure, Valeur' : 'Measure, Value');
		await trigger.press('Enter');
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(content).toBeVisible();
		await page.goto(
			`${path}?provider=stm&recordFrom=2026-11-16&recordTo=2026-11-22#measure-columns`,
		);
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(content).toBeVisible();
	});
}

test('Data health reads late feed details, expected cadence, sizes and the schedule', async ({
	page,
}) => {
	const refresh = await installHealthCapture(page);
	await page.goto('/status?provider=stm&frameMode=live');
	await refresh();
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'feeds are fresh. Late: Service alerts.',
	);
	await expect(main.getByRole('cell', { name: 'Late: last received 2 min ago' })).toBeVisible();
	const capture = main.getByRole('table', { name: 'Each feed, at its last capture' });
	const positions = capture.getByRole('row').filter({ hasText: 'Vehicle positions' });
	await expect(positions.getByRole('cell', { name: 'every 30 s' })).toBeVisible();
	await expect(positions.getByRole('cell', { name: '412 kB' })).toBeVisible();
	const schedule = capture.getByRole('row').filter({ hasText: 'Schedule' });
	await expect(schedule.getByRole('cell', { name: '64 MB' })).toBeVisible();
	await expect(schedule.getByRole('cell', { name: 'when the agency publishes' })).toBeVisible();
	await expect(schedule.getByRole('cell', { name: 'In use' })).toBeVisible();
	await expect(main.locator('#feed-diagnostics')).toHaveAttribute('data-open', 'false');
});

test('Data health opens feed diagnostics from a previously copied Network link', async ({
	page,
	request,
}) => {
	const period = 'provider=stm&frameMode=record&recordFrom=2026-11-11&recordTo=2026-11-14';
	await page.goto(`/network?${period}#poll_success`);
	await expect(page).toHaveURL(/\/status\?.*frameMode=live.*#poll_success$/);
	await expect(page.locator('#poll_success').getByText('20 / 25', { exact: true })).toBeVisible();
	await expect(page.locator('#poll_success')).toContainText('At least 20 samples per reading.');
	const csv = await request.get(`/network/record.csv?${period}&section=poll_success`);
	expect(csv.headers()['content-disposition']).toContain('network-poll-success.csv');
	expect(await csv.text()).toBe('Measure,Value\npoll_success,2026-11-11\n');
});

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr']) {
		const fr = locale === 'fr';
		const path = fr ? '/fr' : '';
		const provider = fr ? 'octranspo' : 'stm';
		const dates = `provider=${provider}&recordFrom=2026-11-11&recordTo=2026-11-14`;

		test(`How we measure in ${locale} at ${width}px`, async ({ page, request }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${path}/metrics?${dates}#fixture_delay`);
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toHaveText(
				fr ? 'Comment on mesure' : 'How we measure',
			);
			const heading = await main.getByRole('heading', { level: 1 }).boundingBox();
			const intro = await main.locator('[data-slot="answer-lead"] p').first().boundingBox();
			expect(intro!.x).toBeCloseTo(heading!.x);
			const measure = main.locator('#fixture_delay');
			await expect(measure).toHaveAttribute('data-open', 'true');
			await expect(measure).toContainText(fr ? 'tranches de 15 s' : '15-s steps');
			await expect(measure.getByText(/^v2, /)).toBeVisible();
			await expect(measure.locator('time')).toHaveText(
				fr ? '10 novembre 2026' : '10 November 2026',
			);
			await expect(main.locator('#ranking-range').getByRole('button').first()).toHaveAccessibleName(
				fr
					? 'L’intervalle dans un classement L’intervalle montre l’incertitude autour d’une valeur du classement.'
					: 'The range on a ranking row The range shows uncertainty around a ranked value.',
			);
			const disclosures = main.locator('[data-record-disclosure]:not([id$="-notes"])');
			for (const card of await disclosures.all()) {
				const trigger = card.getByRole('button').first();
				if (await trigger.isVisible()) {
					const initiallyOpen = (await card.getAttribute('data-open')) === 'true';
					await trigger.press('Enter');
					expect((await card.getAttribute('data-open')) === 'true').toBe(!initiallyOpen);
					await trigger.press('Space');
					expect((await card.getAttribute('data-open')) === 'true').toBe(initiallyOpen);
				}
			}
			await main.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all' }).click();
			await expect(
				main.locator('[data-record-disclosure]:not([id$="-notes"])[data-open="true"]'),
			).toHaveCount(0);
			await expect(
				main.getByRole('group', { name: fr ? 'Actions du bilan' : 'Record actions' }),
			).toHaveCount(1);

			await main.getByRole('button', { name: fr ? 'Citer' : 'Cite', exact: true }).click();
			await expect(page.getByRole('dialog').getByText(/v2.*\/metrics#fixture_delay/)).toBeVisible();
			await page.keyboard.press('Escape');
			await main
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const dialog = page.getByRole('dialog');
			await dialog
				.getByText(fr ? 'Colonnes du CSV' : 'CSV columns', { exact: false })
				.first()
				.click();
			await expect(dialog.getByText(fr ? 'Valeur' : 'Value', { exact: true })).toBeVisible();
			const csvUrl = (await dialog
				.getByRole('link', {
					name: fr ? 'Retard typique aux arrêts observés' : 'Typical delay at recorded stops',
				})
				.getAttribute('href'))!;
			await page.keyboard.press('Escape');
			expect(new URL(csvUrl, page.url()).searchParams.get('provider')).toBe(provider);
			const csv = await request.get(csvUrl);
			expect(csv.ok()).toBe(true);
			expect(await csv.text()).toMatch(fr ? /^Mesure,Valeur/ : /^Measure,Value/);
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
			if (fr && width === 1440) {
				await page.goto(`${path}/metrics?provider=${provider}#otp`);
				await expect(page).toHaveURL(/\/fr\/metrics\/archive\?provider=octranspo#otp$/);
				await expect(main.locator('#otp')).toBeAttached();
			}
		});

		test(`Data health in ${locale} at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			const response = await page.goto(`${path}/status?${dates}`);
			expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toHaveText(
				fr ? 'Santé des données' : 'Data health',
			);
			const table = main.locator('#table-health').getByRole('table');
			await expect(table.getByRole('rowheader')).toHaveCount(2);
			for (const state of fr
				? [
						'Présent',
						'Manquant (Fichier manquant)',
						'Non mesuré (Aucune capture brute)',
						'Non mesuré (Aucune édition de l’horaire)',
					]
				: [
						'Present',
						'Missing (File missing)',
						'Not measured (No raw captures)',
						'Not measured (No schedule edition)',
					]) {
				await expect(table.getByRole('cell', { name: state, exact: true }).first()).toBeAttached();
			}
			await expect(main.getByRole('link', { name: /CSV/ })).toHaveCount(0);
			await expect(
				main.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true }),
			).toHaveCount(0);
			await expect(
				main.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await main.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(
				page.getByRole('dialog').getByText(/recordFrom=2026-11-11.*#table-health/),
			).toBeVisible();
			const tableHealthDefects = (await textDefects(page)).filter(({ selector }) =>
				selector.startsWith('#table-health'),
			);
			expect(tableHealthDefects).toEqual([]);
			const versions = main.locator('[data-slot="record-card"]').filter({
				has: page.getByRole('heading', {
					name: fr ? 'Versions en vigueur' : 'Versions in force',
				}),
			});
			await expect(
				versions.getByText(fr ? 'méthode v3' : 'method v3', { exact: true }),
			).toBeVisible();
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
		});
	}
}
