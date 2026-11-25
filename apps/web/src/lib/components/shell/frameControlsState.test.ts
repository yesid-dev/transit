import { describe, expect, it } from 'vitest';
import { frameControlsState, framePeriodSummary } from './frameControlsState.ts';

const today = '2026-11-22';
const clock = (recordThrough: string | null = null) => ({ today, recordThrough });
const state = (href: string) => frameControlsState(new URL(href, 'https://transit.test'), clock());

describe('frame control state', () => {
	it.each(['/lines', '/fr/stops/', '/receipt', '/fr/repeat-offenders', '/fr/download'])(
		'shows Record when a live link opens the record-only %s',
		(path) =>
			expect(state(path + '?frameMode=live')).toMatchObject({ mode: 'record', recordOnly: true }),
	);

	it('recognizes links to legacy Live details and Record map layers', () => {
		expect(state('/lines/24?tab=detail').mode).toBe('live');
		expect(state('/fr/stop/S1?tab=detail').mode).toBe('live');
		expect(state('/map?frameMode=record').mode).toBe('live');
		expect(state('/trip/T1?frameMode=record')).toMatchObject({ mode: 'live', liveOnly: true });
		expect(state('/map?mapLayer=corridors&recordLine=24').mode).toBe('record');
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
