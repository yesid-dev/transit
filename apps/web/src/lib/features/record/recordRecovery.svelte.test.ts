import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
import RecordRecoveryNoticeHarness from './RecordRecoveryNoticeHarness.svelte';

const answer = Promise.resolve({ kind: 'answer' } as EngineResult<RecordAnswer>);
const busy = Promise.resolve({ kind: 'busy' } as const);

it('tries once when visible and preserves the answered control and its focus', async () => {
	vi.useFakeTimers();
	const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
	const fetcher = vi.fn(async (_url: string) => Response.json({ Lines: await answer }));
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
		expect(screen.getByRole('status')).toHaveTextContent('These records take longer');
		const days = screen.getByRole('button', { name: 'Days' });
		days.focus();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetcher).not.toHaveBeenCalled();

		visibility.mockReturnValue(false);
		document.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(new URL(fetcher.mock.calls[0][0], location.origin).searchParams.get('sections')).toBe(
			'Lines',
		);
		expect(screen.getByRole('button', { name: 'Days' })).toBe(days);
		expect(days).toHaveFocus();
		expect(screen.getByRole('button', { name: 'Lines' })).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('Readings arrived');
		await rerender({ scope: '/vehicle/102', sections: [{ section: 'Days', answer }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.queryByRole('status')).toBeNull();
	} finally {
		vi.unstubAllGlobals();
		visibility.mockRestore();
		vi.useRealTimers();
	}
});
