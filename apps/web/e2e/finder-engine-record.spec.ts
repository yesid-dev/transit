import { expect } from '@playwright/test';
import { textDefects } from './layout-helpers';
import { startStopSearchFixture, test } from './stop-search-fixture';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const query = 'provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14';

test('stops debounces engine questions and aborts superseded results', async ({
	page,
	stopSearch,
}) => {
	await page.goto(`/stops?${query}&q=Fixture`);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const results = page.locator('#stop-results');
	const input = page.getByTestId('stops-filter-input');
	await expect(results.getByRole('cell', { name: /^80\.0%/ })).toBeVisible();
	const { questions } = stopSearch;
	const before = await questions();
	await page.clock.install();
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
	await input.press('ControlOrMeta+a');
	for (const key of 'Fixtu') {
		await input.pressSequentially(key);
		await page.clock.runFor(120);
	}
	await page.clock.runFor(250);
	await expect(page).toHaveURL(/q=Fixtu$/);
	await expect(results.getByRole('link', { name: 'Fixture stop' })).toBeVisible();
	expect(await questions()).toBe(before + 1);

	await stopSearch.hold();
	try {
		await input.fill('Pagination');
		await expect(results.getByRole('row')).toHaveCount(0);
		await page.clock.runFor(250);
		await expect.poll(questions).toBe(before + 2);
		const aborted = page.waitForEvent('requestfailed', {
			predicate: (r) =>
				r.url().includes('/api/stops/slim?') &&
				new URL(r.url()).searchParams.get('q') === 'Pagination',
		});
		await input.fill('Arrêt temporaire');
		await aborted;
		await expect(results.getByRole('row')).toHaveCount(0);
		await page.clock.runFor(250);
		await expect(results.getByRole('link', { name: 'Arrêt temporaire' })).toBeVisible();
		await stopSearch.release();
		await expect(results.getByRole('link')).toHaveText(['Arrêt temporaire']);
		expect(await questions()).toBe(before + 3);
	} finally {
		await stopSearch.release();
	}
});

