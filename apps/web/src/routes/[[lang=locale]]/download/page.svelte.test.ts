import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import Page from './+page.svelte';

const { language } = vi.hoisted(() => ({ language: { value: 'en' as 'en' | 'fr' } }));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/i18n/index.ts')>()),
	getLocale: () => language.value,
}));

const day = '2026-11-20';
const source = 'https://ottawa.ca/licence';
const file = '/v2/octranspo/download/2026-11-20/stop_events.parquet?version=11';
const attribution = {
	en: 'Contains information licensed under the Open Government Licence – City of Ottawa.',
	fr: 'Contient de l’information visée par la Licence du gouvernement ouvert – Ville d’Ottawa.',
};
const licence = {
	name: {
		en: 'Open Government Licence, City of Ottawa, v2.0',
		fr: 'Licence du gouvernement ouvert, Ville d’Ottawa, version 2.0',
	},
	checked_on: '2026-11-22',
	attribution,
	url: { en: source, fr: source },
	changes: { en: 'Transit modified the data.', fr: 'Transit a modifié les données.' },
	non_endorsement: { en: 'Transit is independent.', fr: 'Transit est indépendant.' },
	limits: { en: 'Provided as is.', fr: 'Fournies telles quelles.' },
	contact: 'contact@yesid.dev',
};

it.each(['en', 'fr'] as const)(
	'renders the %s date selection, file and licence',
	async (locale) => {
		language.value = locale;
		const city = { city: 'Ottawa', operator: 'OC Transpo' };
		render(Page, {
			props: {
				data: {
					providerId: 'octranspo',
					providers: [{ id: 'octranspo', labels: { en: city, fr: city } }],
					date: day,
					invalidDate: false,
					listing: Promise.resolve({
						kind: 'answer',
						answer: {
							city: 'octranspo',
							service_date: day,
							cleaning_version: '11',
							status: 'complete',
							files: [
								{ name: 'stop_events.parquet', byte_size: 500, sha256: '1'.repeat(64), url: file },
							],
							readme_url: '/v2/octranspo/download/2026-11-20/README.txt?version=11',
							alerts_not_tracked: true,
							licence,
						},
					}),
				},
			},
		});
		expect(await screen.findByRole('link', { name: 'stop_events.parquet' })).toHaveAttribute(
			'href',
			'https://data.yesid.dev' + file,
		);
		expect(screen.getByRole('link', { name: attribution[locale] })).toHaveAttribute('href', source);
		expect(screen.getByLabelText(locale === 'en' ? 'Service date' : 'Date de service')).toHaveValue(
			day,
		);
		expect(
			screen.getByText(
				locale === 'en'
					? 'Service alerts are not tracked for this city.'
					: 'Les avis de service ne sont pas suivis pour cette ville.',
			),
		).toBeInTheDocument();
	},
);
