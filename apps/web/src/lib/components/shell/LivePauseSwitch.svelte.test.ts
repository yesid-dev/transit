import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { livePause } from '#lib/live/livePause.svelte.ts';
import LivePauseSwitch from './LivePauseSwitch.svelte';

afterEach(() => {
	livePause.reset();
	sessionStorage.clear();
});

it.each([
	['en', 'Pause live updates', 'Live updates paused.', 'Live updates resumed.'],
	[
		'fr',
		'Suspendre les mises à jour',
		'Mises à jour en direct suspendues.',
		'Mises à jour en direct reprises.',
	],
] as const)(
	'is one keyboard switch with a constant name that announces its state politely, in %s',
	async (locale, name, paused, resumed) => {
		render(LivePauseSwitch, { locale });
		const toggle = screen.getByRole('switch', { name });
		const status = screen.getByRole('status');
		expect(status).toHaveAttribute('aria-live', 'polite');
		expect(toggle).toHaveAttribute('aria-checked', 'false');
		expect(toggle.tagName).toBe('BUTTON');
		expect(status).toHaveTextContent('');
		// A native button: Space and Enter press it, so a click is what the keyboard sends.
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('switch', { name })).toBe(toggle);
		expect(status).toHaveTextContent(paused);
		expect(livePause.paused).toBe(true);
		expect(sessionStorage.getItem('transit:live-updates-paused')).toBe('1');
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-checked', 'false');
		expect(status).toHaveTextContent(resumed);
		expect(sessionStorage.getItem('transit:live-updates-paused')).toBeNull();
	},
);

it('restores the tab’s choice after hydration, so moving between Live screens keeps it', async () => {
	sessionStorage.setItem('transit:live-updates-paused', '1');
	render(LivePauseSwitch, { locale: 'en' });
	await vi.waitFor(() =>
		expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'),
	);
	// Restoring is silent: only the visitor's own press is announced.
	expect(screen.getByRole('status')).toHaveTextContent('');
});

it('still works for the page in view when storage is blocked', async () => {
	const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('blocked');
	});
	try {
		render(LivePauseSwitch, { locale: 'en' });
		await fireEvent.click(screen.getByRole('switch'));
		expect(livePause.paused).toBe(true);
	} finally {
		blocked.mockRestore();
	}
});
