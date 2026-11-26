import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import RecordPatienceHarness from './RecordPatienceHarness.svelte';

it.each([
	['answer', 'Readings arrived'],
	['unreachable', null],
] as const)('shows a single slow notice and handles a final %s', async (kind, completion) => {
	vi.useFakeTimers();
	try {
		const first = Promise.withResolvers<{ kind: string }>();
		const second = Promise.withResolvers<{ kind: string }>();
		render(RecordPatienceHarness, { readings: [first.promise, second.promise] });
		expect(screen.queryByRole('status')).toBeNull();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(screen.getByRole('status')).toHaveTextContent(
			'Reading the record for 8 to 14 Nov 2026.',
		);
		first.resolve({ kind: 'answer' });
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByRole('status')).toHaveTextContent('These records take longer');
		second.resolve({ kind });
		await vi.advanceTimersByTimeAsync(0);
		if (completion) expect(screen.getByRole('status')).toHaveTextContent(completion);
		else expect(screen.queryByRole('status')).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

it.each([
	['en', 'Waiting for a reading.', 'These records take longer'],
	['fr', 'Lecture en attente.', 'Ce bilan demande plus de temps'],
] as const)('renders one busy notice and a pending line in %s', async (locale, pending, notice) => {
	render(RecordPatienceHarness, { locale, readings: [Promise.resolve({ kind: 'busy' })] });
	expect(await screen.findByText(pending)).toBeVisible();
	expect(screen.getByRole('status')).toHaveTextContent(notice);
	expect(screen.getAllByText(pending)).toHaveLength(1);
});

it.each([
	['en', 'Calculating…', 'Still calculating the record for 8 to 14 Nov 2026.'],
	[
		'fr',
		'Calcul en cours…',
		'Le calcul du bilan pour la période du 8 au 14 nov. 2026 se poursuit.',
	],
] as const)(
	'says it is still calculating in each waiting card, and keeps the notice out of the layout, in %s',
	async (locale, calculating, still) => {
		vi.useFakeTimers();
		try {
			const pending = Promise.withResolvers<{ kind: string }>();
			const { container } = render(RecordPatienceHarness, {
				locale,
				readings: [pending.promise],
			});
			expect(screen.getByText(calculating)).toBeInTheDocument();
			await vi.advanceTimersByTimeAsync(3_000);
			expect(screen.getByText(still)).toBeInTheDocument();
			expect(container.querySelector('[data-slot="record-patience"]')).toHaveClass('sr-only');
		} finally {
			vi.useRealTimers();
		}
	},
);