test('stops sends a first page for a large timetable', async ({ request }) => {
	const response = await request.get(`/stops?${query}&q=Volume`, {
		headers: { 'x-transit-fixture-scope': 'stops-volume' },
	});
	expect(response.ok()).toBe(true);
	const html = await response.text();
	expect(html).toContain('Showing 20 of 8,630');
	expect(html).toContain('volume-stop-0000');
	expect(new Set(html.match(/volume-stop-\d{4}/g)).size).toBe(20);
	await test.info().attach('uncompressed response bytes', {
		body: String(Buffer.byteLength(html)),
		contentType: 'text/plain',
	});
});

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const prefix = fr ? '/fr' : '';

	test(`${locale} lines stream their readings and retain both CSV files`, async ({
		page,
		request,
	}) => {
		const dates = fr ? query : query.replace('2026-11-08', '2026-11-09');
		const response = await page.goto(`${prefix}/lines?${dates}&period=7-days`, {
			waitUntil: 'commit',
		});
		expect(response?.headers()['cache-control']).toBe('no-store, no-transform');

		const measured = page.getByRole('table', {
			name: fr ? 'Toutes les lignes mesurées' : 'Every measured line',
		});
		const timing = measured.getByRole('row', { name: /Sherbrooke/ });
		await expect(timing).toContainText(fr ? /80,0\s%/ : '80.0%');
		await expect(timing).toContainText(fr ? 'Faible couverture' : 'Low coverage');
		const late = timing.locator('[data-column="late"]');
		await expect(late).toContainText(fr ? /15,0\s%/ : '15.0%');
		if (!fr) {
			await expect(page.locator('[data-slot="record-patience"]').getByRole('status')).toBeVisible();
			const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
			const release = await request.post(`http://127.0.0.1:${dataPort}/__overview/release`);
			expect(release.status()).toBe(204);
		}
		await expect(timing).toContainText(fr ? '90 sur 105' : '90 of 105');

		const scheduleOnly = page.getByRole('table', {
			name: fr ? 'Lignes sans données en direct' : 'Lines without live data',
		});
		const railLine = scheduleOnly.getByRole('row').filter({
			has: page.getByRole('link', { name: /Confederation/ }),
		});
		await expect(railLine).not.toContainText(fr ? 'Horaire seulement.' : 'Schedule only.');
		await expect(railLine.locator('[data-slot="route-plate"]')).toHaveAttribute(
			'data-schedule-only',
			'true',
		);
		await expect(page.locator('#lines-without-live-data [data-slot="stamp"]')).toHaveCount(0);
		await expect(
			page.getByText(
				fr
					? /40,0\s% des 500 passages prévus/
					: /40\.0% of 500 scheduled stop events have a reading/,
			),
		).toBeVisible();
		await expect(measured.getByRole('link', { name: /Confederation|99/ })).toHaveCount(0);
		await page.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true }).click();
		const sheet = page.getByRole('dialog', {
			name: fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files',
		});
		const csv = sheet.getByRole('link', {
			name: fr ? 'Performance des lignes' : 'Line performance',
		});
		expect(decodeURIComponent((await csv.getAttribute('href'))!)).toContain('0.8,0.15,90,105,100');
		await expect(
			sheet.getByRole('link', {
				name: fr ? 'Lignes sans données en direct' : 'Lines without live data',
			}),
		).toHaveAttribute('download', /^lines-without-live-data-.*\.csv$/);
		await sheet
			.locator('[data-slot="sheet-footer"]')
			.getByRole('button', { name: fr ? 'Fermer' : 'Close' })
			.click();
		await page.getByRole('radio', { name: fr ? 'Part en retard' : 'Late share' }).click();
		await expect(page).toHaveURL(/sort=late&direction=desc$/);
		await timing.getByRole('link').click();
		await expect(page).toHaveURL(/\/lines\/24\?.*period=7-days/);
		await page.goBack();
		await expect(page).toHaveURL(/\/lines\?.*sort=late&direction=desc$/);
		await expect(timing).toBeVisible();
	});

	test(`${locale} lines below the ranking floor hide both shares without suppressing low coverage`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const dates = 'provider=stm&frameMode=record&recordFrom=2026-11-07&recordTo=2026-11-12';
		await page.goto(`${prefix}/lines?${dates}&sort=onTime&direction=asc`);
		const table = page.getByRole('table', {
			name: fr ? 'Toutes les lignes mesurées' : 'Every measured line',
		});
		const thin = table.getByRole('row').filter({
			hasText: fr ? 'Il en faut 20 pour classer une ligne.' : 'A line needs 20 to be ranked.',
		});
		for (const column of ['onTime', 'late']) {
			const share = thin.locator(`[data-column="${column}"]`);
			await expect(share).toContainText(fr ? 'Trop peu pour juger' : 'Too few to judge');
			await expect(share).not.toContainText('%');
		}
		const measured = table.getByRole('row', { name: /Sherbrooke/ });
		await expect(measured).toContainText(fr ? /80,0\s%/ : '80.0%');
		await expect(measured).toContainText(fr ? 'Faible couverture' : 'Low coverage');
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/24\?/u);
	});

	test(`${locale} lines find a line by number or name and keep the sort and history`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 900 });
		await page.goto(`${prefix}/lines?${query}&sort=late&direction=desc`);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const measured = page.getByRole('table', {
			name: fr ? 'Toutes les lignes mesurées' : 'Every measured line',
		});
		const scheduleOnly = page.locator('#lines-without-live-data');
		const field = page.getByRole('searchbox', {
			name: fr ? 'Numéro ou nom de ligne' : 'Line number or name',
		});
		await expect(measured.getByRole('row', { name: /Sherbrooke/ })).toBeVisible();
		const everyLine = await measured.getByRole('link').count();
		const noMatch = fr
			? 'Aucune ligne de cette liste ne correspond à ce numéro ou à ce nom.'
			: 'No line in this list matches this number or name.';

		await field.fill('24');
		await expect(page).toHaveURL(/sort=late&direction=desc&q=24$/);
		const rows = measured.getByRole('row').filter({ has: page.getByRole('link') });
		await expect(rows.filter({ has: page.locator('a[href*="/lines/24?"]') })).toHaveCount(1);
		for (const text of await rows.allTextContents()) expect(text).toContain('24');
		await expect(scheduleOnly).toContainText(noMatch);
		await expect(page.getByRole('status').filter({ hasText: fr ? /ligne/ : /line/ })).toHaveText(
			fr ? /^\d+ lignes?$/ : /^\d+ lines?$/,
		);

		await field.focus();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.type('Confederation');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/q=Confederation$/);
		await expect(scheduleOnly.getByRole('link', { name: /Confederation/ })).toBeVisible();
		await expect(page.locator('#line-performance')).toContainText(noMatch);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390,
		);

		await page.goBack();
		await expect(page).toHaveURL(/sort=late&direction=desc&q=24$/);
		await expect(field).toHaveValue('24');
		await expect(rows.filter({ has: page.locator('a[href*="/lines/24?"]') })).toHaveCount(1);

		await page.getByRole('button', { name: fr ? 'Effacer les filtres' : 'Clear filters' }).click();
		await expect(page).toHaveURL(/sort=late&direction=desc$/);
		await expect(field).toHaveValue('');
		await expect(measured.getByRole('link')).toHaveCount(everyLine);
		await expect(scheduleOnly.getByRole('link', { name: /Confederation/ })).toBeVisible();
	});

	test(`${locale} lines page and sort from the address, with keyboard access and copy`, async ({
		page,
		context,
	}) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.setViewportSize({ width: 390, height: 900 });
		const dates = query.replace('2026-11-08', '2026-11-04').replace('2026-11-14', '2026-11-10');
		await page.goto(`${prefix}/lines?${dates}&sort=onTime&direction=desc`);
		const table = page.getByRole('table', {
			name: fr ? 'Toutes les lignes mesurées' : 'Every measured line',
		});
		await expect(table.getByRole('link')).toHaveCount(20);
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/324\?/);
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer).toContainText(
			fr
				? /Ce qui est compté\s*:\s*250\s000 passages aux arrêts sur 25 lignes, 7 jours/
				: 'Counted: 250,000 stop events on 25 lines, 7 days',
		);
		await expect(answer).not.toContainText(fr ? 'nettoyage' : 'cleaning');
		const more = page.getByRole('button', {
			name: fr ? 'Afficher 5 de plus' : 'Show 5 more',
			exact: true,
		});
		await more.focus();
		await page.keyboard.press('Enter');
		await expect(table.getByRole('link')).toHaveCount(25);
		await expect(
			table.getByRole('row').filter({ has: page.locator('a[href*="/lines/304?"]') }),
		).toBeFocused();

		await page.getByRole('radio', { name: fr ? 'Numéro de ligne' : 'Line number' }).click();
		await expect(page).toHaveURL(/sort=line&direction=asc$/);
		await expect(table.getByRole('link')).toHaveCount(20);
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/300\?/);
		await page
			.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link', exact: true })
			.click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
			'sort=line&direction=asc',
		);
		await page.goBack();
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/324\?/);
		// Phone rows carry no column headers: one button after the sort choices reverses the order.
		await page.getByRole('radio', { name: fr ? 'Part à l’heure' : 'On-time share' }).focus();
		await page.keyboard.press('Tab');
		const reverse = page.getByRole('button', {
			name: fr ? 'Inverser le tri par À l’heure' : 'Reverse sort by On time',
		});
		await expect(reverse).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/sort=onTime&direction=asc$/);
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/300\?/);
		const choices = page.getByRole('radiogroup', { name: fr ? 'Trier par' : 'Sort by' });
		await expect(
			choices.getByRole('radio', { name: fr ? 'Trajets effectués' : 'Trips that ran' }),
		).toBeVisible();
		await expect(
			choices.getByRole('radio', { name: fr ? 'Numéro de ligne' : 'Line number' }),
		).toBeVisible();
		await expect(table.getByRole('columnheader')).toHaveCount(1);

		for (const width of [1024, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.evaluate(() => document.fonts.ready);
			const wrapped = await table.locator('[data-numeric]').evaluateAll((cells) =>
				cells.flatMap((cell) => {
					const tops = new Set<number>();
					const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
					for (let node = walker.nextNode(); node; node = walker.nextNode()) {
						if (!node.textContent?.trim()) continue;
						const range = document.createRange();
						range.selectNodeContents(node);
						for (const rect of range.getClientRects()) {
							if (rect.width) tops.add(Math.round(rect.top));
						}
					}
					return tops.size > 1 ? [cell.textContent?.trim()] : [];
				}),
			);
			expect(wrapped, `${width}px numeric headings and cells`).toEqual([]);
			const overhangingNames = await table
				.locator('tbody [data-column="name"] a')
				.evaluateAll((links) =>
					links.flatMap((link) => {
						const range = document.createRange();
						range.selectNodeContents(link);
						const rightEdge = link.closest('th')!.getBoundingClientRect().right;
						return [...range.getClientRects()].some(
							(rect) => rect.width && rect.right > rightEdge + 1,
						)
							? [link.textContent?.trim()]
							: [];
					}),
				);
			expect(overhangingNames, `${width}px row names stay inside their column`).toEqual([]);
		}

		const excluded = page.getByRole('table', {
			name: fr
				? 'Lignes impossibles à évaluer pour ces dates'
				: 'Lines that cannot be judged on these dates',
		});
		for (const state of ['too_few_to_judge', 'not_measured', 'unknown']) {
			const cell = excluded.locator(`[data-record-state="${state}"]`).locator('..').first();
			await expect(cell).toBeVisible();
			await expect(cell).not.toContainText(/\b0%?\b/);
		}
		await expect(excluded).toContainText(
			fr ? 'Il en faut 500 pour afficher une part.' : 'A line needs 500 to show a share.',
		);
	});

	test(`${locale} lines distinguish a failed connection from a busy engine`, async ({ page }) => {
		await page.goto(`${prefix}/lines?${query.replace('2026-11-08', '2026-11-05')}`);
		const unavailable = fr
			? 'Le bilan est temporairement indisponible.'
			: 'The record is temporarily unavailable.';
		await expect(page.locator('[data-slot="screen-answer"]')).toContainText(unavailable);
		await expect(page.locator('#line-performance').getByText(unavailable)).toHaveCount(1);
		await expect(page.locator('#line-performance tbody tr')).toHaveCount(0);
		await page.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true }).click();
		const csv = page.getByRole('link', {
			name: fr ? 'Performance des lignes' : 'Line performance',
		});
		expect(decodeURIComponent((await csv.getAttribute('href'))!)).toContain(unavailable);

		await page.goto(`${prefix}/lines?${query.replace('2026-11-08', '2026-11-06')}`);
		await expect(page.locator('[data-slot="record-patience"]').getByRole('status')).toHaveCount(1);
		await expect(page.getByRole('main').getByText(unavailable)).toHaveCount(0);
	});

	test(`${locale} stops show period records and filter search results on phone and desktop`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 900 });
		const response = await page.goto(`${prefix}/stops?${query}&q=Fixture`);
		expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
		const main = page.getByRole('main');
		const results = main.getByRole('region', {
			name: fr ? 'Résultats de recherche d’arrêts' : 'Stop results',
			exact: true,
		});
		const row = results.getByRole('row', { name: /Fixture stop/ });
		const filter = page.getByTestId('stops-filter-input');
		const actions = main.locator('[data-slot="screen-answer"]');
		for (const width of [390, 1440]) {
			await test.step(`${width}px`, async () => {
				await page.setViewportSize({ width, height: 900 });
				await expect(row).toContainText(fr ? /80,0\s%/ : '80.0%');
				await expect(row).toContainText('100');
				await expect(row).not.toContainText(
					fr ? 'des 250 passages prévus observés' : 'of 250 scheduled stops observed',
				);
				await expect(row.getByRole('link')).toHaveAttribute(
					'href',
					/\/stop\/S1.*recordFrom=2026-11-08.*recordTo=2026-11-14/,
				);
				await actions.getByRole('button', { name: fr ? 'Citer' : 'Cite', exact: true }).click();
				const citation = page.getByRole('dialog', {
					name: fr ? 'Citer ce bilan' : 'Cite this record',
				});
				await expect(
					citation.getByText(fr ? /Méthode v1, nettoyage v8\./ : /Method v1, cleaning v8\./),
				).toBeVisible();
				await expect(citation.locator('[data-slot="cite-text"]')).toContainText(
					/q=Fixture.*#stop-results/,
				);
				await citation
					.locator('[data-slot="sheet-footer"]')
					.getByRole('button', { name: fr ? 'Fermer' : 'Close' })
					.click();
				await actions.getByRole('button', { name: fr ? 'Télécharger' : 'Download' }).click();
				const downloads = page.getByRole('dialog', {
					name: fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files',
				});
				const csv = await downloads
					.getByRole('link', { name: fr ? 'Résultats de recherche d’arrêts' : 'Stop results' })
					.getAttribute('href');
				expect(decodeURIComponent(csv!)).toContain('"Fixture stop",0.8,100,80');
				await downloads
					.locator('[data-slot="sheet-footer"]')
					.getByRole('button', { name: fr ? 'Fermer' : 'Close' })
					.click();
				await expect(
					main.getByRole('link', { name: fr ? 'Près d’une adresse' : 'Near an address' }),
				).toHaveAttribute('href', /\/map\?[^#]*\blookup=address(?:&|$)/u);
				if (width === 390) {
					await filter.click();
					await expect(filter).toBeFocused();
					await filter.press('End');
					await filter.pressSequentially(' s');
					await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'Fixture s');
					await expect(filter).toBeFocused();
					await page.keyboard.type('top');
					await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'Fixture stop');
					await expect(row).toBeVisible();
				}
				await filter.fill('No such stop');
				await expect(row).toHaveCount(0);
				expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
				if (width === 390) await filter.fill('Fixture');
			});
		}
	});

	test(`${locale} stops offers one retry when the reading ends busy`, async ({
		page,
		request,
		stopSearch,
	}) => {
		const { questions } = stopSearch;
		await page.goto(`${prefix}/stops?${query.replace('2026-11-08', '2026-11-06')}&q=Fixture`);
		const results = page.locator('#stop-results');
		await expect(
			results.getByText(
				fr ? 'Le bilan est temporairement indisponible.' : 'The record is temporarily unavailable.',
				{ exact: true },
			),
		).toHaveCount(1);
		await expect(
			results.getByText(fr ? 'Calcul en cours…' : 'Calculating…', { exact: true }),
		).toHaveCount(0);
		const retry = results.getByRole('button', { name: fr ? 'Réessayer' : 'Try again' });
		await expect(retry).toHaveCount(1);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const before = await questions();
		// The slow Stop identity specs also ask a stop_id question on this fixture server.
		const identity = await startStopSearchFixture(request);
		try {
			await request.get(`${prefix}/stop/57135?${query}`, { headers: identity.headers });
			expect(await identity.questions()).toBe(1);
		} finally {
			await identity.dispose();
		}
		await retry.click();
		await expect.poll(questions).toBe(before + 1);
	});

	test(`${locale} stops page the timetable and link an archived code`, async ({ page }) => {
		await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'stops' });
		await page.setViewportSize({ width: 390, height: 900 });
		const period = 'provider=stm&frameMode=record&recordFrom=2026-11-04&recordTo=2026-11-10';
		await page.goto(`${prefix}/stops?${period}&q=Beaubien`);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const table = page.locator('#stop-results table');
		await expect(table.locator('tbody tr')).toHaveCount(20);
		const more = page.getByRole('button', {
			name: fr ? 'Afficher 5 de plus' : 'Show 5 more',
			exact: true,
		});
		await more.focus();
		await page.keyboard.press('Enter');
		await expect(table.locator('tbody tr')).toHaveCount(25);
		await expect(table.locator('tbody tr').nth(20).getByRole('link')).toBeFocused();
		await page.getByTestId('stops-filter-input').fill('57430');
		await expect(page).toHaveURL(/q=57430/);
		await expect(
			page.getByRole('link', { name: fr ? 'Ouvrir son bilan' : 'Open its record' }),
		).toHaveAttribute('href', /\/stop\/57430\?/);
		await expect(table).toHaveCount(0);
		await page.getByRole('link', { name: fr ? 'Ouvrir son bilan' : 'Open its record' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(
			fr ? 'Arrêt 57430' : 'Stop 57430',
		);

		const missing = await page.goto(`${prefix}/stop/57135?${period}`);
		expect(missing?.status()).toBe(404);
		await expect(
			page.getByRole('heading', {
				level: 1,
				name: fr ? 'Cet arrêt est introuvable' : 'This stop could not be found',
			}),
		).toBeVisible();
		await expect(page.getByTestId('construction-scene')).toHaveCount(0);
		await expect(
			page.getByRole('link', { name: fr ? 'Trouver un arrêt' : 'Find a stop' }),
		).toBeVisible();
	});

	test(`${locale} Stops phone rows lay out alike and keep plates inline after the name`, async ({
		page,
	}) => {
		for (const width of [320, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${prefix}/stops?${query}`);
			const rows = page.locator('#stop-results tbody tr');
			await expect(rows).toHaveCount(20);
			// Names of one length lay out the same way: the same row height.
			const heights = [];
			for (let sample = 1; sample <= 9; sample++) {
				const row = rows.filter({
					has: page.getByRole('link', { name: `Pagination sample ${sample}`, exact: true }),
				});
				const box = await row.boundingBox();
				heights.push(Math.round(box!.height));
			}
			expect(new Set(heights).size, `${width}px row heights ${heights}`).toBe(1);
			// A hanging indent: every name starts right of its code box, never under it.
			const under = await rows.evaluateAll((items) =>
				items.flatMap((item) => {
					const code = item.querySelector('.phone-code');
					const name = item.querySelector('a');
					if (!code || !name) return [];
					return name.getBoundingClientRect().left < code.getBoundingClientRect().right
						? [name.textContent?.trim()]
						: [];
				}),
			);
			expect(under, `${width}px names under their code box`).toEqual([]);
			// Plates flow after the name like words: a plate starts a new line only when it would
			// not have fit after the name or the plate before it.
			const row = rows.filter({
				has: page.getByRole('link', { name: 'B9 Atwater', exact: true }),
			});
			const plates = row.locator('[data-slot="route-plate"]');
			await expect(plates).toHaveText(['24', '51', '99']);
			const early = await row.evaluate((element) => {
				const column = element.querySelector('.phone-text')!.getBoundingClientRect();
				const boxes = [
					element.querySelector('a')!.getBoundingClientRect(),
					...[...element.querySelectorAll('[data-slot="route-plate"]')].map((plate) =>
						plate.getBoundingClientRect(),
					),
				];
				return boxes
					.slice(1)
					.filter((plate, index) => {
						const before = boxes[index];
						const wrapped = plate.top >= before.bottom - 2;
						return wrapped && before.right + 4 + plate.width <= column.right - 1;
					})
					.map((plate) => Math.round(plate.left));
			});
			expect(early, `${width}px plates that wrapped though they fit`).toEqual([]);
		}
	});

	test(`${locale} Stops keeps the stop-event sample beside one state on phones`, async ({
		page,
	}) => {
		await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'stops' });
		for (const width of [320, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(
				`${prefix}/stops?provider=octranspo&recordFrom=2026-11-04&recordTo=2026-11-10&q=8th`,
			);
			const row = page.getByRole('row').filter({ hasText: '8th Line / Byron' });
			await expect(row.getByRole('link', { name: '8th Line / Byron' })).toBeVisible();
			// The phone row puts the line plates on the name's line and the sample in its sentence.
			await expect(row.locator('[data-slot="route-plate"]')).toHaveText(['51', '51A', '105']);
			await expect(row.locator('[data-record-state]')).toHaveCount(1);
			await expect(row.locator('[data-record-state]')).toHaveAttribute(
				'data-record-state',
				'too_few_to_judge',
			);
			await expect(row).toContainText(
				fr ? '29 passages aux arrêts (minimum de 500)' : '29 stop events (minimum 500)',
			);
		}
	});

	test(`${locale} Stop explains each uncovered reading once`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 900 });
		await page.goto(`${prefix}/stop/S1?provider=stm&recordFrom=2026-11-10&recordTo=2026-11-10`);
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer).toContainText(
			fr
				? /24 des 100 passages prévus ont été observés ici à ces dates\. Il faut observer au moins 40,0\s% des passages prévus\./
				: '24 of 100 scheduled stop events were observed here on these dates. At least 40.0% of scheduled stop events must be observed.',
		);
		const waiting = page.locator('#waiting');
		const gap = fr
			? 'Trop peu d’intervalles prévus ont été observés'
			: 'Too few scheduled intervals were observed';
		await expect(waiting.getByText(gap, { exact: false })).toHaveCount(1);
		await expect(waiting.getByText(gap, { exact: false })).toContainText(
			fr ? '3 sur 20' : '3 of 20',
		);
	});

	test(`${locale} stops accepts a search without JavaScript`, async ({ browser, baseURL }) => {
		const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
		try {
			const page = await context.newPage();
			await page.goto(`${prefix}/stops?${query}`);
			await page.getByTestId('stops-filter-input').fill('Fixture');
			await page.getByRole('button', { name: fr ? 'Rechercher' : 'Search', exact: true }).click();
			await expect(page).toHaveURL(/q=Fixture/);
			await expect(
				page.locator('#stop-results').getByRole('link', { name: 'Fixture stop' }),
			).toBeVisible();
			await page.getByRole('link', { name: fr ? 'Effacer les filtres' : 'Clear filters' }).click();
			await expect(page.getByTestId('stops-filter-input')).toHaveValue('');
		} finally {
			await context.close();
		}
	});

	test(`${locale} stops filters by line in the controls rail and sheet`, async ({ page }) => {
		const label = fr ? 'Ligne' : 'Line';
		for (const width of [1440, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${prefix}/stops?${query}`);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			if (width === 390) {
				await page
					.getByRole('button', { name: fr ? /^Options Bilan/ : /^Controls Record/ })
					.click();
			}
			await page.getByRole('button', { name: label, exact: true }).click();
			await page.getByRole('combobox', { name: label, exact: true }).fill('24');
			await page.getByRole('option', { name: /^24\b/ }).first().click();
			await expect(page).toHaveURL(/route=24/);
			await expect(page.locator('#stop-results a[href*="/stop/T6-HUB?"]')).toBeVisible();
			await expect(page.locator('#stop-results a[href*="/stop/pagination-stop-"]')).toHaveCount(0);
			await page
				.getByRole('button', { name: fr ? 'Effacer les filtres' : 'Clear filters' })
				.click();
			await expect(page).not.toHaveURL(/(?:\?|&)route=/);
		}
	});

	test(`${locale} stops marks an unpublished public code`, async ({ page }) => {
		await page.goto(`${prefix}/stops?${query}&q=T6-NONE`);
		const row = page.locator('#stop-results tbody tr').filter({ hasText: 'Arrêt temporaire' });
		await expect(row.locator('[data-column="code"]')).toContainText(
			fr ? 'Non publié' : 'Not published',
		);
		await expect(row.locator('[data-column="code"]')).not.toContainText('T6-NONE');
	});

	test(`${locale} narrow lines and stops tables keep usable name tracks, plates and 44px links`, async ({
		page,
	}) => {
		const richDates = 'provider=stm&frameMode=record&recordFrom=2026-11-04&recordTo=2026-11-10';
		const cases = [
			{
				label: 'lines',
				scope: 'lines-named',
				url: `${prefix}/lines?${richDates}&sort=line&direction=asc`,
				table: '#line-performance table',
				expectedText: 'Édouard-Montpetit',
			},
			{
				label: 'stops',
				scope: 'stops',
				url: `${prefix}/stops?${query}&route=24`,
				table: '#stop-results table',
				expectedText: 'Côte-des-Neiges',
			},
		] as const;

		for (const item of cases) {
			await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': item.scope });
			for (const width of [320, 390, ...(item.label === 'lines' ? [1024] : [])]) {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(item.url);
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				const table = page.locator(item.table);
				await expect(table).toContainText(item.expectedText);
				await page.evaluate(() => document.fonts.ready);

				const check = await table.evaluate((tableEl) => {
					const rows = [...tableEl.querySelectorAll('tbody tr')].slice(0, 8);
					let minPrimaryWidth = Infinity;
					let minLinkHeight = Infinity;
					let labelOverlapsValue = false;
					let plateOverlapsLabel = false;
					for (const row of rows) {
						const primary = row.querySelector<HTMLElement>(
							'.phone-text, [data-row-position="primary"]',
						);
						const value = row.querySelector<HTMLElement>('[data-row-position="value"]');
						const link = row.querySelector<HTMLElement>('a.name-cell');
						const name = row.querySelector<HTMLElement>('.name-label');
						const plate = row.querySelector<HTMLElement>('.plate');
						if (primary)
							minPrimaryWidth = Math.min(minPrimaryWidth, primary.getBoundingClientRect().width);
						if (link) minLinkHeight = Math.min(minLinkHeight, link.getBoundingClientRect().height);
						if (name && value) {
							const nr = name.getBoundingClientRect();
							const vr = value.getBoundingClientRect();
							if (nr.right > vr.left + 1 && nr.top < vr.bottom - 1 && nr.bottom > vr.top + 1) {
								labelOverlapsValue = true;
							}
						}
						if (plate && name) {
							const pr = plate.getBoundingClientRect();
							const nr = name.getBoundingClientRect();
							if (pr.right > nr.left + 1 && pr.top < nr.bottom - 1 && pr.bottom > nr.top + 1) {
								plateOverlapsLabel = true;
							}
						}
					}
					return {
						rowCount: rows.length,
						pageOverflow:
							document.documentElement.scrollWidth - document.documentElement.clientWidth,
						minPrimaryWidth: Math.round(minPrimaryWidth),
						minLinkHeight: Math.round(minLinkHeight),
						labelOverlapsValue,
						plateOverlapsLabel,
					};
				});
				expect(check.rowCount, `${locale} ${item.label} ${width}px rows`).toBeGreaterThan(0);
				expect(
					check.pageOverflow,
					`${locale} ${item.label} ${width}px overflow`,
				).toBeLessThanOrEqual(0);
				expect(
					check.minPrimaryWidth,
					`${locale} ${item.label} ${width}px name track`,
				).toBeGreaterThanOrEqual(100);
				expect(
					check.minLinkHeight,
					`${locale} ${item.label} ${width}px link height`,
				).toBeGreaterThanOrEqual(44);
				expect(
					check.labelOverlapsValue,
					`${locale} ${item.label} ${width}px label/value overlap`,
				).toBe(false);
				expect(
					check.plateOverlapsLabel,
					`${locale} ${item.label} ${width}px plate/label overlap`,
				).toBe(false);
				const tablePrefix = item.table.split(' ')[0];
				const defects = (await textDefects(page)).filter(
					({ kind, selector }) => kind === 'broken-word' && selector.startsWith(tablePrefix),
				);
				expect(defects, `${locale} ${item.label} ${width}px broken words`).toEqual([]);
			}
		}
	});
}
