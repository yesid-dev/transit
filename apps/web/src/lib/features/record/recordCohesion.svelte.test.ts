import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { expect, it } from 'vitest';
import RecordCard from './RecordCard.svelte';
import RecordCohesionHarness from './RecordCohesionHarness.svelte';

it('reserves hand-drawn strokes for section boundaries and uses hairlines inside cards', () => {
	const { container } = render(RecordCohesionHarness);
	const page = container.querySelector('[data-record-screen]')!;
	expect(page.querySelectorAll('[data-slot="page-section-boundary"]')).toHaveLength(2);
	expect(page.lastElementChild).toHaveAttribute('data-slot', 'page-section');
	const link = screen.getByRole('link', { name: 'Network record' });
	const card = link.closest('[data-slot="card"]')!;
	expect(card).toHaveAttribute('data-interactive', 'true');
	expect(card.querySelector('.hand-drawn-line')).toBeNull();
	expect(card.querySelectorAll('footer > [data-slot="separator"]')).toHaveLength(1);
	expect(
		[...card.querySelectorAll('footer > [data-slot^="record-foot-"]')].map((slot) =>
			slot.getAttribute('data-slot'),
		),
	).toEqual(['record-foot-links', 'record-foot-evidence', 'record-foot-toggle']);
	expect(card.querySelectorAll('[data-slot="fact-row"] [data-slot="separator"]')).toHaveLength(2);
	const about = screen.getByRole('article', { name: 'About these figures' });
	expect(about.closest('[data-slot="card"]')).not.toHaveAttribute('data-interactive');
	expect(about.querySelector('.hand-drawn-line')).toBeNull();
});

it('keeps the disclosure fragment and exposes state on its trigger', async () => {
	const { container } = render(RecordCard, {
		title: 'Measure',
		disclosure: { id: 'measure', description: 'Counted on weekdays' },
		children: createRawSnippet(() => ({ render: () => '<p>More information</p>' })),
	});
	const trigger = screen.getByRole('button', { name: 'Measure Counted on weekdays' });
	expect(trigger).toHaveAttribute('aria-expanded', 'false');
	expect(container.querySelector('#measure')).toHaveAttribute('data-open', 'false');
	await fireEvent.click(trigger);
	expect(trigger).toHaveAttribute('aria-expanded', 'true');
	expect(container.querySelector('#measure')).toHaveAttribute('data-open', 'true');
});
