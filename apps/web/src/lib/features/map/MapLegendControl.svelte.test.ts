import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MapLegendControl from './MapLegendControl.svelte';
import { copy } from './map.copy';

const legend = { colourBy: 'status', staleCutoffS: 150 } as const;

afterEach(() => {
	vi.useRealTimers();
	localStorage.clear();
});
describe('MapLegendControl', () => {
	it('lets the trigger click close its sheet after a held pointerdown, without reopening', async () => {
		(
			window as typeof window & { happyDOM: { setInnerWidth: (width: number) => void } }
		).happyDOM.setInnerWidth(390);
		render(MapLegendControl, { locale: 'en', presentation: 'phone', ...legend });
		const button = screen.getByRole('button', { name: 'Legend' });
		await fireEvent.click(button);
		const dialog = screen.getByRole('dialog', { name: 'Legend' });
		await waitFor(() => expect(dialog).toHaveFocus());
		// A held gesture lets the Sheet's outside-pointer dispatcher settle before click.
		// The trigger is outside its content, but this gesture belongs to the toggle.
		vi.useFakeTimers();
		await fireEvent.pointerDown(button, {
			button: 0,
			pointerType: 'mouse',
			clientX: 34,
			clientY: 752,
		});
		await vi.advanceTimersByTimeAsync(30);
		expect(button).toHaveAttribute('aria-expanded', 'true');
		await fireEvent.pointerUp(button, { button: 0, pointerType: 'mouse' });
		await fireEvent.click(button);
		expect(button).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(button);
		await fireEvent.pointerDown(document.body, {
			button: 0,
			pointerType: 'mouse',
			clientX: 1,
			clientY: 1,
		});
		await vi.advanceTimersByTimeAsync(30);
		expect(button).toHaveAttribute('aria-expanded', 'false');
	});

	it.each(['en', 'fr'] as const)(
		'opens and closes the phone legend with focus restored (%s)',
		async (locale) => {
			(
				window as typeof window & { happyDOM: { setInnerWidth: (width: number) => void } }
			).happyDOM.setInnerWidth(390);
			render(MapLegendControl, { locale, presentation: 'phone', ...legend });
			const button = screen.getByRole('button', { name: copy[locale].legend.title });
			expect(button).toHaveAttribute('aria-expanded', 'false');
			await fireEvent.click(button);
			const dialog = screen.getByRole('dialog', { name: copy[locale].legend.title });
			expect(dialog).toHaveAttribute('tabindex', '0');
			await waitFor(() => expect(dialog).toHaveFocus());
			expect(button).toHaveAttribute('aria-expanded', 'true');
			expect(button).toHaveAttribute('aria-controls', dialog.id);
			expect(screen.getByText(copy[locale].headingLead)).toBeVisible();
			await fireEvent.keyDown(dialog, { key: 'Escape' });
			await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
			await waitFor(() => expect(button).toHaveFocus());
			await fireEvent.click(button);
			await fireEvent.click(button);
			expect(button).toHaveAttribute('aria-expanded', 'false');
		},
	);
	it('starts expanded on desktop and remembers collapse across mounts', async () => {
		const view = render(MapLegendControl, { locale: 'en', presentation: 'desktop', ...legend });
		const header = view.getByRole('button', { name: 'Legend' });
		const viewport = view.getByRole('region', { name: 'Legend' });
		expect(viewport).toHaveAttribute('tabindex', '0');
		viewport.focus();
		expect(viewport).toHaveFocus();
		expect(header).toHaveAttribute('aria-expanded', 'true');
		await fireEvent.click(header);
		expect(header).toHaveAttribute('aria-expanded', 'false');
		expect(localStorage.getItem('transit:legend-collapsed')).toBe('true');
		view.unmount();
		const restored = render(MapLegendControl, { locale: 'en', presentation: 'desktop', ...legend });
		await waitFor(() =>
			expect(restored.getByRole('button', { name: 'Legend' })).toHaveAttribute(
				'aria-expanded',
				'false',
			),
		);
	});
});
