import { render, screen, within } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import { downloadLayouts, downloadTables } from '#lib/features/record/downloadTables.ts';
import { tableName } from '#lib/features/record/dataHealthText.ts';
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
	'renders the %s download page for cleaning version %s with a confirmed file and licence',
	async (locale, version) => {
		language.value = locale;
		const city = { city: 'Ottawa', operator: 'OC Transpo' };
		const filename = version === '12' ? 'segment_runs.parquet' : 'stop_events.parquet';
		const file = `${downloadPath}/${filename}?version=${version}`;
		render(Page, {
			props: {
				data: {
					providerId: 'octranspo',
					city,
					period: { from: '2026-11-19', to: day, preset: null },
					window: { from: '2026-11-19', to: day, page: 0, lastPage: 0 },
					methods: null,
					listing: Promise.resolve({
						kind: 'answer' as const,
						unavailable: false,
						busy: false,
						listings: [
							{
								city: 'octranspo',
								service_date: day,
								cleaning_version: version,
								status: 'complete' as const,
								files: [{ name: filename, byte_size: 4800000, sha256: '1'.repeat(64), url: file }],
								readme_url: `${downloadPath}/README.txt?version=${version}`,
								alerts_not_tracked: true,
								licence,
							},
							{
								city: 'octranspo',
								service_date: '2026-11-19',
								cleaning_version: version,
								status: 'missing' as const,
								files: [],
								readme_url: null,
								alerts_not_tracked: true,
								licence,
							},
						],
					}),
				},
			},
		});
		const key = version === '12' ? 'segment_runs' : 'stop_events';
		const chosen = downloadLayouts[key];
		// The card shell is already present while the file listing is pending.
		await screen.findByRole('link', { name: attribution[locale] });
		// Download names each table as Data health does.
		const card = await screen.findByRole('article', { name: tableName(key, locale) });
		const trigger = within(card).getByRole('button', {
			name: locale === 'en' ? 'See the layout and files' : 'Voir la structure et les fichiers',
		});
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
		const content = document.getElementById(trigger.getAttribute('aria-controls')!);
		expect(content).toHaveTextContent(chosen.columns[0]);
		expect(content).toHaveAttribute('hidden', 'until-found');
		trigger.click();
		expect(await screen.findByRole('link', { name: new RegExp(filename) })).toHaveAttribute(
			'href',
			file,
		);
		expect(trigger).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByRole('link', { name: attribution[locale] })).toHaveAttribute('href', source);
		expect(
			screen.getByText(locale === 'en' ? '22 November 2026' : '22 novembre 2026'),
		).toHaveAttribute('datetime', licence.checked_on);
		expect(screen.queryByRole('combobox')).toBeNull();
		expect(
			screen
				.getAllByText(locale === 'en' ? /4\.8 MB/ : /4,8\sMo/)
				.every((node) => node.checkVisibility()),
		).toBe(true);
		expect(screen.queryByRole('link', { name: /19 Nov|19 nov/ })).toBeNull();
		expect(
			within(card).getByRole('list', {
				name: locale === 'en' ? 'Dates without files' : 'Dates sans fichier',
			}),
		).toHaveTextContent(locale === 'en' ? /19 Nov.*Missing/i : /19 nov.*Manquant/i);
		expect(card.querySelector('[data-record-state="not_measured"]')).toBeVisible();
		// The licence asks to say what changed: once, in plain words, above the tables.
		const changes = document.querySelector('[data-slot="source-changes"]')!;
		expect(changes).toHaveTextContent(
			locale === 'en'
				? /Transit cleaned and joined the agency’s files: .*The data was modified and is unofficial\./
				: /Transit a nettoyé et joint les fichiers de la société de transport\s: .*Les données ont été modifiées et sont non officielles\./,
		);
		expect(changes.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// The licence and the cleaning version are not repeated on each table's card.
		expect(card).not.toHaveTextContent(/CC BY|Cleaning|Nettoyage|v1[12]/);
		expect(
			screen.getByText(
				locale === 'en'
					? 'Notices are not tracked for this city.'
					: 'Les avis ne sont pas suivis pour cette ville.',
			),
		).toBeInTheDocument();
		// Data health's words for the same things; the file names stay in the files.
		expect(document.body).not.toHaveTextContent(
			/\bagence\b|version du nettoyage|tables? nettoyées?|clean tables?|cleaning version|Trip days|Feed polls|Prediction samples|Segment runs/iu,
		);
		if (version === '12') {
			const description = await screen.findByText(downloadTables.segment_runs[locale]);
			expect(description).toBeVisible();
			expect(description).not.toHaveTextContent(/\b(?:seconds|secondes)\b/i);
		} else {
			expect(screen.queryByText('segment_runs')).toBeNull();
		}
	},
);

it.each([
	['en', 0, 'files cover these dates: 8 tables, one file for each of the 7 days.'],
	['fr', 0, 'fichiers couvrent ces dates : 8 tables, un fichier par jour sur 7 jours.'],
	['en', 3, 'files cover these dates; 3 are missing, see the cards.'],
	['fr', 3, 'fichiers couvrent ces dates ; il en manque 3, consultez les fiches.'],
] as const)('describes the %s grid with %i missing files', async (locale, missing, sentence) => {
	language.value = locale;
	const dates = [
		'2026-11-14',
		'2026-11-15',
		'2026-11-16',
		'2026-11-17',
		'2026-11-18',
		'2026-11-19',
		day,
	];
	const period = { from: dates[0], to: day, preset: null };
	const { container } = render(Page, {
		props: {
			data: {
				providerId: 'stm',
				city: null,
				period,
				window: { ...period, page: 0, lastPage: 0 },
				methods: null,
				listing: Promise.resolve({
					kind: 'answer' as const,
					unavailable: false,
					busy: false,
					listings: dates.map((date, i) => ({
						city: 'stm',
						service_date: date,
						cleaning_version: '12',
						status: 'complete' as const,
						files: Object.keys(downloadLayouts)
							.slice(i === 0 ? missing : 0)
							.map((table) => ({
								name: table + '.parquet',
								byte_size: 4800000,
								sha256: '1'.repeat(64),
								url: `https://data.yesid.dev/v2/stm/download/${date}/${table}.parquet?version=12`,
							})),
						readme_url: null,
						alerts_not_tracked: false,
						licence,
					})),
				}),
			},
		},
	});
	expect(await screen.findByText(sentence)).toBeVisible();
	expect(container.querySelector('[data-slot="screen-answer"]')).toHaveTextContent(
		String(56 - missing),
	);
	expect(container.querySelectorAll('article [data-record-state]')).toHaveLength(missing);
});

it.each([
	['en', 'Waiting for a turn. This card asks again in a few seconds.'],
	['fr', 'En attente. Cette carte redemande dans quelques secondes.'],
] as const)(
	'uses the shared pending line for a busy download answer in %s',
	async (locale, pending) => {
		language.value = locale;
		const { container } = render(Page, {
			props: {
				data: {
					providerId: 'octranspo',
					city: { city: 'Ottawa', operator: 'OC Transpo' },
					period: { from: day, to: day, preset: null },
					window: { from: day, to: day, page: 0, lastPage: 0 },
					methods: null,
					listing: Promise.resolve({
						kind: 'busy' as const,
						unavailable: true,
						busy: true,
						listings: [],
					}),
				},
			},
		});
		expect(await screen.findByText(pending)).toBeVisible();
		expect(container.querySelector('[data-slot="screen-answer"]')).toHaveTextContent(pending);
		expect(container.querySelector('[data-slot="answer-lead"]')).toBeNull();
	},
);
