import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { methodCopy } from '../src/lib/features/record/methodCatalog.copy.ts';
import { csvText } from '../src/tests/csv';
import { doubleText, textDefects } from './layout-helpers';
import { installHealthCapture } from './capture-fixture';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	test(`How we measure disclosure defaults in ${locale}`, async ({ page }) => {
		await page.addInitScript(() => localStorage.removeItem('sections-choice'));
		await page.goto(fr ? '/fr/metrics' : '/metrics');
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		// The cards are drawn on the server; their saved open state applies on hydration.
		await expect(page.locator('html[data-hydrated]')).toBeAttached();
		const main = page.getByRole('main');
		const cards = main.locator('[data-method-bulk]');
		const open = main.locator('[data-method-bulk][data-state="open"]');
		const collapse = main.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all' });
		const expand = main.getByRole('button', { name: fr ? 'Tout déplier' : 'Expand all' });
		await expect(main).not.toContainText(fr ? 'méthode v' : 'method v');
		await expect(open).toHaveCount(1);
		await expect(open).toHaveAttribute('id', 'on_time');
		await expect(
			main
				.locator('.method-heading-row')
				.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all' }),
		).toBeVisible();
		await expect(main.locator('#fixture_delay [data-slot="section-summary"]')).toHaveCount(0);
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
		const title = card.locator('.method-disclosure-trigger > span').first();
		await title.evaluate(
			(node, text) => {
				node.textContent = text;
			},
			fr
				? 'Trajets effectués, annulés et manquants à chaque arrêt prévu'
				: 'Trips that ran, were cancelled or went missing at each scheduled stop',
		);
		const chevron = card.locator('.method-disclosure-trigger svg').first();
		const titleBox = await title.boundingBox();
		const chevronBox = await chevron.boundingBox();
		expect(titleBox).not.toBeNull();
		expect(chevronBox).not.toBeNull();
		expect(titleBox!.height).toBeGreaterThan(40);
		expect(chevronBox!.y).toBeGreaterThanOrEqual(titleBox!.y - 2);
		expect(chevronBox!.y).toBeLessThan(titleBox!.y + titleBox!.height);
		expect(chevronBox!.x).toBeGreaterThan(titleBox!.x);
	});

	test(`How we measure contents and print remain usable in ${locale}`, async ({ page }) => {
		const states = methodCopy[locale].statesTitle;
		const contents = fr ? 'Sur cette page' : 'On this page';
		const path = fr ? '/fr/metrics' : '/metrics';
		const main = page.getByRole('main');
		const desktopToc = main.locator('[data-slot="detail-shell-left"]');
		const phoneToc = page.getByTestId('toc-pill');
		for (const width of [390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${path}?provider=stm&frameMode=record`);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			await expect(main.locator('#on_time')).toBeVisible();
			const headings = (await main.locator('.method-content h2').allTextContents()).map((text) =>
				text.trim(),
			);
			if (width === 390) {
				await expect(desktopToc).toBeHidden();
				const trigger = phoneToc.getByRole('button', { name: contents });
				await trigger.press('Enter');
				const sheet = phoneToc.getByRole('navigation');
				await expect(sheet).toBeVisible();
				const entries = sheet.getByRole('button');
				await expect(entries).toHaveText(headings);
				await expect(entries.first()).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(entries.nth(1)).toBeFocused();
				await sheet.getByRole('button', { name: states, exact: true }).focus();
				await page.keyboard.press('Enter');
				await expect(sheet).toBeHidden();
				await expect(trigger).toBeFocused();
			} else {
				await expect(phoneToc).toBeHidden();
				await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
				const title = await main.getByRole('heading', { level: 1 }).boundingBox();
				const rail = await desktopToc.locator('.method-contents-title').boundingBox();
				expect(rail!.y).toBeCloseTo(title!.y, 0);
				await expect(
					desktopToc.getByRole('link', { name: /jusqu’en novembre 2026|until November 2026/u }),
				).toBeVisible();
				const contentsNav = desktopToc.getByRole('navigation', { name: contents });
				const entries = contentsNav.getByRole('link');
				await expect(entries).toHaveText(headings);
				await entries.first().focus();
				await page.keyboard.press('Tab');
				await expect(entries.nth(1)).toBeFocused();
				const entry = contentsNav.getByRole('link', { name: states, exact: true });
				await entry.focus();
				await page.keyboard.press('Enter');
				await expect(entry).toHaveAttribute('aria-current', 'location');
			}
			await expect(main.locator('#reading-states')).toBeInViewport();
			await doubleText(page);
			expect(await textDefects(page, '.method-content'), `200% text at ${width}px`).toEqual([]);
		}
		for (const width of [1280, 1920]) {
			await page.setViewportSize({ width, height: 900 });
			expect(await textDefects(page, '.method-content'), `200% text at ${width}px`).toEqual([]);
		}
		await page.goto(`${path}?provider=stm&frameMode=record`);
		await expect(
			main.getByRole('button', { name: fr ? 'Imprimer' : 'Print', exact: true }),
		).toBeVisible();
		await main.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all' }).click();
		await page.emulateMedia({ media: 'print' });
		await expect(desktopToc.getByRole('navigation')).toBeHidden();
		await expect(main.locator('#on_time [data-slot="collapsible-content"]').first()).toBeVisible();
		await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
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

test('Data health reads late feed details, expected cadence and the schedule', async ({ page }) => {
	const refresh = await installHealthCapture(page);
	await page.goto('/status?provider=stm&frameMode=live');
	await refresh();
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'live feeds are fresh. Late: Service alerts.',
	);
	await expect(main.getByRole('cell', { name: 'Late: last received 2 min ago' })).toBeVisible();
	const capture = main.getByRole('table', { name: 'Each feed, at its last capture' });
	await expect(capture.getByRole('columnheader')).toHaveText([
		'Feed',
		'Last capture',
		'Expected',
		'State',
	]);
	const positions = capture.getByRole('row').filter({ hasText: 'Vehicle positions' });
	await expect(positions.getByRole('cell', { name: 'every 30 s' })).toBeVisible();
	const schedule = capture.getByRole('row').filter({ hasText: 'Schedule' });
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

for (const width of [390, 1024, 1440]) {
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
			const intro = await main
				.locator('[data-slot="article-header"] .header__subtitle')
				.boundingBox();
			expect(intro!.x).toBeCloseTo(heading!.x);
			const boundary = await main.locator('[data-slot="article-header-boundary"]').boundingBox();
			const column = await main.locator('.method-content').boundingBox();
			expect(boundary!.x).toBeCloseTo(column!.x, 0);
			expect(boundary!.width).toBeCloseTo(column!.width, 0);
			const statesGroup = main.locator('[data-slot="page-section"]:has(> #reading-states)');
			await expect(statesGroup.locator('xpath=preceding-sibling::*[1]')).toHaveAttribute(
				'data-slot',
				'page-section-boundary',
			);
			const disclosureStyles = await main
				.locator('.method-disclosure-heading')
				.evaluateAll((headings) =>
					headings.map((item) => {
						const { fontSize, fontWeight } = getComputedStyle(item);
						return [fontSize, fontWeight];
					}),
				);
			expect(new Set(disclosureStyles.map((style) => style.join(' '))).size).toBe(1);
			const measure = main.locator('#fixture_delay');
			await expect(measure.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
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
			const ranking = main.locator('#ranking-range');
			await expect(ranking.getByRole('button').first()).toHaveAccessibleName(
				fr ? 'L’intervalle dans un classement' : 'The range on a ranking row',
			);
			await expect(ranking.locator('[data-slot="section-summary"]')).toHaveCount(0);
			const disclosures = main.locator('[data-method-bulk]');
			for (const card of await disclosures.all()) {
				const trigger = card.getByRole('button').first();
				if (await trigger.isVisible()) {
					const initiallyOpen = (await trigger.getAttribute('aria-expanded')) === 'true';
					await trigger.press('Enter');
					expect((await trigger.getAttribute('aria-expanded')) === 'true').toBe(!initiallyOpen);
					await trigger.press('Space');
					expect((await trigger.getAttribute('aria-expanded')) === 'true').toBe(initiallyOpen);
				}
			}
			await main.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all' }).click();
			await expect(main.locator('[data-method-bulk][data-state="open"]')).toHaveCount(0);
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
					'OC Transpo ne publie pas ses avis de service en données ouvertes. Elle les affiche sur son site Web.',
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
						'Non mesuré (Transit n’a collecté aucune donnée source)',
						'Non mesuré (Aucune édition de l’horaire)',
					]
				: [
						'Present',
						'Missing (File missing)',
						'Not measured (Transit collected no source data)',
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

test('Download offers every listed Parquet address in one file', async ({ page }) => {
	await page.goto(
		`/download?provider=stm&frameMode=record&recordFrom=2026-11-14&recordTo=2026-11-20`,
	);
	const main = page.getByRole('main');
	const fileLinks = main.locator('a[href*=".parquet?"]');
	await expect(fileLinks.first()).toBeAttached();
	const expected = await fileLinks.evaluateAll((links) =>
		links.map((link) => (link as HTMLAnchorElement).href),
	);
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		// The label counts the addresses it holds, as the page lists them.
		main.getByRole('link', { name: `Download ${expected.length} file addresses (.txt)` }).click(),
	]);
	expect(download.suggestedFilename()).toBe('transit-file-addresses.txt');
	const addresses = (await readFile((await download.path())!, 'utf8')).trim().split('\n');
	expect(addresses).toEqual(expected);
	await expect(
		main.getByText(new RegExp(`^${expected.length} data files, [\\d.,]+ MB total\\.$`)),
	).toBeVisible();
});

test('Download lays out the eight daily file cards in complete rows', async ({ page }) => {
	await page.goto(
		'/download?provider=stm&frameMode=record&recordFrom=2026-11-14&recordTo=2026-11-20',
	);
	const dailyFiles = page.locator('#daily-files');
	await expect(dailyFiles.getByRole('button', { name: 'See the layout and files' })).toHaveCount(8);
	const stamp = '[data-slot="stamp"][data-kind="record"]';
	for (const width of [390, 1280, 1440, 1920]) {
		await page.setViewportSize({ width, height: 900 });
		const rows = await dailyFiles
			.locator(':scope > *')
			.evaluateAll((cards) =>
				Object.values(
					Object.groupBy(cards, (card) => Math.round(card.getBoundingClientRect().top)),
				).map((row) => row!.length),
			);
		expect(rows, `file cards at ${width}px`).toEqual(width === 390 ? Array(8).fill(1) : [4, 4]);
		await expect(dailyFiles.locator(stamp)).toHaveCount(0);
		await expect(page.getByRole('main').locator(stamp)).toHaveCount(1);
		await expect(page.locator(`[data-slot="screen-answer"] ${stamp}`)).toBeVisible();
		if (width >= 1280) {
			const blocks = await page.locator('.download-content').evaluate((content) => {
				const selectors = [
					'[data-screen-intro]',
					'[data-slot="screen-answer"]',
					'.download-licence',
					'#daily-files',
					'#reading-files',
				];
				return selectors.map((selector) => {
					const { left, right } = content.querySelector(selector)!.getBoundingClientRect();
					return [Math.round(left), Math.round(right)];
				});
			});
			expect(blocks, `content edges at ${width}px`).toEqual(Array(5).fill(blocks[3]));
			const helpCards = await page
				.locator('#reading-files > *')
				.evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().top)));
			expect(helpCards).toEqual([helpCards[0], helpCards[0]]);
		}
	}
	await doubleText(page);
	for (const width of [390, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await textDefects(page, '#daily-files'), `200% text at ${width}px`).toEqual([]);
	}
});
