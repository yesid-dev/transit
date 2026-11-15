import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { HistoricAvailabilityIndex, IsoUtc } from '#lib/v1/schemas/index.ts';
import SectionHistoryCoverage from './SectionHistoryCoverage.svelte';
import { copy } from '../health.copy';
import { selectHistoryCoverage, selectHistoryInventory } from '../selectors/historyCoverage';

const root: HistoricAvailabilityIndex = {
	generated_utc: '2026-07-14T12:00:00Z' as unknown as IsoUtc,
	publish_generation_id: 'gen-history',
	methodology_version: 'historic-2',
	families: [
		{
			family: 'network',
			selection_mode: 'range',
			index_path: 'historic/history/network/index.json',
			first_available_date: '2026-05-01',
			last_available_date: '2026-07-13',
			gaps: [{ start_date: '2026-06-02', end_date: '2026-06-03', reason: 'source outage' }],
			collection_generation_id: 'a1b2c3d4e5f6a7b8c9d0e1f2',
			metrics: [
				{
					metric: 'delay',
					aggregation: 'additive',
					first_available_date: '2026-05-01',
					last_available_date: '2026-07-13',
					gaps: [],
				},
				// A hole in one measure that the family itself does not have.
				{
					metric: 'delay_percentiles',
					aggregation: 'daily_only',
					first_available_date: '2026-05-05',
					last_available_date: '2026-07-12',
					gaps: [{ start_date: '2026-06-10', end_date: '2026-06-10', reason: 'late feed' }],
				},
				{ metric: 'vehicles', aggregation: 'daily_only' },
			],
		},
		{
			family: 'lines',
			selection_mode: 'range',
			index_path: 'historic/history/lines/index.json',
			first_available_date: '2026-06-01',
			last_available_date: '2026-06-30',
		},
	],
};
const props = (patch: object = {}) => ({
	rows: selectHistoryCoverage(root),
	inventory: selectHistoryInventory(root),
	recordWarning: false,
	copy: copy.en,
	locale: 'en' as const,
	...patch,
});
const index = () => screen.getByRole('list', { name: 'Record families' });
const evidence = () => screen.getByRole('region', { name: /^Selected family: / });
const row = (family: string) =>
	within(index()).getByRole('button', { name: family }).closest('li') as HTMLElement;

it('indexes all seven families with their actual dates and days, then shows the selected one', async () => {
	render(SectionHistoryCoverage, props());

	expect(within(index()).getAllByRole('listitem')).toHaveLength(7);
	expect(row('Network')).toHaveTextContent('May 1 – Jul 13');
	expect(row('Network')).toHaveTextContent('72 of 74 days with records');
	expect(row('Network')).toHaveTextContent('2 missing days, in 1 gap');
	expect(row('Lines')).toHaveTextContent('30 days from first to last date');
	expect(row('Lines')).toHaveTextContent('Missing days not published');
	expect(row('Stops')).toHaveTextContent('Not published');
	expect(row('Stops')).not.toHaveTextContent(/\b0\b/);

	// The first family with counted days opens selected; its evidence names it and its source.
	expect(within(index()).getByRole('button', { name: 'Network' })).toHaveAttribute(
		'aria-pressed',
		'true',
	);
	const network = evidence();
	expect(network).toHaveAccessibleName('Selected family: Network');
	expect(network).toHaveTextContent('Jun 2 – Jun 3');
	expect(network).toHaveTextContent('source outage');
	// A long fingerprint shows its first characters, with the whole value in its title.
	expect(within(network).getByText('a1b2c3d4e5f6…')).toHaveAttribute(
		'title',
		'a1b2c3d4e5f6a7b8c9d0e1f2',
	);
	expect(network).toHaveTextContent('Date list published');
	expect(network).toHaveTextContent('Jul 14, 2026');
	expect(network).toHaveTextContent('gen-history');
	expect(network).toHaveTextContent('historic-2');
	expect(network).toHaveTextContent(/Next update\s*Not published/);
	// No family-level warning is invented when the record has none.
	expect(network).not.toHaveTextContent(copy.en.historyCoverage.evidence.warningsLabel);

	await fireEvent.click(within(index()).getByRole('button', { name: 'Lines' }));
	expect(within(index()).getByRole('button', { name: 'Network' })).toHaveAttribute(
		'aria-pressed',
		'false',
	);
	expect(evidence()).toHaveAccessibleName('Selected family: Lines');
	expect(evidence()).toHaveTextContent(/Content fingerprint\s*Not published/);
});

it('shows an absent family as not published, never as zero days', async () => {
	render(SectionHistoryCoverage, props());
	await fireEvent.click(within(index()).getByRole('button', { name: 'Daily receipts' }));

	const receipts = evidence();
	expect(receipts).toHaveTextContent(copy.en.historyCoverage.evidence.absent);
	expect(receipts).not.toHaveTextContent(/\b0\b|days with records/);
});

it('says which families a record warning affects is not published, without inventing one', () => {
	render(SectionHistoryCoverage, props({ recordWarning: true }));

	expect(evidence()).toHaveTextContent(copy.en.historyCoverage.evidence.warningsUnscoped);
});

it('speaks French with the same structure', () => {
	render(SectionHistoryCoverage, props({ copy: copy.fr, locale: 'fr' }));

	expect(screen.getByRole('list', { name: 'Familles de bilans' })).toBeInTheDocument();
	expect(screen.getByRole('region', { name: 'Famille choisie : Réseau' })).toHaveTextContent(
		'72 jours sur 74 avec des données',
	);
});

it.each([
	[
		'en',
		['Jun 10', 'late feed'],
		'No missing days declared',
		'Missing days not published',
		'No metric inventory',
	],
	[
		'fr',
		['10 juin', 'late feed'],
		'Aucun jour manquant déclaré',
		'Jours manquants non publiés',
		'Aucun détail métrique',
	],
] as const)(
	'%s: keeps each measure’s own gaps and says when an inventory is absent',
	async (locale, gap, none, unknown, noMeasures) => {
		render(SectionHistoryCoverage, props({ copy: copy[locale], locale }));
		const t = copy[locale].historyCoverage;
		const panel = () => screen.getByRole('region', { name: t.evidence.region(t.families.network) });
		const measure = (key: string) => panel().querySelector(`[data-metric="${key}"]`) as HTMLElement;

		for (const text of gap) expect(measure('delay_percentiles')).toHaveTextContent(text);
		expect(measure('delay')).toHaveTextContent(none);
		expect(measure('vehicles')).toHaveTextContent(unknown);
		await fireEvent.click(screen.getByRole('button', { name: t.families.lines }));
		expect(
			screen.getByRole('region', { name: t.evidence.region(t.families.lines) }),
		).toHaveTextContent(noMeasures);
	},
);
