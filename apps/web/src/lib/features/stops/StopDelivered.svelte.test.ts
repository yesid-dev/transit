import { render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { RecordMeasure } from '#lib/server/engine.ts';
import StopDelivered from './StopDelivered.svelte';

const reading: RecordMeasure = {
	state: 'measured',
	state_text: { en: 'Measured', fr: 'Mesuré' },
	value: { trips_run: 0.98 },
	coverage_note: null,
	evidence: {
		start_date: '2026-11-19',
		end_date: '2026-11-19',
		days_measured: ['2026-11-19'],
		days_included: ['2026-11-19'],
		days_not_measured: [],
		method_version: 'test',
		cleaning_versions: [1],
		query_ms: 0,
		counts: { scheduled: 210, eligible: 200, ran: 196, cancelled: 3, missing: 1 },
		excluded: { added: 4, capture_gap: 7, unconfirmed: 3 },
	},
};

it.each([
	[
		'en',
		'Trips that ran at this stop',
		'98.0%',
		'196 of the 200 trips with a known status',
		/10 more trips.*93.3% and 98.1%/u,
	],
	[
		'fr',
		'Trajets effectués à cet arrêt',
		/98,0\s%/u,
		'196 des 200 trajets à l’état connu',
		/10 autres trajets.*93,3\s% et 98,1\s%/u,
	],
] as const)(
	'presents the known-status share and all unsettled trips in %s',
	async (locale, heading, share, sample, range) => {
		render(StopDelivered, {
			locale,
			stamp: { kind: 'record', label: '19 Nov' },
			answer: Promise.resolve({ kind: 'answer' as const, answer: reading }),
		});
		const card = within(screen.getByRole('article', { name: heading }));
		expect(await card.findByText(share)).toBeVisible();
		expect(card.getByText(sample)).toBeVisible();
		expect(card.getByText(range)).toBeVisible();
	},
);
