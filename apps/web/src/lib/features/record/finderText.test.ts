import { expect, it } from 'vitest';
import { stateText, measure } from '#lib/features/home/overviewRecord.fixture.ts';
import { finderShare, finderTrips, finderCsv } from './finderText.ts';

const cell = {
	key: { line: '24' },
	state: 'measured',
	state_text: stateText.measured,
	value: { on_time: 0.75, trips_run: 0.9 },
	evidence: { counts: { classified: 100, on_time: 75, late: 10, ran: 90, scheduled: 111 } },
} as const;

it('reads classified counts for the late band and scheduled counts for delivery', () => {
	expect(finderShare(cell, null, 'late', 'en')).toEqual({ value: 0.1, text: '10.0% (10/100)' });
	expect(finderShare(cell, null, 'on_time', 'fr').text).toMatch(/^75,0\s% \(75\/100\)$/u);
	expect(finderTrips(cell, null, 'en')).toEqual({ value: 90 / 111, text: '90 of 111' });
	expect(finderTrips(cell, null, 'fr').text).toBe('90 sur 111');
});

it.each(['too_few_to_judge', 'not_measured', 'no_live_data', 'unknown'] as const)(
	'keeps the engine’s %s state instead of displaying a share',
	(state) => {
		const unmeasured = { ...cell, state, state_text: stateText[state] };
		expect(finderShare(unmeasured, null, 'on_time', 'en')).toEqual({
			value: null,
			text: stateText[state].en,
		});
		expect(finderTrips(unmeasured, null, 'fr')).toEqual({ value: null, text: stateText[state].fr });
	},
);

it('distinguishes a missing row in a measured period from a period without days', () => {
	const evidence = measure().evidence;
	const answer = { cells: [], coverage_note: null, evidence };
	expect(finderShare(undefined, { kind: 'answer', answer }, 'on_time', 'en').text).toBe('Unknown');
	expect(
		finderShare(
			undefined,
			{
				kind: 'answer',
				answer: { ...answer, evidence: { ...evidence, days_included: [] } },
			},
			'on_time',
			'fr',
		).text,
	).toBe('Non mesuré');
});

it('exports raw readings, preserves zero and escapes spreadsheet text', () => {
	const href = finderCsv(
		['Stop', 'Share'],
		[
			['=1+1', 0],
			['Unknown', null],
		],
		'en',
		'demo',
		{ from: '2026-10-17', to: '2026-10-18' },
		[measure().evidence],
	);
	const csv = decodeURIComponent(href.slice(href.indexOf(',') + 1));
	expect(csv).toContain('"\'=1+1",0,"demo","2026-10-17","2026-10-18","punctuality-v2","6"');
	expect(csv).toContain('"Unknown",,"demo"');
});
