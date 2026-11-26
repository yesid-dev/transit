import { render, screen } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import RecordPending from './RecordPending.svelte';
import type { RecordWaitingShape } from './RecordSkeleton.svelte';

const shapes: [RecordWaitingShape, number][] = [
	// One evidence line under an answer: versions never show on screen.
	['answer', 7],
	['reading', 5],
	['facts', 6],
	['bands', 7],
	['band-comparison', 18],
	['comparison-facts', 6],
	['trend', 2],
	['table', 9],
	['card', 3],
	['listing', 19],
];

it.each(shapes)('shows the %s reservation with one spoken waiting state', (shape, placeholders) => {
	const { container } = render(RecordPending, { locale: 'en', shape });
	const reservation = container.querySelector('[data-waiting-shape]');
	expect(reservation).toHaveAttribute('aria-hidden', 'true');
	expect(reservation?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(placeholders);
	expect(screen.getByRole('status')).toHaveTextContent('Calculating…');
});

it('releases the reservation when the reader is waiting for a slot', async () => {
	const { container, rerender } = render(RecordPending, { locale: 'fr', shape: 'answer' });
	await rerender({ locale: 'fr', shape: 'answer', busy: true });
	expect(container.querySelector('[data-record-pending]')).toBeNull();
	expect(screen.getByRole('status')).toHaveTextContent('Lecture en attente.');
});
