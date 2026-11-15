import { render, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { OCCUPANCY_GLYPH, STATUS_GLYPH } from '#lib/components/dataviz/tokens.ts';
import { OCCUPANCY_CODES, STATUS_CODES } from '#lib/v1/schemas/types.ts';
import { copy } from './map.copy';
import MapLegend from './MapLegend.svelte';

const entries = (list: HTMLElement) =>
	Array.from(list.querySelectorAll<HTMLElement>('[data-legend-entry]'));

describe('MapLegend', () => {
	it.each(['en', 'fr'] as const)(
		'explains every status mark with its minutes, then position and map symbols (%s)',
		(locale) => {
			const view = render(MapLegend, { props: { locale, colourBy: 'status', staleCutoffS: 150 } });
			const list = view.getByRole('list', { name: copy[locale].legend.title });
			expect(view.getAllByRole('list')).toEqual([list]);
			expect(
				Array.from(list.querySelectorAll('[data-legend-heading]'), (el) =>
					el.getAttribute('data-legend-heading'),
				),
			).toEqual(['status', 'position', 'symbols']);
			const rows = entries(list);
			expect(rows.map((row) => row.dataset.legendEntry)).toEqual([
				...STATUS_CODES.map(() => 'status'),
				'not-reporting',
				'heading',
				'stop',
			]);
			for (const [index, code] of STATUS_CODES.entries()) {
				expect(rows[index]).toHaveAttribute('data-status', code);
				expect(within(rows[index]).getByText(STATUS_GLYPH[code])).toBeInTheDocument();
				expect(rows[index].querySelector('.mf-legend-mark')?.getAttribute('style')).toContain(
					`var(--dataviz-status-${code.replace('_', '-')})`,
				);
			}
			const onTime = within(rows[1]);
			expect(onTime.getByText(locale === 'en' ? 'On time' : 'À l’heure')).toBeVisible();
			expect(
				onTime.getByText(
					locale === 'en'
						? '1 min early to under 1 min late'
						: 'D’une minute d’avance à moins d’une minute de retard',
				),
			).toBeVisible();
			expect(view.getByText(copy[locale].legend.zoomBadges)).toBeVisible();
		},
	);

	it('explains the crowding colours, and no status, when the map is coloured by crowding', () => {
		const view = render(MapLegend, {
			props: { locale: 'en', colourBy: 'occupancy', staleCutoffS: 150 },
		});
		const list = view.getByRole('list', { name: 'Legend' });
		expect(list).toHaveAttribute('data-colour-by', 'occupancy');
		expect(within(list).getByText('Colour shows crowding')).toBeVisible();
		const rows = entries(list).filter((row) => row.dataset.legendEntry === 'occupancy');
		expect(rows.map((row) => row.dataset.occupancy)).toEqual([...OCCUPANCY_CODES]);
		for (const [index, code] of OCCUPANCY_CODES.entries())
			expect(within(rows[index]).getByText(OCCUPANCY_GLYPH[code])).toBeInTheDocument();
		expect(list.querySelector('[data-legend-entry="status"]')).toBeNull();
		expect(view.getByText('Zoom in to see each bus’s crowding badge.')).toBeVisible();
	});

	it('shows the sentence under the title as its first line only when asked', () => {
		const props = { locale: 'fr', colourBy: 'status', staleCutoffS: 150 } as const;
		const lead = copy.fr.headingLead;
		expect(render(MapLegend, { props }).queryByText(lead)).toBeNull();
		const view = render(MapLegend, { props: { ...props, lead: true } });
		const first = view.container.firstElementChild;
		expect(first).toHaveTextContent(lead);
	});
});
