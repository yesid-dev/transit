import { expect, test } from '@playwright/test';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';
import {
	closeMapControls,
	closeMapInView,
	openMapControls,
	openMapInView,
} from './map-frame-controls';

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const prefix = fr ? '/fr' : '';
	test(`${locale} map layers follow the Record period and announce a selected entity`, async ({
		page,
	}) => {
		const received = await recordMapFixture(page);
		await page.goto(`${prefix}/map?${recordMapPeriod}`);
		await openMapControls(page);
		const layers = page.getByRole('radiogroup', { name: fr ? 'Couche' : 'Layer' });
		const views = page.getByRole('radiogroup', { name: fr ? 'Vue' : 'View' });
		const live = views.getByRole('radio', { name: fr ? 'En direct' : 'Live now' });
		await expect(live).toBeChecked();
		await live.focus();
		await live.press('ArrowRight');
		await expect(layers.getByRole('radio', { name: fr ? 'Arrêts' : 'Stops' })).toBeChecked();
		await closeMapControls(page);
		const phone = page.viewportSize()!.width < 1024;
		const legend = page.locator(
			phone ? '[data-map-legend="phone"]' : '[data-map-legend="desktop"]',
		);
		if (phone) await page.getByTestId('map-legend-button').click();
		for (const state of fr
			? ['Trop peu pour juger', 'Non mesuré', 'Aucune donnée en direct']
			: ['Too few to judge', 'Not measured', 'No live data']) {
			await expect(legend.getByText(state, { exact: true })).toBeVisible();
		}
		if (phone) await page.keyboard.press('Escape');
		await openMapInView(page);
		const find = page.getByRole('searchbox', { name: fr ? 'Trouver un arrêt' : 'Find a stop' });
		await find.fill('Mont-Royal');
		const stop = page.getByRole('button', { name: 'Mont-Royal', exact: true }).last();
		await expect(stop).toBeVisible();
		await stop.press('Enter');
		const selected = page.locator('[data-slot="record-map-selection"]');
		await expect(selected).toContainText(fr ? 'Mesuré' : 'Measured');
		await expect(selected).toContainText(/0[.,]0\s*%/);
		await expect(selected).toContainText('45');
		await expect(
			page.getByRole('link', { name: fr ? 'Bilan de l’arrêt' : 'Stop Record' }),
		).toHaveAttribute('href', /\/stop\/MR1.*recordFrom=2026-11-18/);
		await find.fill('Rosemont');
		await page.getByRole('button', { name: 'Rosemont', exact: true }).last().click();
		await expect(selected).toContainText(fr ? 'Non mesuré' : 'Not measured');
		await expect(selected).toContainText(fr ? 'Aucun passage classé' : 'No classified stop events');

		await closeMapInView(page);
		await openMapControls(page);
		await layers.getByRole('radio', { name: 'Corridors' }).click();
		await closeMapControls(page);
		if (phone) await page.getByTestId('map-legend-button').click();
		await expect(
			legend.getByText(fr ? 'Non mesuré' : 'Not measured', { exact: true }),
		).toBeVisible();
		if (phone) await page.keyboard.press('Escape');
		await openMapInView(page);
		const segment = page.getByRole('searchbox', {
			name: fr ? 'Trouver un segment' : 'Find a segment',
		});
		await segment.fill('Mont-Royal');
		await page.getByRole('button', { name: 'Mont-Royal → Laurier' }).last().click();
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
			page.getByRole('heading', { name: fr ? 'Corridors en vue' : 'Corridors in view' }),
		).toBeVisible();
		await page
			.getByRole('searchbox', { name: fr ? 'Trouver un segment' : 'Find a segment' })
			.fill('Mont-Royal');
		await page.getByRole('button', { name: 'Mont-Royal → Laurier' }).last().click();
		await expect(selected).toContainText(/42\s+s/);
		await expect(selected).toContainText('34');
		await expect(
			page.getByRole('link', { name: fr ? 'Bilan de la ligne' : 'Line Record' }),
		).toHaveAttribute('href', /\/lines\/24.*direction=0.*recordTo=2026-11-21/);
		expect(received.every((params) => params.get('from') === '2026-11-18')).toBe(true);
		expect(received.every((params) => params.get('city') === 'stm')).toBe(true);
		await closeMapInView(page);
		await openMapControls(page);
		await page
			.getByRole('button', { name: fr ? 'Choisir d’autres dates' : 'Choose other dates' })
			.click();
		await page.getByRole('radio', { name: fr ? 'Hier' : 'Yesterday', exact: true }).click();
		await closeMapControls(page);
		await expect.poll(() => received.at(-1)?.get('from')).toBe('2026-11-22');
		expect(received.at(-1)?.get('line')).toBe('24');
		await openMapInView(page);
		await line.selectOption('');
		await expect(segment).toBeVisible();
		await expect.poll(() => received.at(-1)?.get('layer')).toBe('corridors');
		await page.reload();
		await openMapInView(page);
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
	await openMapInView(page);
	await expect(page.getByText('Choose a line to see time lost between its stops.')).toBeVisible();
	await page.getByRole('combobox', { name: 'Line', exact: true }).selectOption('24');
	await expect(page.getByRole('searchbox', { name: 'Find a segment' })).toBeVisible();
});

test('an old Reports address preserves the city, period, layer and active line', async ({
	request,
}) => {
	const query =
		'provider=stm&mapLayer=corridors&recordFrom=2026-11-18&recordTo=2026-11-21&route=24';
	const response = await request.get(`/fr/map/reports?${query}&mapView=reports`, {
		maxRedirects: 0,
	});
	expect(response.status()).toBe(308);
	expect(response.headers().location).toBe(`/fr/map?${query}`);
});
