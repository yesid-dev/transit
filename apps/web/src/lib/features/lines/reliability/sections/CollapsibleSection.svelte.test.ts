import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Harness from './__fixtures__/CollapsibleSectionSectionsHarness.svelte';

function sectionToggle(container: HTMLElement, dataSection = 'when-to-ride'): HTMLButtonElement {
	const toggle = container.querySelector<HTMLButtonElement>(
		`[data-section="${dataSection}"] [data-section-trigger]`,
	);
	if (!toggle) throw new Error('Reliability section toggle did not render');
	return toggle;
}

describe('line evidence sections', () => {
	it('names each section once and keeps its finding visible when closed', async () => {
		const { container } = render(Harness);
		const section = container.querySelector('[data-section="when-to-ride"]')!;
		const toggle = sectionToggle(container);
		const summary = section.querySelector('[data-slot="section-summary"]');

		expect(toggle).toHaveAccessibleName('By time of day');
		expect(toggle.querySelector('[data-slot="badge"]')).toBeNull();
		expect(summary).toHaveTextContent('Between 87% and 91% by period of the day.');

		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(section.querySelector('[data-slot="section-summary"]')).toBeVisible();
		// Only the heading toggles: the summary is text, not a second control.
		await fireEvent.click(section.querySelector('[data-slot="section-summary"]')!);
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
	});
});
