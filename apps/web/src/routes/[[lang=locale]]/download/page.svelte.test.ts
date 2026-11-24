import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import { downloadTables } from '#lib/features/record/downloadTables.ts';
import Page from './+page.svelte';

const { language } = vi.hoisted(() => ({ language: { value: 'en' as 'en' | 'fr' } }));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/i18n/index.ts')>()),
	getLocale: () => language.value,
}));

const day = '2026-11-20';
const source = 'https://ottawa.ca/licence';
const downloadPath = `https://data.yesid.dev/v2/octranspo/download/${day}`;
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

const cases = [
	['en', '11'],
	['fr', '11'],
	['en', '12'],
	['fr', '12'],
] as const;

it.each(cases)(
	'renders the %s download page for cleaning version %s with date selection, file and licence',
	async (locale, version) => {
		language.value = locale;
		const city = { city: 'Ottawa', operator: 'OC Transpo' };
		const filename = version === '12' ? 'segment_runs.parquet' : 'stop_events.parquet';
		const file = `${downloadPath}/${filename}?version=${version}`;
		render(Page, {
			props: {
				data: {
					providerId: 'octranspo',
					providers: [{ id: 'octranspo', labels: { en: city, fr: city } }],
					date: day,
					invalidDate: false,
					listing: Promise.resolve({
						kind: 'answer' as const,
						answer: {
							city: 'octranspo',
							service_date: day,
							cleaning_version: version,
							status: 'complete' as const,
							files: [{ name: filename, byte_size: 500, sha256: '1'.repeat(64), url: file }],
							readme_url: `${downloadPath}/README.txt?version=${version}`,
							alerts_not_tracked: true,
							licence,
						},
					}),
				},
			},
		});
		expect(await screen.findByRole('link', { name: filename })).toHaveAttribute('href', file);
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
		if (version === '12') {
			const description = await screen.findByText(downloadTables.segment_runs[locale]);
			expect(description).toBeVisible();
			expect(description).not.toHaveTextContent(/\b(?:seconds|secondes)\b/i);
		} else {
			expect(screen.queryByText('segment_runs')).toBeNull();
		}
	},
);
