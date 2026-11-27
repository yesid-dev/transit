import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import FrameControls from './FrameControls.svelte';
import { frameControlsState, frameCopy } from './frameControlsState';
import { frameClock } from '#lib/site/frameState.ts';

afterEach(() => vi.restoreAllMocks());

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

it.each([
	['en', false, 'Period', 'Close controls'],
	['en', true, 'Choose dates', 'Close'],
	['fr', false, 'Période', 'Fermer les options'],
	['fr', true, 'Choisir des dates', 'Fermer'],
] as const)('names the %s custom date picker (window: %s)', async (locale, wide, title, close) => {
	vi.spyOn(window, 'matchMedia').mockImplementation(
		(query) =>
			Object.assign(new EventTarget(), {
				matches: wide && query === '(min-width: 768px)',
			}) as MediaQueryList,
	);
	const url = new URL('https://transit.example/?frameMode=record');
	const clock = frameClock(null, new Date('2026-11-25T12:00:00Z'));
	render(FrameControls, {
		props: {
			locale,
			url,
			clock,
			frame: frameControlsState(url, clock),
			context: { presentation: 'desktop', closeSheet: vi.fn() },
		},
	});
	await fireEvent.click(screen.getByRole('button', { name: frameCopy[locale].custom }));
	const dialog = await screen.findByRole('dialog', { name: title });
	expect(within(dialog).getAllByRole('button', { name: close })).toHaveLength(wide ? 2 : 1);
});
