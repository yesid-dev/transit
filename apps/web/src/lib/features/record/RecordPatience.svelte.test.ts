import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import RecordPatienceHarness from './RecordPatienceHarness.svelte';

it.each([
	['answer', 'Answered'],
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
