import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
import RecordRecoveryNoticeHarness from './RecordRecoveryNoticeHarness.svelte';

type Navigation = { from: { url: URL }; to: { url: URL }; complete: Promise<void> };
const navigation = vi.hoisted(() => ({ listeners: new Set<(navigation: Navigation) => void>() }));
vi.mock('$app/navigation', () => ({
	beforeNavigate: (listener: (navigation: Navigation) => void) => {
		navigation.listeners.add(listener);
	},
}));

/** A screen's own "Try again": it reloads the page's data in place. */
function reloadPage() {
	const done = Promise.withResolvers<void>();
	const url = new URL('/vehicle/101', location.origin);
	for (const listener of navigation.listeners)
		listener({ from: { url }, to: { url }, complete: done.promise });
	return done.resolve;
}

const answer = Promise.resolve({ kind: 'answer' } as EngineResult<RecordAnswer>);
const busy = Promise.resolve({ kind: 'busy' } as const);
const asked = (fetcher: { mock: { calls: [string][] } }) =>
	fetcher.mock.calls.map(([url]) => new URL(url, location.origin).searchParams.get('readings'));

it.each([
	[
		'en',
		'Waiting for a turn. This card asks again in a few seconds.',
		'The record is temporarily unavailable.',
		'Try again',
	],
	[
		'fr',
		'En attente. Cette carte redemande dans quelques secondes.',
		'Le bilan est temporairement indisponible.',
		'Réessayer',
	],
] as const)(
	'asks again after 5 s, then 15 s, then offers one Try again for the screen in %s',
	async (locale, pending, unavailable, retry) => {
		vi.useFakeTimers();
		const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		const fetcher = vi.fn(async (_url: string) => Response.json({}));
		fetcher.mockResolvedValueOnce(Response.json({ 'sections.Days': await answer }));
		vi.stubGlobal('fetch', fetcher);
		try {
			render(RecordRecoveryNoticeHarness, {
				scope: '/vehicle/101',
				locale,
				sections: [
					{ section: 'Days', answer: busy },
					{ section: 'Lines', answer: busy },
				],
			});
			await vi.advanceTimersByTimeAsync(4_999);
			expect(fetcher).not.toHaveBeenCalled();
			expect(screen.getAllByText(pending)).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(asked(fetcher)).toEqual(['sections.Days,sections.Lines']);
			const days = screen.getByRole('button', { name: 'Days' });
			expect(screen.getAllByText(pending)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(14_999);
			expect(fetcher).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(asked(fetcher)).toEqual(['sections.Days,sections.Lines', 'sections.Lines']);
			// The honest end state: the card says so once, the screen offers one Try again.
			expect(screen.getAllByText(unavailable)).toHaveLength(2);
			expect(screen.queryByText(pending)).toBeNull();
			expect(screen.getAllByRole('button', { name: retry })).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(fetcher).toHaveBeenCalledTimes(2);

			fetcher.mockResolvedValueOnce(Response.json({ 'sections.Lines': await answer }));
			screen.getByRole('button', { name: retry }).click();
			await vi.advanceTimersByTimeAsync(1);
			expect(asked(fetcher).at(-1)).toBe('sections.Lines');
			expect(screen.getByRole('button', { name: 'Days' })).toBe(days);
			expect(screen.getByRole('button', { name: 'Lines' })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: retry })).toBeNull();
			expect(screen.queryByText(unavailable)).toBeNull();
		} finally {
			vi.unstubAllGlobals();
			visibility.mockRestore();
			vi.useRealTimers();
		}
	},
);

it('waits while the page is hidden and preserves the answered control and its focus', async () => {
	vi.useFakeTimers();
	const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
	const fetcher = vi.fn(async (_url: string) => Response.json({ 'sections.Lines': await answer }));
	vi.stubGlobal('fetch', fetcher);
	try {
		const scope = '/vehicle/101';
		const { container, rerender } = render(RecordRecoveryNoticeHarness, {
			scope,
			sections: [
				{ section: 'Days', answer },
				{ section: 'Lines', answer: busy },
			],
		});
		await vi.advanceTimersByTimeAsync(0);
		// The screen-wide notice is for screen readers only, so it never moves the screen title.
		const notice = container.querySelector<HTMLElement>('[data-slot="record-patience"]')!;
		expect(notice).toHaveClass('sr-only');
		expect(screen.getByRole('status')).toHaveTextContent('Still calculating the record');
		const days = screen.getByRole('button', { name: 'Days' });
		days.focus();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetcher).not.toHaveBeenCalled();

		visibility.mockReturnValue(false);
		document.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(asked(fetcher)).toEqual(['sections.Lines']);
		expect(new URL(fetcher.mock.calls[0][0], location.origin).searchParams.get('screen')).toBe(
			'vehicle',
		);
		expect(screen.getByRole('button', { name: 'Days' })).toBe(days);
		expect(days).toHaveFocus();
		expect(screen.getByRole('button', { name: 'Lines' })).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('The record is on screen.');
		await rerender({ scope: '/vehicle/102', sections: [{ section: 'Days', answer }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.queryByRole('status')).toBeNull();
	} finally {
		vi.unstubAllGlobals();
		visibility.mockRestore();
		vi.useRealTimers();
	}
});

it('a manual retry while an automatic re-ask is pending sends one request', async () => {
	vi.useFakeTimers();
	navigation.listeners.clear();
	const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
	const fetcher = vi.fn(async (_url: string) => Response.json({}));
	vi.stubGlobal('fetch', fetcher);
	try {
		const { rerender } = render(RecordRecoveryNoticeHarness, {
			scope: '/vehicle/101',
			sections: [{ section: 'Lines', answer: busy }],
		});
		await vi.advanceTimersByTimeAsync(4_000);
		// The rider presses the screen's own Try again: the page asks for its data once.
		const finished = reloadPage();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetcher).not.toHaveBeenCalled();
		await rerender({
			scope: '/vehicle/101',
			sections: [{ section: 'Lines', answer: Promise.resolve({ kind: 'busy' } as const) }],
		});
		finished();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(fetcher).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(asked(fetcher)).toEqual(['sections.Lines']);
	} finally {
		vi.unstubAllGlobals();
		visibility.mockRestore();
		vi.useRealTimers();
	}
});

it('a manual retry cancels an automatic re-ask already in flight', async () => {
	vi.useFakeTimers();
	navigation.listeners.clear();
	const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
	const signals: AbortSignal[] = [];
	const fetcher = vi.fn(
		(_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				signals.push(init!.signal!);
				init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
			}),
	);
	vi.stubGlobal('fetch', fetcher);
	try {
		render(RecordRecoveryNoticeHarness, {
			scope: '/vehicle/101',
			sections: [{ section: 'Lines', answer: busy }],
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const finished = reloadPage();
		expect(signals[0].aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetcher).toHaveBeenCalledTimes(1);
		finished();
		await vi.advanceTimersByTimeAsync(5_000);
		// The same readings, kept by the navigation: their steps start again, one request.
		expect(fetcher).toHaveBeenCalledTimes(2);
	} finally {
		vi.unstubAllGlobals();
		visibility.mockRestore();
		vi.useRealTimers();
	}
});
