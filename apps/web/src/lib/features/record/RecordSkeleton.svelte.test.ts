import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import RecordCard from './RecordCard.svelte';
import RecordGroup from './RecordGroup.svelte';
import RecordPending from './RecordPending.svelte';
import RecordSkeleton from './RecordSkeleton.svelte';
import RecordSkeletonHarness, { harnessShapes } from './RecordSkeletonHarness.svelte';
import type { RecordWaiting } from './recordWaiting.ts';

afterEach(() => vi.useRealTimers());

const empty = createRawSnippet(() => ({ render: () => '<span></span>' }));

const shapes: [string, RecordWaiting, number][] = [
	// One evidence line under an answer: versions never show on screen.
	['answer', 'answer', 7],
	['answer with its comparison line', { shape: 'answer', comparison: true }, 8],
	['reading', 'reading', 5],
	['facts', 'facts', 6],
	['facts (4)', { shape: 'facts', count: 4 }, 8],
	// The Daily report trips card: six rows, a label and a value each.
	['trip-facts', 'trip-facts', 12],
	['bands', 'bands', 9],
	['band-comparison', 'band-comparison', 18],
	['comparison-facts', 'comparison-facts', 6],
	['trend', 'trend', 2],
	['table', 'table', 10],
	['table (7 rows)', { shape: 'table', rows: 7 }, 16],
	['card', 'card', 3],
	['listing', 'listing', 36],
	['line', 'line', 1],
	['rows (8, two lines, plate)', 'rows', 34],
	['rows (3, one line, no header)', { shape: 'rows', count: 3, lines: 1, header: false }, 9],
	['rows (5, no lead)', { shape: 'rows', count: 5, lead: 'none' }, 17],
	['grid', 'grid', 17],
	['histogram', 'histogram', 6],
	// 47 stops wait as 12 rows on the rail and the "Show all" button.
	['ladder (47)', { shape: 'ladder', count: 47 }, 38],
	['ladder (6)', { shape: 'ladder', count: 6 }, 19],
	['notice (2)', { shape: 'notice', count: 2 }, 12],
	['tiles (4)', { shape: 'tiles', count: 4 }, 8],
];

