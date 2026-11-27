import { render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import { roadmapLinks } from '../roadmap/roadmap.copy.ts';
import Overview from './Overview.svelte';
import OverviewContribute from './OverviewContribute.svelte';
import { delivered, measure, period, ranking } from './overviewRecord.fixture.ts';
import { previousPeriod } from './overviewRecord.ts';
import { overviewCopy } from './overviewRecord.copy.ts';

const answer = <T>(value: T) => Promise.resolve({ kind: 'answer' as const, answer: value });
const href = 'https://transit.test/?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14';

const words = {
	en: {
		intro:
			'Transit is an independent public record of the service transit agencies actually deliver, built from their own open data. It covers Montréal and Ottawa today, and more cities are coming. It is not a trip planner.',
		links: ['Seen an error?', 'Download the data', 'Transit on GitHub', 'Suggest a city'],
	},
	fr: {
		intro:
			'Transit dresse un bilan public et indépendant du service réellement offert, à partir des données ouvertes des sociétés de transport. Il couvre Montréal et Ottawa aujourd’hui, et d’autres villes suivront. Ce n’est pas un planificateur de trajets.',
		links: [
			'Vous avez vu une erreur?',
			'Télécharger les données',
			'Transit sur GitHub',
			'Proposer une ville',
		],
	},
} as const;

for (const locale of ['en', 'fr'] as const) {
	const copy = overviewCopy[locale];

	it(`invites anyone to help, with one working link per way, in ${locale}`, () => {
		render(OverviewContribute, {
			props: { locale, errorHref: '/metrics#about-transit', downloadHref: '/download' },
		});
		const card = screen.getByRole('article', { name: copy.contribute.title });
		expect(within(card).getByText(copy.contribute.lead)).toBeVisible();
		expect(within(card).getByText(copy.contribute.thanks)).toBeVisible();
		const ways = within(card).getAllByRole('listitem');
		expect(ways).toHaveLength(4);
		const links = within(card).getAllByRole('link');
		expect(links.map((link) => link.textContent)).toEqual(words[locale].links);
		expect(links.map((link) => link.getAttribute('href'))).toEqual([
			'/metrics#about-transit',
			'/download',
			'https://github.com/yesid-dev/transit',
			roadmapLinks.contact[locale],
		]);
		// Words Yesito reads: no em dash, "vehicle" never "bus".
		expect(card.textContent).not.toMatch(/—|\bbus\b/iu);
	});

	it(`says what Transit is and closes with the invitation, in ${locale}`, async () => {
		const { container } = render(Overview, {
			props: {
				city: 'Montréal',
				locale,
				provider: 'stm',
				href,
				cities: ['Ottawa', 'Montréal'],
				record: {
					period,
					previous: previousPeriod(period),
					punctuality: answer(measure()),
					baseline: answer(measure()),
					delivery: answer(delivered),
					lines: answer(ranking),
					stops: answer({ ...ranking, kind: 'stop' as const }),
				},
			},
		});
		expect(container.querySelector('[data-screen-intro]')).toHaveTextContent(words[locale].intro);
		expect(words[locale].intro).not.toMatch(/—|\bbus\b/iu);
		const invitation = screen.getByRole('article', { name: copy.contribute.title });
		const cards = [...container.querySelectorAll('[data-slot="record-card"]')];
		expect(cards.at(-1)).toBe(invitation.closest('[data-slot="record-card"]'));
		const links = within(invitation).getAllByRole('link');
		const error = new URL(links[0].getAttribute('href')!, href);
		expect(error.pathname + error.hash).toBe(
			locale === 'fr' ? '/fr/metrics#about-transit' : '/metrics#about-transit',
		);
		expect(new URL(links[1].getAttribute('href')!, href).pathname).toBe(
			locale === 'fr' ? '/fr/download' : '/download',
		);
	});
}

it('leaves the city sentence out when no city is declared', () => {
	expect(overviewCopy.en.intro(null)).toBe(
		'Transit is an independent public record of the service transit agencies actually deliver, built from their own open data. It is not a trip planner.',
	);
});
