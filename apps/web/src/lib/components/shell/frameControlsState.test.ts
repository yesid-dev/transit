import { describe, expect, it } from 'vitest';
import { frameControlsState, framePeriodSummary } from './frameControlsState.ts';

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

	it.each(['/privacy', '/fr/terms', '/accessibility', '/roadmap', '/fr/metrics/archive/'])(
		'keeps the controls rail off the reading page %s',
		(path) => expect(state(path)).toMatchObject({ showRail: false }),
	);

	it('keeps the controls rail off an error page at any path', () => {
		const url = new URL('/fr/vehicles?frameMode=live', 'https://transit.test');
		expect(frameControlsState(url, clock(), true)).toMatchObject({
			showRail: false,
			showViewHint: false,
		});
		expect(frameControlsState(url, clock())).toMatchObject({ showRail: true });
		expect(state('/metrics')).toMatchObject({ showRail: true });
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

	it('replaces an unavailable Yesterday answer while keeping the diagnostic screens usable', () => {
		const url = new URL(
			'https://transit.test/lines/51?period=yesterday&recordFrom=2026-11-21&recordTo=2026-11-21',
		);
		expect(frameControlsState(url, clock('2026-11-20')).waitingForYesterday).toBe('2026-11-21');
		expect(frameControlsState(url, clock('2026-11-21')).waitingForYesterday).toBeNull();
		expect(frameControlsState(url, clock()).waitingForYesterday).toBeNull();
		for (const path of ['/status', '/download']) {
			url.pathname = path;
			expect(frameControlsState(url, clock('2026-11-20'))).toMatchObject({
				waitingForYesterday: null,
				period: { from: '2026-11-21', to: '2026-11-21' },
			});
		}
	});

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
});
