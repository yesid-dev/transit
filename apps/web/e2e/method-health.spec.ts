import { csvText } from '../src/tests/csv';
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
		await expect(main).not.toContainText(fr ? 'méthode v' : 'method v');
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
		).toHaveCSS('list-style-position', 'outside');
	});

	test(`How we measure keeps the chevron beside a wrapped title in ${locale}`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
		await page.goto(fr ? '/fr/metrics' : '/metrics');
		const card = page.locator('#fixture_delay');
		const title = card.locator('.disclosure-title > span').first();
		await title.evaluate(
			(node, text) => {
				node.textContent = text;
			},
			fr ? 'Trajets effectués, annulés et manquants' : 'Trips that ran, cancelled and missing',
		);
		const chevron = card.locator('.disclosure-title svg').first();
		const titleBox = await title.boundingBox();
		const chevronBox = await chevron.boundingBox();
		expect(titleBox).not.toBeNull();
		expect(chevronBox).not.toBeNull();
		expect(titleBox!.height).toBeGreaterThan(40);
		expect(Math.abs(chevronBox!.y - titleBox!.y)).toBeLessThanOrEqual(2);
		expect(chevronBox!.x).toBeGreaterThan(titleBox!.x);
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
		'live feeds are fresh. Late: Service alerts.',
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
	// The agency's figures for the selected dates live in Record.
	await expect(main.locator('#feed-diagnostics')).toHaveCount(0);
	await expect(main).not.toContainText('Feed diagnostics');
});

