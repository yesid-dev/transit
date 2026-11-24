import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import StackedShareMark from './StackedShareMark.svelte';
import type { StackedShareSpec } from '../ChartSpec';

function legendItems(container: HTMLElement): HTMLLIElement[] {
	return [...container.querySelectorAll<HTMLLIElement>('.dv-legend-list li')];
}

describe('StackedShareMark legend', () => {
	it('names each status by its shape as well as its colour', () => {
		const spec: StackedShareSpec = {
			kind: 'stacked-share',
			title: 'Vehicle status',
			locale: 'en',
			scale: 'status',
			legend: true,
			segments: [
				{ key: 'on_time', label: 'On time', share: 60, status: 'on_time' },
				{ key: 'late', label: 'Late', share: 30, status: 'late' },
				{ key: 'early', label: 'Early', share: 10, status: 'early' },
			],
		};
		const { container } = render(StackedShareMark, { props: { spec } });

		const glyphs = legendItems(container).map(
			(item) => item.querySelector('[data-slot="legend-glyph"]')?.textContent,
		);
		expect(glyphs).toEqual(['●', '▲', '▼']);
		const late = legendItems(container)[1]!.querySelector<HTMLElement>(
			'[data-slot="legend-glyph"]',
		)!;
		expect(late.getAttribute('aria-hidden')).toBe('true');
		expect(late.getAttribute('style')).toContain('var(--dataviz-status-late)');
	});

	it('keeps the plain swatch for a scale without shapes', () => {
		const spec: StackedShareSpec = {
			kind: 'stacked-share',
			title: 'Crowding',
			locale: 'en',
			scale: 'occupancy',
			legend: true,
			segments: [{ key: 'empty', label: 'Empty', share: 100, occupancy: 'empty' }],
		};
		const { container } = render(StackedShareMark, { props: { spec } });

		const [item] = legendItems(container);
		expect(item!.querySelector('[data-slot="legend-glyph"]')).toBeNull();
		expect(item!.querySelector('.dv-legend-swatch')).not.toBeNull();
	});
});
