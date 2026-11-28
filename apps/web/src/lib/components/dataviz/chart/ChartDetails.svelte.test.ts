import { fireEvent, render } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import ChartDetailsPairHarness from './ChartDetailsPairHarness.svelte';

const frames = () =>
	new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const openTips = () =>
	[...document.querySelectorAll('[role="tooltip"]')].filter(
		(tip) => tip.getAttribute('aria-hidden') === 'false',
	);

it('keeps one chart tooltip open at a time and closes it when the reader scrolls', async () => {
	const view = render(ChartDetailsPairHarness);
	const [upper, lower] = view.getAllByRole('group');

	await fireEvent.keyDown(upper, { key: 'ArrowRight' });
	expect(openTips().map((tip) => tip.textContent)).toEqual([expect.stringContaining('Upper 0')]);

	await fireEvent.keyDown(lower, { key: 'ArrowRight' });
	expect(openTips().map((tip) => tip.textContent)).toEqual([expect.stringContaining('Lower 0')]);

	// The keyboard step's own scroll into view keeps the tooltip.
	await fireEvent.scroll(document);
	expect(openTips()).toHaveLength(1);

	await frames();
	await fireEvent.scroll(document);
	expect(openTips()).toHaveLength(0);
});
