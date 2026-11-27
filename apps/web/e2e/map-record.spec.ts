import { expect, test, type Page, type Locator } from '@playwright/test';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';
import {
	closeMapControls,
	closeMapInView,
	openMapControls,
	openMapInView,
	openMapLegend,
} from './map-frame-controls';

async function pickLine(page: Page, input: Locator, code: string) {
	await input.click();
	await page
		.getByRole('listbox')
		.getByRole('option', { name: new RegExp(`^${code}\\b`) })
		.click();
}

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const prefix = fr ? '/fr' : '';
	test(`${locale} map layers follow the Record period and announce a selected entity`, async ({
		page,
	}) => {
		const received = await recordMapFixture(page);
		const livePeriod = new URLSearchParams(recordMapPeriod);
		livePeriod.set('frameMode', 'live');
		await page.goto(`${prefix}/map?${livePeriod}`);
		await expect(page.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
		await openMapControls(page);
		const phone = page.viewportSize()!.width < 1024;
		const layers = page.getByRole('radiogroup', { name: fr ? 'Couche' : 'Layer' });
		const views = page.getByRole('radiogroup', { name: fr ? 'Vue' : 'View' });
		const live = views.getByRole('radio', { name: fr ? 'En direct' : 'Live now' });
		await expect(live).toBeChecked();
		if (phone) {
			const pause = page.getByRole('switch', {
				name: fr ? 'Suspendre les mises à jour' : 'Pause live updates',
			});
			await expect(pause).toHaveAttribute('aria-checked', 'false');
			await pause.click();
			await expect(pause).toHaveAttribute('aria-checked', 'true');
			await pause.click();
			await expect(pause).toHaveAttribute('aria-checked', 'false');
		}
		await live.focus();
		await live.press('ArrowRight');
		await expect(page).toHaveURL(/mapLayer=stops/);
		if (phone) {
			await expect(
				page
					.locator('[data-map-in-view-sheet]')
					.getByRole('tab', { name: fr ? 'Options' : 'Controls' }),
			).toHaveAttribute('aria-selected', 'true');
		}
		await expect(layers.getByRole('radio', { name: fr ? 'Arrêts' : 'Stops' })).toBeChecked();
		await closeMapControls(page);
		const title = fr ? 'Carte du bilan' : 'Record map';
		await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
		await expect(page).toHaveTitle(new RegExp(`^${title}\\b`, 'u'));
		const legend = page.locator(
			phone ? '[data-map-legend="phone"]' : '[data-map-legend="desktop"]',
		);
		if (phone) await openMapLegend(page);
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
		await expect(selected).toContainText(/\b0\s*%/u);
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
		if (phone) await openMapLegend(page);
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
		await openMapControls(page);
		const filterTrigger = page.locator('[data-map-filter-trigger]');
		if ((await filterTrigger.getAttribute('aria-expanded')) === 'false')
			await filterTrigger.click();
		const line = page.getByRole('button', {
			name: fr ? 'Ajouter une ligne au filtre' : 'Add a line filter',
		});
		await pickLine(page, line, '24');
		const direction = page.locator('[data-map-direction-filter] [data-slot="combobox-trigger"]');
		await expect(direction).toBeEnabled();
		await direction.click();
		await page.getByRole('option', { name: /Jean-Talon/u }).click();
		await openMapInView(page);
		await expect.poll(() => received.at(-1)?.get('direction')).toBe('0');
		await expect(
			page.getByRole('heading', { name: fr ? 'Corridors en vue' : 'Corridors in view' }),
		).toBeVisible();
		await page
			.getByRole('searchbox', { name: fr ? 'Trouver un segment' : 'Find a segment' })
			.fill('Mont-Royal');
		await page.getByRole('button', { name: 'Mont-Royal → Laurier' }).last().click();
		await expect(selected).toContainText(/0[.,]7\s+min/);
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
		await openMapControls(page);
		if ((await filterTrigger.getAttribute('aria-expanded')) === 'false')
			await filterTrigger.click();
		await page.locator('[data-map-selected-lines] button').filter({ hasText: '24' }).click();
		await openMapInView(page);
		await expect(segment).toBeVisible();
		await expect.poll(() => received.at(-1)?.get('layer')).toBe('corridors');
		await page.reload();
		await openMapInView(page);
		await expect(segment).toBeVisible();
		await expect(page).not.toHaveURL(/[?&]route=/);
		if (phone) {
			await closeMapInView(page);
			await openMapControls(page);
			await live.click();
			await expect(page).toHaveURL(/frameMode=live/);
			await expect(live).toBeChecked();
			await expect(
				page
					.locator('[data-map-in-view-sheet]')
					.getByRole('tab', { name: fr ? 'Options' : 'Controls' }),
			).toHaveAttribute('aria-selected', 'true');
			await expect(page.getByTestId('map-controls-button')).toBeVisible();
		}
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

for (const [label, params] of [
	['carried Record view', 'frameMode=record'],
	['explicit Stops layer', 'frameMode=live&mapLayer=stops'],
]) {
	test(`the ${label} opens Record stops with its dates without a redirect`, async ({ page }) => {
		const received = await recordMapFixture(page);
		const response = await page.goto(
			`/map?provider=stm&recordFrom=2026-11-18&recordTo=2026-11-21&${params}`,
		);
		expect(response?.request().redirectedFrom()).toBeNull();
		await expect(page.getByRole('heading', { name: 'Record map' })).toBeVisible();
		await expect
			.poll(() => Object.fromEntries(received.at(-1) ?? []))
			.toEqual({ city: 'stm', from: '2026-11-18', to: '2026-11-21' });
		await openMapControls(page);
		await expect(
			page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Record' }),
		).toBeChecked();
		await expect(
			page.getByRole('radiogroup', { name: 'Layer' }).getByRole('radio', { name: 'Stops' }),
		).toBeChecked();
	});
}

test('the corridor layer still asks for a line when the engine refuses the network', async ({
	page,
}) => {
	await recordMapFixture(page, false);
	await page.goto(`/map?${recordMapPeriod}&mapLayer=corridors`);
	await openMapInView(page);
	await expect(page.getByText('Choose a line to see time lost between its stops.')).toBeVisible();
	await page.getByRole('button', { name: 'Choose a line', exact: true }).click();
	await pickLine(page, page.getByRole('button', { name: 'Add a line filter', exact: true }), '24');
	await openMapInView(page);
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