it.each(shapes)('draws the %s shape hidden, pulsing and silent', (_, shape, placeholders) => {
	const { container } = render(RecordPending, { locale: 'en', shape });
	const pending = container.querySelector('[data-record-pending]');
	const reservation = container.querySelector('[data-waiting-shape]');
	expect(pending).toHaveAttribute('aria-busy', 'true');
	expect(reservation).toHaveAttribute('aria-hidden', 'true');
	// The kit pulses a Skeleton under any aria-busy="true" ancestor.
	expect(reservation).toHaveAttribute('aria-busy', 'true');
	expect(reservation?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(placeholders);
	// Before 3 s the shape alone speaks.
	expect(screen.getByRole('status')).toHaveTextContent(/^$/);
});

it.each([
	[{ shape: 'facts', count: 4 } as const, '11rem'],
	[{ shape: 'table', rows: 7 } as const, '21.25rem'],
	[{ shape: 'rows', count: 20 } as const, '78.25rem'],
	['grid' as const, '20.8125rem'],
	[{ shape: 'ladder', count: 47 } as const, '38.75rem'],
])('holds the rule height of %j on the shape itself', (shape, size) => {
	const { container } = render(RecordSkeleton, { shape });
	expect(container.querySelector<HTMLElement>('[data-waiting-shape]')?.style.blockSize).toBe(size);
});

it('keeps an answer at the height of its layout', () => {
	const { container } = render(RecordSkeleton, { shape: 'answer' });
	expect(container.querySelector<HTMLElement>('[data-waiting-shape]')?.style.blockSize).toBe('');
});

it.each([
	['en', 'Still calculating…'],
	['fr', 'Calcul toujours en cours…'],
] as const)('says it is still calculating after 3 s, in %s', async (locale, words) => {
	vi.useFakeTimers();
	render(RecordPending, { locale, shape: 'facts' });
	await vi.advanceTimersByTimeAsync(2_999);
	expect(screen.getByRole('status')).toHaveTextContent(/^$/);
	await vi.advanceTimersByTimeAsync(1);
	expect(screen.getByRole('status')).toHaveTextContent(words);
});

it.each([
	['en', 'Waiting for a turn. This card asks again in a few seconds.'],
	['fr', 'En attente. Cette carte redemande dans quelques secondes.'],
] as const)('keeps the skeleton when the engine is busy, in %s', (locale, words) => {
	const { container } = render(RecordPending, { locale, shape: 'answer', busy: true });
	const busy = container.querySelector('[data-record-busy]');
	expect(busy).toHaveAttribute('aria-busy', 'true');
	expect(busy?.querySelector('[data-waiting-shape="answer"]')).not.toBeNull();
	// A busy card is not counted as still loading.
	expect(container.querySelector('[data-record-pending]')).toBeNull();
	expect(screen.getByRole('status')).toHaveTextContent(words);
});

it('keeps the words in their own line under the shape, never over a bar', async () => {
	vi.useFakeTimers();
	const { container } = render(RecordPending, { locale: 'en', shape: 'grid' });
	const pending = container.querySelector('[data-record-pending]');
	const foot = pending?.lastElementChild;
	// The foot line is there from the first frame, empty, so nothing moves at 3 s.
	expect(foot).toHaveAttribute('data-slot', 'record-pending-words');
	expect(foot?.previousElementSibling).toHaveAttribute('data-waiting-shape', 'grid');
	expect(foot).toBeEmptyDOMElement();
	await vi.advanceTimersByTimeAsync(3_000);
	expect(foot).toHaveTextContent('Still calculating…');
	expect(foot?.querySelector('[data-slot="skeleton"]')).toBeNull();
});

it('pulses one text line without a shape, then shows the words in its place', async () => {
	vi.useFakeTimers();
	const { container } = render(RecordPending, { locale: 'fr' });
	const foot = container.querySelector('[data-slot="record-pending-words"]');
	expect(container.querySelector('[data-waiting-shape]')).toBeNull();
	expect(foot?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
	expect(foot?.closest('[aria-busy="true"]')).not.toBeNull();
	await vi.advanceTimersByTimeAsync(3_000);
	expect(foot).toHaveTextContent('Calcul toujours en cours…');
	expect(foot?.querySelector('[data-slot="skeleton"]')).toBeNull();
});

it('draws the card shell with its title while the body waits', () => {
	const { container } = render(RecordCard, {
		title: 'Crowding',
		stamp: { kind: 'record', label: '19 to 25 Nov 2026' },
		waiting: { shape: 'table', rows: 6 },
		children: empty,
	});
	expect(screen.getByRole('heading', { name: 'Crowding' })).toBeVisible();
	const body = container.querySelector('[data-slot="record-card-body"]');
	expect(body).toHaveAttribute('aria-busy', 'true');
	expect(body?.querySelector('[data-waiting-shape="table"]')).toHaveAttribute(
		'data-waiting-count',
		'6',
	);
});

it('keeps the reserved height for a card that ends in a short state', () => {
	const { container } = render(RecordCard, {
		title: 'Departures late most often',
		reserve: { shape: 'rows', count: 8 },
		children: empty,
	});
	const body = container.querySelector<HTMLElement>('[data-slot="record-card-body"]');
	expect(body).not.toHaveAttribute('aria-busy');
	expect(body?.style.minBlockSize).toBe('32.5rem');
});

it('marks a waiting group busy', () => {
	const { container } = render(RecordGroup, { waiting: 'answer', children: empty });
	expect(container.querySelector('[data-record-pending]')).toHaveAttribute('aria-busy', 'true');
});

it('shows every shape on the harness', () => {
	const { container } = render(RecordSkeletonHarness, { locale: 'fr' });
	for (const { label } of harnessShapes) {
		expect(
			container.querySelector(`[data-harness-shape="${label}"] [data-waiting-shape]`),
		).not.toBeNull();
	}
	expect(container.querySelectorAll('[data-waiting-shape="tiles"]')).toHaveLength(2);
	expect(
		screen.getByText('En attente. Cette carte redemande dans quelques secondes.'),
	).toBeVisible();
});
