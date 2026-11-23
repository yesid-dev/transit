import { expect, test } from '@playwright/test';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr'] as const) {
		const fr = locale === 'fr';
		test(`${locale} at ${width}px shows the Line record and schedule with evidence`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(
				`${fr ? '/fr' : ''}/lines/24?provider=${fr ? 'octranspo' : 'stm'}&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14`,
			);
			await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
			const main = page.getByRole('main');
			const section = (name: string) => main.getByRole('region', { name, exact: true }).first();
			const punctuality = section(fr ? 'Ponctualité' : 'On-time performance');
			await expect(
				punctuality.getByText(
					fr
						? /^Du .*80\s% des passages.*80 sur 100/
						: /^From .*80% of observed stop events.*80 of 100/,
				),
			).toBeVisible();
			await expect(
				punctuality.getByText(fr ? 'En avance' : 'Early', { exact: true }),
			).toBeVisible();
			await expect(
				punctuality.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await punctuality.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(punctuality.getByText(/line-fixture-v1/)).toBeVisible();
			const csv = punctuality.getByRole('link', { name: /CSV/ });
			const response = await request.get((await csv.getAttribute('href'))!);
			expect(response.ok()).toBeTruthy();
			expect(await response.text()).toMatch(fr ? /^Mesure,Valeur/ : /^Measure,Value/);

			const waiting = section(fr ? 'Attente et intervalles' : 'Waiting and gaps');
			await expect(waiting).toContainText(fr ? '24 intervalles observés' : '24 observed intervals');
			await expect(waiting).toContainText(
				fr ? 'Attente observée moins attente prévue.' : 'Observed wait minus scheduled wait.',
			);
			await expect(waiting).toContainText(
				fr ? 'sur 48 intervalles prévus' : 'coverage of 48 scheduled intervals',
			);
			const offered = section(fr ? 'Service offert' : 'Service offered');
			await expect(offered.getByRole('row', { name: /07:00–08:00/ })).toContainText('8/1');
			await expect(offered).toContainText(fr ? 'Aucun service prévu' : 'No service scheduled');
			await offered
				.getByRole('link', { name: fr ? /Voir les trajets/ : /See scheduled and delivered trips/ })
				.click();
			await expect(page).toHaveURL(/#delivery$/);

			const stop = section(fr ? 'Retard le long de ses arrêts' : 'Delay along its stops');
			await expect(stop.getByRole('rowheader')).toHaveText([/1\. First stop/, /2\. Second stop/]);
			const dailyTitle = fr ? 'Jour par jour' : 'Day by day';
			const daily = section(dailyTitle);
			const strip = daily.getByRole('list', { name: dailyTitle, exact: true });
			await expect(strip.getByRole('listitem')).toHaveCount(2);
			await expect(strip.getByRole('listitem').first()).toContainText(fr ? /80\s%/ : '80%');
			await expect(strip.getByRole('listitem').last()).toContainText(
				fr ? 'Aucune part mesurée' : 'No measured share',
			);
			await expect(
				daily.getByRole('table', { name: dailyTitle }).getByRole('rowheader'),
			).toHaveCount(1);
			await expect(
				section(fr ? 'Par heure et jour de la semaine' : 'By hour and weekday').getByRole(
					'rowheader',
				),
			).toHaveCount(24);
			await expect(
				section(fr ? 'Par direction' : 'Each direction').getByRole('rowheader'),
			).toHaveCount(2);
			await expect(
				section(
					fr
						? 'Trajets annulés et manquants, par départ'
						: 'Cancelled and missing trips, by departure',
				).getByRole('cell', { name: '6', exact: true }),
			).toBeVisible();
			await expect(
				section(fr ? 'Départs le plus souvent en retard' : 'Departures late most often').getByRole(
					'rowheader',
					{ name: '07:00:00' },
				),
			).toBeVisible();
			await expect(section(fr ? 'Achalandage' : 'Crowding')).toContainText(
				fr ? 'Non suivi' : '25%',
			);
			await expect(
				section(fr ? 'Avis de l’agence à ces dates' : 'Agency notices on these dates').getByText(
					'3',
					{ exact: true },
				),
			).toBeVisible();
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
			const filter = main.getByRole('navigation', {
				name: fr ? 'Filtrer par direction' : 'Filter by direction',
			});
			await filter.locator('a').last().click();
			await expect(page).toHaveURL(/direction=1/);
			await expect(punctuality).toContainText(
				fr ? /40\s% des passages/ : /40% of observed stop events/,
			);

			await main.getByRole('link', { name: fr ? 'Horaire' : 'Schedule', exact: true }).click();
			await expect(section(fr ? 'Fréquence prévue' : 'Planned frequency')).toContainText(
				fr ? 'Pointe du matin' : 'Morning peak',
			);
			await expect(
				section(fr ? 'Premiers et derniers trajets' : 'First and last trips'),
			).toContainText('25:15:00');
			await expect(page).toHaveURL(/direction=1/);
		});
	}
}

for (const theme of ['light', 'dark'] as const) {
	test(`Line evidence reflows at 320px and 200% text in ${theme} mode`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 900 });
		await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
		await page.goto(
			'/lines/24?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14',
		);
		await page.addStyleTag({ content: 'html { font-size: 200%; }' });
		const main = page.getByRole('main');
		const daily = main.getByRole('table', { name: 'Day by day' });
		await expect(daily.getByRole('columnheader', { name: 'On-time share' })).toBeAttached();
		await expect(daily.getByRole('cell', { name: /80%/ })).toBeVisible();
		expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320);
		const heatmap = main.getByRole('region', { name: 'By hour and weekday' }).getByRole('region');
		await expect(heatmap).toHaveAttribute('tabindex', '0');
		await heatmap.focus();
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => heatmap.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
	});
}

test('Line shows patience for a slow stop query while punctuality is already readable', async ({
	page,
	request,
}) => {
	await page.goto(
		'/lines/24?provider=stm&frameMode=record&recordFrom=2026-11-09&recordTo=2026-11-15',
		{ waitUntil: 'commit' },
	);
	await expect(page.getByText(/^From .*80% of observed stop events/)).toBeVisible();
	await expect(
		page.getByText('Still working on this. You can wait or come back later.'),
	).toBeVisible();
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	expect(
		(await request.post(`http://127.0.0.1:${dataPort}/__overview/release?fixture=line`)).status(),
	).toBe(204);
	await expect(page.getByRole('rowheader', { name: /Second stop/ })).toBeVisible();
});
