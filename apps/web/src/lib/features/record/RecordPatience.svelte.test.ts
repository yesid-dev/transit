import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import RecordPatienceHarness from './RecordPatienceHarness.svelte';

it.each([
	['answer', 'The record is on screen.'],
	['unreachable', null],
] as const)('shows a single slow notice and handles a final %s', async (kind, completion) => {
	vi.useFakeTimers();
	try {
		const first = Promise.withResolvers<{ kind: string }>();
		const second = Promise.withResolvers<{ kind: string }>();
		render(RecordPatienceHarness, { readings: [first.promise, second.promise] });
		// One region for the screen: loading at once, still calculating after 3 s.
		expect(screen.getByRole('status')).toHaveTextContent(
			'Loading the record for 8 to 14 Nov 2026.',
		);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(screen.getByRole('status')).toHaveTextContent(
			'Still calculating the record for 8 to 14 Nov 2026. Each card fills in when its answer arrives.',
		);
		first.resolve({ kind: 'answer' });
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByRole('status')).toHaveTextContent('Still calculating the record');
		second.resolve({ kind });
		await vi.advanceTimersByTimeAsync(0);
		if (completion) expect(screen.getByRole('status')).toHaveTextContent(completion);
		else expect(screen.queryByRole('status')).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

it.each([
	[
		'en',
		'Waiting for a turn. This card asks again in a few seconds.',
		'Still calculating the record',
	],
	['fr', 'En attente. Cette carte redemande dans quelques secondes.', 'Le calcul du bilan'],
] as const)('renders one busy notice and a pending line in %s', async (locale, pending, notice) => {
	render(RecordPatienceHarness, { locale, readings: [Promise.resolve({ kind: 'busy' })] });
	expect(await screen.findByText(pending)).toBeVisible();
	expect(screen.getByRole('status')).toHaveTextContent(notice);
	expect(screen.getAllByText(pending)).toHaveLength(1);
});

it.each([
	['en', 'Still calculating…'],
	['fr', 'Calcul toujours en cours…'],
] as const)(
	'says it is still calculating in each waiting card, and keeps the notice out of the layout, in %s',
	async (locale, still) => {
		vi.useFakeTimers();
		try {
			const pending = Promise.withResolvers<{ kind: string }>();
			const { container } = render(RecordPatienceHarness, {
				locale,
				readings: [pending.promise],
			});
			expect(container.querySelector('[data-record-pending][aria-busy="true"]')).not.toBeNull();
			expect(screen.queryByText(still)).toBeNull();
			await vi.advanceTimersByTimeAsync(3_000);
			expect(screen.getByText(still)).toBeInTheDocument();
			expect(container.querySelector('[data-slot="record-patience"]')).toHaveClass('sr-only');
			expect(screen.getByRole('status')).toHaveTextContent(
				locale === 'fr'
					? 'Le calcul du bilan du 8 au 14 nov. 2026 se poursuit.'
					: 'Still calculating the record for 8 to 14 Nov 2026.',
			);
		} finally {
			vi.useRealTimers();
		}
	},
);
