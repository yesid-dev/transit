import { describe, expect, it } from 'vitest';
import {
	frameControlsState,
	framePeriodSummary,
	recordStartNotice,
	recordEndNotice,
} from './frameControlsState.ts';

const today = '2026-11-22';
const clock = (recordThrough: string | null = null) => ({ today, recordThrough });
const state = (href: string) => frameControlsState(new URL(href, 'https://transit.test'), clock());

describe('frame control state', () => {
	it.each(['/', '/fr/network', '/lines/24', '/stop/S1', '/vehicles', '/vehicle/1', '/alerts'])(
		'shows the View hint in both modes on %s',
		(path) => {
			for (const mode of ['live', 'record'])
				expect(state(`${path}?frameMode=${mode}`)).toMatchObject({ mode, showViewHint: true });
		},
	);

	it('leaves the map to explain its modes in its Period card and layer line', () => {
		for (const href of ['/map?frameMode=live', '/fr/map?mapLayer=stops&frameMode=record'])
			expect(state(href)).toMatchObject({ showRail: true, showViewHint: false });
	});

	it.each([
		'/fr/receipt',
		'/download',
		'/trip/T1',
		'/privacy',
		'/terms',
		'/fr/accessibility',
		'/roadmap',
		'/metrics/archive',
	])('uses no View hint when %s has no View choice', (path) =>
		expect(state(path)).toMatchObject({ showViewHint: false }),
	);

	it.each([
		'/privacy',
		'/fr/terms',
		'/accessibility',
		'/roadmap',
		'/fr/metrics/archive/',
		'/metrics',
		'/fr/metrics?frameMode=record',
		'/search?q=51',
	])('keeps the controls rail off the page %s, which reads no record', (path) =>
		expect(state(path)).toMatchObject({ showRail: false }),
	);

	it('keeps the controls rail off an error page at any path', () => {
		const url = new URL('/fr/vehicles?frameMode=live', 'https://transit.test');
		expect(frameControlsState(url, clock(), true)).toMatchObject({
			showRail: false,
			showViewHint: false,
		});
		expect(frameControlsState(url, clock())).toMatchObject({ showRail: true });
		expect(state('/network')).toMatchObject({ showRail: true });
	});

	it.each(['/lines', '/fr/stops/', '/receipt', '/fr/rankings', '/fr/download'])(
		'shows Record when a live link opens the record-only %s',
		(path) =>
			expect(state(path + '?frameMode=live')).toMatchObject({ mode: 'record', recordOnly: true }),
	);

	it('recognizes links to legacy Live details and Record map layers', () => {
		expect(state('/lines/24?tab=detail').mode).toBe('live');
		expect(state('/fr/stop/S1?tab=detail').mode).toBe('live');
		expect(state('/trip/T1?frameMode=record')).toMatchObject({ mode: 'live', liveOnly: true });
		expect(state('/map?mapLayer=corridors&recordLine=24').mode).toBe('record');
	});

	it('defaults a carried Record view to stops and respects an explicit map layer', () => {
		expect(state('/map?frameMode=record&recordFrom=2026-11-17&recordTo=2026-11-21')).toMatchObject({
			mode: 'record',
			period: { from: '2026-11-17', to: '2026-11-21' },
		});
		expect(state('/map?frameMode=live&mapLayer=stops').mode).toBe('record');
		expect(state('/map?frameMode=record&mapLayer=live').mode).toBe('live');
		expect(state('/map?recordFrom=2026-11-17&recordTo=2026-11-21').mode).toBe('live');
	});

	it.each(['/', '/lines', '/lines/51', '/network', '/status', '/map', '/receipt'])(
		'keeps Yesterday selected and names the built day on %s',
		(path) => {
			const url = new URL(
				path + '?frameMode=record&period=yesterday&recordFrom=2026-11-26&recordTo=2026-11-26',
				'https://transit.test',
			);
			const late = { today: '2026-11-27', recordThrough: '2026-11-25' };
			const frame = frameControlsState(url, late);
			expect(frame.period).toEqual({ preset: 'yesterday', from: '2026-11-25', to: '2026-11-25' });
			expect(recordEndNotice(frame.afterRecord, 'en')).toBe(
				'26 November is not in the record yet. Showing 25 November.',
			);
			expect(recordEndNotice(frame.afterRecord, 'fr')).toBe(
				'Le 26 novembre ne figure pas encore au bilan. Affichage du 25 novembre.',
			);
			expect(
				frameControlsState(url, { ...late, recordThrough: '2026-11-26' }).afterRecord,
			).toBeNull();
		},
	);

	it.each(['/download?frameMode=record', '/?frameMode=live'])(
		'keeps the requested Yesterday dates at %s',
		(path) => {
			const url = new URL(
				path + '&period=yesterday&recordFrom=2026-11-21&recordTo=2026-11-21',
				'https://transit.test',
			);
			expect(frameControlsState(url, clock('2026-11-20'))).toMatchObject({
				afterRecord: null,
				period: { preset: 'yesterday', from: '2026-11-21', to: '2026-11-21' },
			});
		},
	);

	it('describes pinned dates and their inclusive duration in either language', () => {
		const { period } = state('/?period=7-days&recordFrom=2026-11-01&recordTo=2026-11-07');
		expect(framePeriodSummary(period, 'en')).toEqual({
			title: 'Last 7 complete days',
			dates: '1 to 7 Nov 2026',
			duration: '7 days',
		});
		expect(framePeriodSummary(period, 'fr')).toEqual({
			title: '7 derniers jours complets',
			dates: 'du 1 au 7 nov. 2026',
			duration: '7 jours',
		});
		expect(framePeriodSummary({ from: today, to: today, preset: null }, 'fr')?.duration).toBe(
			'1 jour',
		);
	});
	it.each([
		['en', 'The record starts 13 October 2026. Showing the last 7 complete days.'],
		['fr', 'Le bilan commence le 13 octobre 2026. Affichage des 7 derniers jours complets.'],
	] as const)('says once in %s when a link asks for dates before the record', (locale, text) => {
		const before = state('/lines/24?recordFrom=2026-09-01&recordTo=2026-09-07');
		expect(before.period).toMatchObject({ preset: '7-days', from: '2026-11-15', to: '2026-11-21' });
		expect(recordStartNotice(before.beforeRecord, locale)).toBe(text);
	});

	it('names the city’s own first day and stays quiet otherwise', () => {
		const url = new URL('/stops?recordFrom=2026-10-20&recordTo=2026-10-26', 'https://transit.test');
		const city = frameControlsState(url, { ...clock(), recordStart: '2026-11-01' });
		expect(recordStartNotice(city.beforeRecord, 'en')).toMatch(
			/^The record starts 1 November 2026\./,
		);
		for (const href of [
			'/lines/24?recordFrom=2026-11-01&recordTo=2026-11-07',
			'/lines/24?recordFrom=2026-11-07&recordTo=2026-11-01',
			'/roadmap?recordFrom=2026-09-01&recordTo=2026-09-07',
			'/lines/24?frameMode=live&tab=detail&recordFrom=2026-09-01&recordTo=2026-09-07',
		])
			expect(state(href).beforeRecord).toBeNull();
	});

	it.each([
		['en', '26 November is not in the record yet. Showing 18 to 24 November.'],
		['fr', 'Le 26 novembre ne figure pas encore au bilan. Affichage du 18 au 24 novembre.'],
	] as const)(
		'names the requested and displayed dates in %s when a link is ahead of the record',
		(locale, text) => {
			const url = new URL('https://transit.test/receipt?recordFrom=2026-11-26&recordTo=2026-11-26');
			const lateClock = { today: '2026-11-26', recordThrough: '2026-11-24' };
			const frame = frameControlsState(url, lateClock);
			expect(frame.period).toMatchObject({ from: '2026-11-18', to: '2026-11-24' });
			expect(recordEndNotice(frame.afterRecord, locale)).toBe(text);
			url.search = '?period=yesterday&recordFrom=2026-11-25&recordTo=2026-11-25';
			const daily = frameControlsState(url, lateClock);
			expect(daily.period).toEqual({ preset: 'yesterday', from: '2026-11-24', to: '2026-11-24' });
			expect(recordEndNotice(daily.afterRecord, locale)).toBe(
				locale === 'en'
					? '25 November is not in the record yet. Showing 24 November.'
					: 'Le 25 novembre ne figure pas encore au bilan. Affichage du 24 novembre.',
			);
			url.pathname = '/roadmap';
			expect(frameControlsState(url, lateClock).afterRecord).toBeNull();
		},
	);
});
