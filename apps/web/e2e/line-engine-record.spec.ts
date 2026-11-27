import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr'] as const) {
		const fr = locale === 'fr';
		const path = `${fr ? '/fr' : ''}/lines/24?provider=${fr ? 'octranspo' : 'stm'}&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14`;
		test(`${locale} at ${width}px shows the Line record with evidence`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(path);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			const main = page.getByRole('main');
			const answer = main.locator('#punctuality');
			await expect(answer).toContainText(fr ? /80,0\s%/u : '80.0%');
			await expect(main.getByRole('heading', { level: 1 })).toContainText(
				fr ? 'Ligne 24' : 'Line 24',
			);
			const meta = answer.locator('[data-slot="answer-evidence"]');
			await expect(meta.locator('p').first()).toContainText(fr ? 'Ce qui est compté' : 'Counted:');
			await expect(meta).not.toContainText(fr ? 'nettoyage' : 'cleaning');
			await expect(main.locator('#directions dd').first()).toContainText(fr ? /80,0\s%/u : '80.0%');
			const schedule = main.locator('#schedule');
			await expect(schedule).toContainText(fr ? 'toutes les 12 min' : 'every 12 min');
			await expect(schedule).toContainText(
				fr ? 'direction qui compte le plus de trajets' : 'direction with the most scheduled trips',
			);

			const trend = main.locator('#daily');
			await trend.getByRole('button', { name: fr ? 'Tableau' : 'Table', exact: true }).click();
			await expect(trend.getByRole('rowheader')).toHaveCount(2);
			if (width === 390) {
				const stopLadder = main.locator('#stops').getByRole('button').first();
				await expect(stopLadder).toHaveAttribute('aria-expanded', 'false');
				await main
					.getByRole('button', { name: fr ? 'Tout déplier' : 'Expand all', exact: true })
					.click();
			}
			const waiting = main.locator('#waiting');
			await expect(waiting).toContainText(fr ? 'l’attente estimée' : 'estimated waits');
			await expect(waiting).toContainText(
				fr ? /Mesuré sur 20 des 48 intervalles prévus/ : 'Measured on 20 of the 48 gaps planned',
			);
			await expect(waiting).toContainText(fr ? /41,7\s%/ : '41.7%');
			const offered = main.locator('#offered');
			await expect(offered.locator('[data-slot="chart-frame"]')).toBeVisible();
			await expect(offered).toContainText(
				fr
					? /Le service prévu culminait de 7\sh\sà\s8\sh\s:\s8 trajets par heure\./u
					: 'Planned service peaked from 07:00 to 08:00: 8 trips an hour.',
			);
			await expect(
				offered.getByRole('row', { name: fr ? /7\sh\sà\s8\sh/u : /07:00.*08:00/ }),
			).toContainText(fr ? '8 trajets sur 1 jour' : '8 trips over 1 day');
			await expect(offered).toContainText(fr ? 'Aucun service prévu' : 'No service scheduled');
			await offered
				.getByRole('link', { name: fr ? /Voir les trajets/ : /See scheduled and delivered trips/ })
				.click();
			await expect(page).toHaveURL(/#delivery$/);
			await expect(main.locator('#stops [data-highlighted]')).toHaveCount(2);
			// On a phone each departure is one row: ran of scheduled, then cancelled and missing.
			if (width === 390)
				await expect(main.locator('#delivery')).toContainText(fr ? '6 manquants' : '6 missing');
			else
				await expect(
					main.locator('#delivery').getByRole('cell', { name: '6', exact: true }),
				).toBeVisible();
			await expect(main.locator('#delivery')).toContainText(
				fr ? '8 des 40 trajets prévus' : '8 of 40 scheduled trips did not run',
			);
			await expect(main.locator('#delivery')).not.toContainText(fr ? '1 sur 1' : 'Showing 1 of 1');
			await expect(
				main.locator('#late').getByRole('link', { name: fr ? /7\sh/u : /07:00/ }),
			).toBeVisible();
			await expect(main.locator('#late')).toContainText(fr ? 'se classe premier' : 'ranked first');
			await expect(main.locator('#crowding')).toContainText(fr ? 'Non suivi' : '25.0%');
			await expect(main.locator('#alerts')).toContainText(
				fr ? /3 avis/ : /3 (?:distinct )?notices/,
			);

			await main
				.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all', exact: true })
				.click();
			await expect(main.locator('#delivery').getByRole('table')).toHaveCount(0);
			await main
				.getByRole('button', { name: fr ? 'Tout déplier' : 'Expand all', exact: true })
				.click();
			await expect(main.locator('#delivery table')).toBeVisible();
		});

		test(`${locale} at ${width}px Live reads the planned frequency toward a terminus`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(path.replace('frameMode=record', 'frameMode=live'));
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			const schedule = page.getByRole('main').locator('#schedule');
			await expect(schedule).toContainText(fr ? 'toutes les 12 min' : 'every 12 min');
			await expect(schedule).toContainText(
				fr ? 'direction qui compte le plus de trajets' : 'direction with the most scheduled trips',
			);
			await expect(schedule.locator('#frequency')).not.toContainText(fr ? 'Inconnu' : 'Unknown');
		});

		test(`${locale} at ${width}px opens the schedule tab with its periods`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(path + '&direction=1&tab=schedule');
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			const main = page.getByRole('main');
			await expect(page).toHaveURL(
				(url) =>
					url.hash === '#schedule' &&
					url.searchParams.get('direction') === '1' &&
					!url.searchParams.has('tab'),
			);
			await expect(main.locator('#schedule')).toContainText(
				fr ? 'Pointe du matin' : 'Morning peak',
			);
			await expect(main.locator('#schedule')).toContainText(
				fr ? '1 h 15, le lendemain' : '01:15, next day',
			);
			await expect(main.locator('#punctuality')).toContainText(fr ? /40,0\s%/u : '40.0%');
			await main
				.locator('#schedule')
				.getByRole('radio', { name: fr ? 'Samedi' : 'Saturday' })
				.click();
			await expect(main.locator('#schedule')).toContainText(
				fr ? 'toutes les 15 min' : 'every 15 min',
			);
		});
	}
}

test('Line shows patience for a slow stop query while punctuality is already readable', async ({
	page,
	request,
}) => {
	await page.goto(
		'/lines/24?provider=stm&frameMode=record&recordFrom=2026-11-09&recordTo=2026-11-15',
		{ waitUntil: 'commit' },
	);
	await expect(page.locator('#punctuality')).toContainText('80.0%');
	await expect(page.getByText('Still calculating the record')).toBeVisible();
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	expect(
		(await request.post(`http://127.0.0.1:${dataPort}/__overview/release?fixture=line`)).status(),
	).toBe(204);
	await expect(page.locator('#stops')).toContainText('Second stop');
});

test('keyboard changes the hour grid direction and retains focus', async ({ page }) => {
	await page.goto('/lines/24?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const hours = page.locator('#hourly');
	const choices = hours.getByRole('radiogroup', { name: 'Filter by direction' });
	const both = choices.getByRole('radio', { name: 'Both directions' });
	await expect(both).toBeChecked();
	await both.focus();
	await page.keyboard.press('ArrowLeft');
	await expect(page).toHaveURL(/direction=1/u);
	const selected = choices.getByRole('radio').last();
	await expect(selected).toBeChecked();
	await expect(selected).toBeFocused();
	await expect(hours.getByRole('table')).toBeVisible();
});
