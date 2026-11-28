import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import RecordAnswer from './RecordAnswer.svelte';

const actions = createRawSnippet(() => ({
	render: () => '<div role="group" aria-label="Record actions"><button>Copy link</button></div>',
}));
const time = { kind: 'record', label: 'Record · 19 to 25 Nov 2026' } as const;

describe('RecordAnswer', () => {
	for (const [locale, counted] of [
		['en', 'Counted: 59,016 stop arrivals, 7 days'],
		['fr', 'Ce qui est compté\u00a0: 59,016 stop arrivals, 7 days'],
	] as const)
		it(`reads the figure, the stamp, the comparison, what was counted, then the actions (${locale})`, () => {
			const view = render(RecordAnswer, {
				props: {
					locale,
					value: '72.6%',
					sentence: 'of recorded stop arrivals on this line were on time.',
					time,
					comparison: '5.4 points below the network.',
					evidence: { sample: '59,016 stop arrivals, 7 days' },
					actions,
				},
			});
			// The no-break space before the French colon reads as a space here.
			const flat = (value: string) => value.replace(/\s+/g, ' ');
			const text = flat(view.container.textContent!);
			const order = [
				'72.6%',
				'were on time.',
				'Record · 19 to 25 Nov 2026',
				'5.4 points below the network.',
				counted,
				'Copy link',
			].map((part) => text.indexOf(flat(part)));
			expect(order).not.toContain(-1);
			expect(order).toEqual([...order].sort((a, b) => a - b));
			const evidence = view.container.querySelector('[data-slot="answer-evidence"]')!;
			expect(flat(evidence.textContent!)).toContain(flat(counted));
			const grid = view.container.querySelector('.answer-grid')!;
			expect(grid.classList).toContain('aside');
			expect(grid.classList).not.toContain('one-row');
		});

	it('keeps a Live answer with only a stamp to one row', () => {
		const view = render(RecordAnswer, {
			props: {
				locale: 'en',
				value: '1',
				sentence: 'vehicle is reporting now.',
				time: { kind: 'live', label: 'Live · updated now' },
			},
		});
		const grid = view.container.querySelector('.answer-grid')!;
		expect(grid.classList).toContain('aside');
		expect(grid.classList).toContain('one-row');
		expect(view.container.querySelector('[data-slot="answer-evidence"]')).toBeNull();
	});

	it('keeps a stamp without actions on the context line when more context follows', () => {
		const view = render(RecordAnswer, {
			props: {
				locale: 'en',
				value: '65.0%',
				sentence: 'of scheduled stop arrivals have a reading.',
				time,
				evidence: { sample: '2 of 4 scheduled stop arrivals, 7 days' },
			},
		});
		expect(view.container.querySelector('.answer-grid')!.classList).not.toContain('aside');
		expect(view.getByText('Counted: 2 of 4 scheduled stop arrivals, 7 days')).toBeTruthy();
	});
});
