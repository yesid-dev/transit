import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { RouteFile, StopPrediction } from '#lib/v1/index.ts';
import LineDirections from './LineDirections.svelte';
import { detailCopy } from './lines.copy';

const stops = Array.from({ length: 61 }, (_, i) => ({
	id: `s${i}`,
	seq: i + 1,
	name: `Stop ${i + 1} / Long public destination name`,
}));
const directions: RouteFile['directions'] = [
	{ dir: 0, headsign: 'Eastbound', stops },
	{ dir: 0, headsign: 'Eastbound via station', stops: [stops[0]] },
	{ dir: 1, headsign: 'Westbound', stops: [{ id: 'west', seq: 1, name: 'West stop' }] },
];
const predictions = new Map<string, StopPrediction>(
	stops.slice(0, 8).map((stop) => [stop.id, { etaUtc: '2026-06-15T12:05:00Z', delayMin: 2 }]),
);

describe.each(['en', 'fr'] as const)('LineDirections in %s', (locale) => {
	const props = {
		directions,
		predictions,
		locale,
		copy: detailCopy[locale],
		timeZone: 'America/Toronto',
	};
	it('shows one destination, explains stop-level predictions and retains shared-stop identity', async () => {
		const view = render(LineDirections, { props });
		const choice = screen.getByRole('combobox');
		expect(choice).toHaveAccessibleName('Destination');
		expect(screen.getAllByRole('table')).toHaveLength(1);
		const table = screen.getByRole('table');
		expect(table).toHaveAccessibleName(/Eastbound/);
		expect(within(table).getAllByRole('rowheader')).toHaveLength(6);
		expect(table).toHaveTextContent('+2 min');
		expect(table.querySelector('time')).toHaveAttribute('datetime', '2026-06-15T12:05:00Z');
		expect(view.container).toHaveTextContent(
			locale === 'en'
				? 'Predictions at different stops may refer to different trips.'
				: 'Les prévisions aux différents arrêts peuvent concerner des trajets différents.',
		);
		await fireEvent.click(screen.getByRole('button', { name: /8/ }));
		expect(within(table).getAllByRole('rowheader')).toHaveLength(8);
		await fireEvent.change(choice, { target: { value: '1' } });
		expect(screen.getByRole('table')).toHaveAccessibleName(/Eastbound via station/);
		expect(screen.getByRole('link', { name: /Stop 1 / })).toHaveAttribute(
			'href',
			locale === 'fr' ? '/fr/stop/s0' : '/stop/s0',
		);
		expect(view.container).toHaveTextContent(
			locale === 'en'
				? 'Shared stops show the same next prediction in each destination.'
				: 'Les arrêts communs affichent la même prochaine prévision pour chaque destination.',
		);
		await fireEvent.change(choice, { target: { value: '2' } });
		expect(screen.queryByRole('table')).toBeNull();
		expect(view.container).toHaveTextContent(
			locale === 'en'
				? 'No predictions reported for this destination.'
				: 'Aucune prévision reçue pour cette destination.',
		);
	});

	it('keeps schedule destinations closed, caps long lists, and has no prediction placeholders', async () => {
		const { container } = render(LineDirections, { props: { ...props, mode: 'schedule' } });
		const details = container.querySelectorAll('details');
		expect([...details].every((entry) => !entry.open)).toBe(true);
		await fireEvent.click(within(details[0]).getByText('Eastbound'));
		expect(within(details[0]).getAllByRole('link')).toHaveLength(6);
		await fireEvent.click(within(details[0]).getByRole('button', { name: /61/ }));
		expect(within(details[0]).getAllByRole('link')).toHaveLength(61);
		expect(container.querySelector('time, table, [data-slot="absent-value"]')).toBeNull();
	});
});