test('Data health opens the agency figures from a previously copied Network link', async ({
	page,
	request,
}) => {
	const period = 'provider=stm&frameMode=record&recordFrom=2026-11-11&recordTo=2026-11-14';
	await page.goto(`/network?${period}#poll_success`);
	await expect(page).toHaveURL(/\/status\?.*frameMode=record.*#poll_success$/);
	await expect(
		page.locator('#poll_success').getByRole('row', { name: /Trip updates/ }),
	).toContainText('20 / 25 checks');
	await expect(page.locator('#poll_success')).toContainText('At least 20 samples per reading.');
	const csv = await request.get(`/network/record.csv?${period}&section=poll_success`);
	expect(csv.headers()['content-disposition']).toContain('network-poll-success.csv');
	expect(csvText(await csv.body())).toBe(
		'Measure,Value,Data source and licence\npoll_success,2026-11-11,"STM open data, computed by Transit"\n',
	);
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
			await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName(
				fr ? 'Comment on mesure' : 'How we measure',
			);
			const heading = await main.getByRole('heading', { level: 1 }).boundingBox();
			const intro = await main.locator('[data-slot="answer-lead"] p').first().boundingBox();
			expect(intro!.x).toBeCloseTo(heading!.x);
			const measure = main.locator('#fixture_delay');
			await expect(measure).toHaveAttribute('data-open', 'true');
			await expect(measure).toContainText(fr ? 'tranches de 15 s' : '15-s steps');
			await expect(measure).not.toContainText(/\bv2\b/u);
			await expect(main).not.toContainText(
				fr
					? 'Le registre des méthodes ne le précise pas.'
					: 'The method registry does not specify this.',
			);
			await expect(measure.locator('time')).toHaveText(
				fr ? '10 novembre 2026' : '10 November 2026',
			);
			const notesTrigger = measure.getByRole('button', {
				name: fr ? 'Pour les utilisateurs de données' : 'For data users',
			});
			await expect(notesTrigger).toHaveAttribute('aria-expanded', 'false');
			await notesTrigger.click();
			await expect(notesTrigger).toHaveAttribute('aria-expanded', 'true');
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
			expect(csvText(await csv.body())).toMatch(fr ? /^Mesure,Valeur/u : /^Measure,Value/u);
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
			await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName(
				fr ? 'Santé des données' : 'Data health',
			);
			const publishes = main.locator('#publishes');
			await expect(
				publishes.getByRole('heading', {
					name: fr ? 'Ce que publie OC Transpo' : 'What STM publishes',
				}),
			).toBeVisible();
			const stops = publishes.getByRole('row').filter({
				hasText: fr ? 'Accès en fauteuil roulant aux arrêts' : 'Wheelchair boarding at stops',
			});
			await expect(stops).toContainText(fr ? 'Non publié' : 'Published');
			await expect(stops.getByText(fr ? 'État' : 'State', { exact: true })).toBeHidden();
			if (fr) {
				await expect(publishes).toContainText(
					'Transit ne collecte pas encore les avis d’OC Transpo.',
				);
				await expect(
					publishes.getByRole('link', { name: 'Consulter les avis officiels' }),
				).toHaveAttribute('href', 'https://www.octranspo.com/fr/alertes/');
			}
			const predictions = main.locator('#prediction_error');
			const checks = main.locator('#poll_success');
			await expect(
				checks.getByRole('row', { name: fr ? /Mises à jour des trajets/ : /Trip updates/ }),
			).toContainText(
				fr
					? '4 sur 25 avec un flux datant de plus de 10 min'
					: '4 of 25 with a feed over 10 min old',
			);
			if (fr) await expect(checks).toContainText('12 trajets écartés');
			await expect(predictions).toContainText(
				fr
					? '90 prévisions sur 100 faites une minute à l’avance étaient justes à une minute près.'
					: '90 predictions in 100 made a minute ahead were right within a minute.',
			);
			if (width === 390) {
				const oneMinute = predictions.getByRole('row', {
					name: fr ? /1 min à l’avance/ : /1 min ahead/,
				});
				const count = oneMinute.getByRole('cell').filter({ hasText: '40' });
				await expect(
					count.getByText(fr ? 'Arrivées vérifiées' : 'Arrivals checked', { exact: true }),
				).toBeVisible();
			}

			const reports = main.locator('#vehicle_field_completeness');
			const prose = reports.getByText(
				fr
					? 'Part du temps de signalement où chaque détail était fourni.'
					: 'Share of vehicle reporting time with each detail.',
			);
			const readingFont = await prose.evaluate((element) => getComputedStyle(element).fontFamily);
			for (const state of fr ? ['Inconnu', 'Non publié'] : ['Unknown', 'Not published']) {
				const reading = reports.getByText(state, { exact: true }).first();
				await expect(reading).toBeVisible();
				await expect(reading).toHaveCSS('font-family', readingFont);
			}
			// Each coverage label keeps the row's width: its counts sit under it, not beside it.
			for (const row of await main.locator('#live_trip_coverage [data-slot="fact-row"]').all()) {
				const [label, whole] = await Promise.all([
					row.locator('dt').boundingBox(),
					row.boundingBox(),
				]);
				expect(label!.width).toBeGreaterThan(whole!.width * 0.55);
			}
			const table = main.locator('#days-in-record').getByRole('table');
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
				page.getByRole('dialog').getByText(/recordFrom=2026-11-11.*#stop-events/),
			).toBeVisible();
			const tableHealthDefects = (await textDefects(page)).filter(({ selector }) =>
				selector.startsWith('#days-in-record'),
			);
			expect(tableHealthDefects).toEqual([]);
			const healthGrid = main.locator('#days-in-record [data-slot="hour-grid"]');
			await expect(healthGrid.locator('.legend')).toHaveCount(0);
			const gridMetrics = await healthGrid.evaluate((rootEl) => {
				const scroller = rootEl.querySelector<HTMLElement>('[role="region"]')!;
				const labelId = scroller.getAttribute('aria-labelledby');
				const tds = [...rootEl.querySelectorAll('tbody td')];
				return {
					role: scroller.getAttribute('role'),
					tabindex: scroller.getAttribute('tabindex'),
					labelled: Boolean(labelId && document.getElementById(labelId)?.textContent?.trim()),
					tdsCount: tds.length,
					tdsMissingAria: tds.filter((td) => !td.getAttribute('aria-label')?.trim()).length,
					pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				};
			});
			expect(gridMetrics.role).toBe('region');
			expect(gridMetrics.tabindex).toBe('0');
			expect(gridMetrics.labelled).toBe(true);
			expect(gridMetrics.tdsCount).toBeGreaterThan(0);
			expect(gridMetrics.tdsMissingAria).toBe(0);
			expect(gridMetrics.pageOverflow).toBeLessThanOrEqual(0);
			const changes = main.locator('[data-slot="record-card"]').filter({
				has: page.getByRole('heading', {
					name: fr ? 'Mises à jour des méthodes' : 'Method changes',
				}),
			});
			// One date for every measure reads as one sentence, not a table of the same date.
			await expect(changes).toContainText(
				fr
					? 'Toutes les mesures ont changé pour la dernière fois le 22 novembre 2026.'
					: 'Every measure last changed on 22 November 2026.',
			);
			await expect(changes.getByRole('table')).toHaveCount(0);
			await expect(main).not.toContainText(fr ? 'méthode v' : 'method v');
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
		});
	}
}
