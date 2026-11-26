import { render, screen, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { expect, it, vi } from 'vitest';
import FrameControls from './FrameControls.svelte';
import { frameControlsState, frameCopy } from './frameControlsState';
import { frameClock } from '#lib/site/frameState.ts';

it('keeps the shared view and period cards when no screen controls are registered', async () => {
	const url = new URL('https://transit.example/');
	const clock = frameClock(null, new Date('2026-11-25T12:00:00Z'));
	const { rerender } = render(FrameControls, {
		props: {
			locale: 'en',
			url,
			clock,
			frame: frameControlsState(url, clock),
			context: { presentation: 'desktop', closeSheet: vi.fn() },
		},
	});
	const view = screen.getByRole('group', { name: 'View' });
	const period = screen.getByRole('group', { name: 'Period' });
	const before = [view, period].map((card) => card.innerHTML);
	await rerender({
		extension: { between: createRawSnippet(() => ({ render: () => '<p>Layer</p>' })) },
	});
	expect(within(screen.getByRole('group', { name: 'View' })).getByText('Layer')).toBeVisible();
	expect(screen.queryByRole('group', { name: 'Period' })).toBeNull();
	await rerender({ extension: undefined });
	const after = ['View', 'Period'].map((name) => screen.getByRole('group', { name }).innerHTML);
	expect(after.map(stripIds)).toEqual(before.map(stripIds));
});

function stripIds(markup: string) {
	return markup.replace(/(?:id|aria-controls)="[^"]*"/g, '');
}

it.each(['en', 'fr'] as const)('renders one selected View hint in %s', async (locale) => {
	const clock = frameClock(null, new Date('2026-11-25T12:00:00Z'));
	const live = new URL('https://transit.example/vehicles?frameMode=live');
	const record = new URL('https://transit.example/vehicles?frameMode=record');
	const copy = frameCopy[locale];
	const { rerender } = render(FrameControls, {
		props: {
			locale,
			clock,
			url: live,
			frame: frameControlsState(live, clock),
			context: { presentation: 'desktop', closeSheet: vi.fn() },
		},
	});
	const view = within(screen.getByRole('group', { name: copy.view }));
	expect(view.getAllByText(copy.viewHint.live, { exact: true })).toHaveLength(1);
	expect(view.queryByText(copy.viewHint.record, { exact: true })).toBeNull();
	await rerender({ url: record, frame: frameControlsState(record, clock) });
	expect(view.getAllByText(copy.viewHint.record, { exact: true })).toHaveLength(1);
	expect(view.queryByText(copy.viewHint.live, { exact: true })).toBeNull();
});
