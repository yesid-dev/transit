import { expect, test } from '@playwright/test';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const prefix = fr ? '/fr' : '';
	test(`${locale} map layers follow the Record period and announce a selected entity`, async ({
		page,
	}) => {
		const received = await recordMapFixture(page);
		await page.goto(`${prefix}/map?${recordMapPeriod}`);
		const layers = page.getByRole('radiogroup', {
			name: fr ? 'Couches de la carte' : 'Map layers',
		});
		const live = layers.getByRole('radio', { name: fr ? 'En direct' : 'Live' });
		await expect(live).toBeChecked();
		await live.focus();
		await live.press('ArrowRight');
		await expect(layers.getByRole('radio', { name: fr ? 'Arrêts' : 'Stops' })).toBeChecked();
		const legend = page.locator('[data-slot="record-map-legend"]');
		for (const state of fr
			? ['Trop peu pour juger', 'Non mesuré', 'Aucune donnée en direct']
			: ['Too few to judge', 'Not measured', 'No live data']) {
			await expect(legend.getByText(state, { exact: true })).toBeVisible();
		}
		const find = page.getByRole('searchbox', { name: fr ? 'Trouver un arrêt' : 'Find a stop' });
		await find.fill('Mont-Royal');
		const stop = page.getByRole('button', { name: 'Mont-Royal', exact: true });
		await expect(stop).toBeVisible();
		await stop.press('Enter');
		const selected = page.locator('[data-slot="record-map-selection"]');
		await expect(selected).toContainText(fr ? 'Mesuré' : 'Measured');
		await expect(selected).toContainText(/0\s*%/);
		await expect(selected).toContainText('45');
		await expect(
			page.getByRole('link', { name: fr ? 'Bilan de l’arrêt' : 'Stop Record' }),
		).toHaveAttribute('href', /\/stop\/MR1.*recordFrom=2026-11-18/);
		await find.fill('Rosemont');
		await page.getByRole('button', { name: 'Rosemont', exact: true }).click();
		await expect(selected).toContainText(fr ? 'Non mesuré' : 'Not measured');
		await expect(selected).toContainText(fr ? 'Aucun passage observé' : 'No stop events observed');

		await layers.getByRole('radio', { name: 'Corridors' }).click();
		await expect(
			legend.getByText(fr ? 'Non mesuré' : 'Not measured', { exact: true }),
		).toBeVisible();
		const segment = page.getByRole('searchbox', {
			name: fr ? 'Trouver un segment' : 'Find a segment',
		});
		await segment.fill('Mont-Royal');
		await page.getByRole('button', { name: 'Mont-Royal → Laurier' }).click();
		await expect(selected).toContainText('34');
		await expect(
			page
				.getByRole('list', { name: fr ? /Lignes qui desservent/ : /Lines serving/ })
				.getByRole('link'),
		).toHaveAttribute('href', /\/lines\/24.*recordTo=2026-11-21/);
		const line = page.getByRole('combobox', { name: fr ? 'Ligne' : 'Line', exact: true });
		await line.selectOption('24');
		await page.getByRole('combobox', { name: 'Direction', exact: true }).selectOption('0');
		await expect.poll(() => received.at(-1)?.get('direction')).toBe('0');
		await expect(
			page.getByRole('heading', { name: fr ? /Temps perdu moyen/ : /Mean time lost/ }),
		).toBeVisible();
		await page
			.getByRole('searchbox', { name: fr ? 'Trouver un segment' : 'Find a segment' })
			.fill('Mont-Royal');
		await page.getByRole('button', { name: 'Mont-Royal → Laurier' }).click();
		await expect(selected).toContainText(fr ? '0,7 min' : '0.7 min');
		await expect(selected).toContainText('34');
		await expect(
			page.getByRole('link', { name: fr ? 'Bilan de la ligne' : 'Line Record' }),
		).toHaveAttribute('href', /\/lines\/24.*direction=0.*recordTo=2026-11-21/);
		expect(received.every((params) => params.get('from') === '2026-11-18')).toBe(true);
		expect(received.every((params) => params.get('city') === 'stm')).toBe(true);
		await page.getByRole('button', { name: fr ? /^Période/ : /^Period/ }).click();
		await page.getByRole('button', { name: fr ? 'Hier' : 'Yesterday', exact: true }).click();
		await expect.poll(() => received.at(-1)?.get('from')).toBe('2026-11-22');
		expect(received.at(-1)?.get('line')).toBe('24');
		await line.selectOption('');
		await expect(segment).toBeVisible();
		await expect.poll(() => received.at(-1)?.get('layer')).toBe('corridors');
		await page.reload();
		await expect(segment).toBeVisible();
		await expect(line).toHaveValue('');
	});

	test(`${locale} Line Record opens corridors for the same line, dates and direction`, async ({
		page,
	}) => {
		const received = await recordMapFixture(page);
		await page.goto(`${prefix}/lines/24?${recordMapPeriod}&direction=0`);
		await page
			.getByRole('link', {
				name: fr ? 'Voir les corridors sur la carte' : 'See corridors on the map',
			})
			.click();
		await expect
			.poll(() => Object.fromEntries(received.at(-1) ?? []))
			.toMatchObject({
				city: 'stm',
				line: '24',
				direction: '0',
				from: '2026-11-18',
				to: '2026-11-21',
			});
	});
}

test('the corridor layer still asks for a line when the engine refuses the network', async ({
	page,
}) => {
	await recordMapFixture(page, false);
	await page.goto(`/map?${recordMapPeriod}&mapLayer=corridors`);
	await expect(page.getByText('Choose a line to see time lost between its stops.')).toBeVisible();
	await page.getByRole('combobox', { name: 'Line', exact: true }).selectOption('24');
	await expect(page.getByRole('searchbox', { name: 'Find a segment' })).toBeVisible();
});
