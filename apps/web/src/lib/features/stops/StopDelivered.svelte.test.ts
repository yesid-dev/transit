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

it('gives back the held height once it settles on too few to judge', async () => {
	const tooFew: RecordMeasure = {
		...reading,
		state: 'too_few_to_judge',
		state_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
		value: { trips_run: null },
		evidence: { ...reading.evidence, counts: { scheduled: 1, eligible: 1, ran: 1 } },
	};
	const { container } = render(StopDelivered, {
		locale: 'en',
		stamp: { kind: 'record', label: '19 Nov' },
		answer: Promise.resolve({ kind: 'answer' as const, answer: tooFew }),
	});
	const card = within(screen.getByRole('article', { name: 'Trips that ran at this stop' }));
	expect(await card.findByText('Too few to judge')).toBeVisible();
	const body = container.querySelector<HTMLElement>('[data-slot="record-card-body"]');
	expect(body?.style.minBlockSize).toBe('');
	expect(container.querySelector('[data-settled-empty]')).not.toBeNull();
});
