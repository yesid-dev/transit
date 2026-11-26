import { render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type {
	DataHealthAnswer,
	EngineResult,
	MeasureAnswer,
	MethodEntry,
	RecordMeasure,
	ScorecardAnswer,
} from '#lib/server/engine.ts';
import health from '../../../../e2e/clean-table-health.json';
import catalog from '../../../../e2e/method-catalog.json';
import MethodCatalog from './MethodCatalog.svelte';
import RecordDataHealth from './RecordDataHealth.svelte';
import { recordState } from './recordStates';

const period = { from: health.from, to: health.to };
// The agency's figures stay pending so these tests read the days in the record alone.
const agencyWaiting = () => {
	const waiting = <T>() => new Promise<EngineResult<T>>(() => {});
	return {
		coverage: waiting<MeasureAnswer>(),
		accessibility: waiting<RecordMeasure>(),
		alertEffects: null,
		scorecard: {
			vehicle_field_completeness: waiting<ScorecardAnswer>(),
			live_trip_coverage: waiting<ScorecardAnswer>(),
			prediction_error: waiting<ScorecardAnswer>(),
			poll_success: waiting<ScorecardAnswer>(),
		},
	};
};
const fixtureDelay = catalog.find(({ id }) => id === 'fixture_delay')!;

it.each([
	['en', 'In use since', /(method|cleaning) v\d/iu],
	['fr', 'En vigueur depuis', /(méthode|nettoyage) v\d/iu],
] as const)('dates each method without version codes in %s', async (locale, since, code) => {
	render(MethodCatalog, {
		locale,
		url: new URL('https://transit1.yesid.dev/metrics'),
		city: 'stm',
		period,
		catalog: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: catalog }),
	});
	const labels = await screen.findAllByText(since, { exact: true });
	const dates = new Set(catalog.map((entry) => entry.since));
	const dated = labels.map((label) => label.parentElement!.querySelector('dd time'));
	expect(dated.some((time) => time && dates.has(time.getAttribute('datetime')!))).toBe(true);
	for (const time of dated.filter(Boolean))
		expect(time!.parentElement).toHaveTextContent(/^\d{1,2} \S+ \d{4}$|^\S+ \d{1,2}, \d{4}$/u);
	expect(document.body.textContent).not.toMatch(code);
});

it('renders localized registry content and marks a last-good catalog', async () => {
	const url = new URL('https://transit1.yesid.dev/fr/metrics');
	render(MethodCatalog, {
		locale: 'fr',
		url,
		city: 'octranspo',
		period,
		catalog: Promise.resolve<EngineResult<MethodEntry[]>>({
			kind: 'answer',
			answer: catalog,
			lastGood: true,
		}),
	});
	const trigger = await screen.findByRole('button', {
		name: /^Retard typique aux arrêts observés/u,
	});
	const entry = document.getElementById(fixtureDelay.id)!;
	expect(entry).toContainElement(trigger);
	expect(entry).toHaveAttribute('data-open', 'false');
	expect(trigger).toHaveAttribute('aria-expanded', 'false');
	expect(entry).toHaveTextContent(fixtureDelay.text.fr.exclusions);
	expect(entry).toHaveTextContent(fixtureDelay.text.fr.limits);
	expect(entry).toHaveTextContent(/45/);
	expect(screen.getByText(/calcul précédent/)).toBeVisible();
});

it.each(['en', 'fr'] as const)('uses the shared state marks in %s', async (locale) => {
	render(MethodCatalog, {
		locale,
		url: new URL('https://transit1.yesid.dev/metrics'),
		city: 'stm',
		period,
		catalog: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: catalog }),
	});
	const card = await screen.findByRole('article', {
		name: locale === 'fr' ? 'Six états, chacun nommé' : 'Six states, each said in words',
	});
	const states = [
		'no_live_data',
		'not_measured',
		'too_few_to_judge',
		'delay_unknown',
		'not_reporting',
		'not_tracked',
	] as const;
	const marks = card.querySelectorAll('[data-record-state]');
	expect(marks).toHaveLength(states.length);
	states.forEach((state, index) => {
		expect(marks[index]).toHaveAttribute('data-record-state', state);
		expect(marks[index]).toHaveTextContent(recordState(state)[locale]);
		expect(marks[index].querySelector('[aria-hidden]')).toHaveTextContent(recordState(state).glyph);
	});
});

it('puts shared family prose in one reading and links to it from its siblings', async () => {
	const first = { ...fixtureDelay, id: 'on_time' };
	const second = { ...fixtureDelay, id: 'early' };
	render(MethodCatalog, {
		locale: 'en',
		url: new URL('https://transit1.yesid.dev/metrics'),
		city: 'stm',
		period,
		catalog: Promise.resolve<EngineResult<MethodEntry[]>>({
			kind: 'answer',
			answer: [second, first],
		}),
	});
	expect(await screen.findAllByText(/Each stop with a reading counts once\./)).toHaveLength(1);
	const early = document.getElementById('early')!;
	expect(early).toHaveTextContent('The same as the on-time share.');
	expect(early.querySelector('a[href="#on_time"]')).toHaveTextContent('the on-time share');
});

it.each([
	['en', 'For data users', 'The method registry does not specify this.'],
	['fr', 'Pour les utilisateurs de données', 'Le registre des méthodes ne le précise pas.'],
] as const)(
	'routes histograms to %s "For data users", hides empty fields and caps strokes per card',
	async (locale, notesTitle, placeholder) => {
		const entries: MethodEntry[] = [
			{
				...fixtureDelay,
				id: 'on_time',
				minimum_sample: 30,
				text: {
					en: {
						...fixtureDelay.text.en,
						histogram: undefined,
					},
					fr: {
						...fixtureDelay.text.fr,
						histogram: undefined,
					},
				},
			},
			{
				...fixtureDelay,
				id: 'median_delay',
				minimum_sample: 30,
			},
			{
				...fixtureDelay,
				id: 'p90_delay',
				minimum_sample: 30,
			},
			{
				...fixtureDelay,
				id: 'crowding_empty',
				family: 'crowding',
				family_text: { en: 'Crowding', fr: 'Occupation des véhicules' },
				minimum_sample: 1,
				text: {
					en: {
						definition: 'Share of vehicle time when vehicles reported being empty.',
						unit: 'Share',
						counts:
							'Divides vehicle time at each level by total vehicle time. Extra technical note.',
						exclusions: '',
						limits: 'Cannot count riders on board.',
					},
					fr: {
						definition: 'Part du temps-véhicule pendant laquelle les véhicules étaient vides.',
						unit: 'Part',
						counts: 'Divise le temps-véhicule par niveau. Note technique supplémentaire.',
						exclusions: '',
						limits: 'Ne compte pas les usagers à bord.',
					},
				},
			},
			{
				...fixtureDelay,
				id: 'crowding_full',
				family: 'crowding',
				family_text: { en: 'Crowding', fr: 'Occupation des véhicules' },
				minimum_sample: 1,
				text: {
					en: {
						definition: 'Share of vehicle time when vehicles reported being full.',
						unit: 'Share',
						counts:
							'Divides vehicle time at each level by total vehicle time. Extra technical note.',
						exclusions: '',
						limits: 'Cannot count riders on board.',
					},
					fr: {
						definition: 'Part du temps-véhicule pendant laquelle les véhicules étaient pleins.',
						unit: 'Part',
						counts: 'Divise le temps-véhicule par niveau. Note technique supplémentaire.',
						exclusions: '',
						limits: 'Ne compte pas les usagers à bord.',
					},
				},
			},
		];
		const { container } = render(MethodCatalog, {
			locale,
			url: new URL(
				locale === 'fr'
					? 'https://transit1.yesid.dev/fr/metrics'
					: 'https://transit1.yesid.dev/metrics',
			),
			city: 'stm',
			period,
			catalog: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: entries }),
		});
		expect(await screen.findAllByText(notesTitle, { selector: 'button *' })).not.toHaveLength(0);
		expect(document.body.textContent).not.toContain(placeholder);

		const percentiles = document.getElementById('delay-percentiles')!;
		expect(percentiles).toHaveTextContent(
			locale === 'fr' ? 'Comme pour la part à l’heure.' : 'The same as the on-time share.',
		);
		const percentilesNotes = document.getElementById('delay-percentiles-notes')!;
		expect(percentilesNotes).toHaveTextContent(locale === 'fr' ? 'tranches de 15' : '15-s steps');
		expect(percentilesNotes).toHaveTextContent(locale === 'fr' ? 'Calcul' : 'How it is calculated');

		const onTime = document.getElementById('on_time')!;
		for (const [label, value] of [
			[locale === 'fr' ? 'Échantillon minimal' : 'Minimum sample', '30'],
			[
				locale === 'fr'
					? 'Échantillon minimal pour les classements'
					: 'Minimum sample for rankings',
				'45',
			],
		] as const) {
			const field = within(onTime).getByText(label, { exact: true, selector: 'dt' }).parentElement!;
			expect(within(field).getByText(value, { exact: true, selector: 'dd' })).toBeVisible();
			expect(field).not.toHaveTextContent(
				locale === 'fr' ? 'Ce que la mesure ne peut pas dire' : 'What it cannot tell',
			);
		}

		const rankingNotes = document.getElementById('ranking-range-notes')!;
		expect(rankingNotes).toHaveTextContent(
			locale === 'fr' ? 'Ordre du classement' : 'How rows are ordered',
		);
		expect(rankingNotes).toHaveTextContent(locale === 'fr' ? 'Mise en garde' : 'Caveat');
		for (const riderLabel of locale === 'fr'
			? ['Ce que la mesure compte', 'Ce que la mesure exclut', 'Ce que la mesure ne peut pas dire']
			: ['What it counts', 'What it leaves out', 'What it cannot tell']) {
			expect(percentilesNotes).not.toHaveTextContent(riderLabel);
			expect(rankingNotes).not.toHaveTextContent(riderLabel);
		}

		const crowding = document.getElementById('family-crowding')!;
		expect(crowding).not.toHaveTextContent(
			locale === 'fr' ? 'Ce que la mesure exclut' : 'What it leaves out',
		);
		expect(crowding.querySelectorAll('[data-record-disclosure]')).toHaveLength(1);

		const topCards = container.querySelectorAll<HTMLElement>('[data-slot="card"]');
		for (const card of topCards) {
			expect(card.querySelectorAll('[data-slot="separator"]').length).toBeLessThanOrEqual(6);
		}
	},
);

it('describes closed families with all of their measures', async () => {
	const entries = ['early', 'late', 'vehicle_early', 'vehicle_late'].map((id) => ({
		...fixtureDelay,
		id,
		family: id.startsWith('vehicle_') ? 'vehicles' : fixtureDelay.family,
	}));
	render(MethodCatalog, {
		locale: 'en',
		url: new URL('https://transit1.yesid.dev/metrics'),
		city: 'stm',
		period,
		catalog: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: entries }),
	});
	await screen.findByText(/Early is more than 1 minute ahead.*Late is more than 5 minutes/);
	const family = document.getElementById('family-vehicles')!;
	const more = family.closest('[aria-labelledby="more-methods"]');
	expect(more?.previousElementSibling).toHaveAttribute('data-slot', 'page-section-boundary');
	const trigger = within(family).getByRole('button', {
		name: /Early share by vehicle and Late share by vehicle\.$/u,
	});
	expect(family).toHaveAttribute('data-open', 'false');
	expect(trigger).toHaveAttribute('aria-expanded', 'false');
	const content = document.getElementById(trigger.getAttribute('aria-controls')!);
	expect(content).toContainElement(document.getElementById('vehicle_early'));
	expect(content).toHaveAttribute('aria-hidden', 'true');
});

it('renders an honest empty catalog', async () => {
	render(MethodCatalog, {
		locale: 'en',
		url: new URL('https://transit1.yesid.dev/metrics'),
		city: 'stm',
		period,
		catalog: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: [] }),
	});
	expect(await screen.findByText('No measures are listed yet.')).toBeVisible();
});

it.each([
	['answer', { kind: 'answer', answer: catalog } as EngineResult<MethodEntry[]>],
	['unreachable', { kind: 'unreachable' } as EngineResult<MethodEntry[]>],
] as const)(
	'waits to mount the archive section until the catalog resolves (%s)',
	async (_label, settled) => {
		let finish!: (result: EngineResult<MethodEntry[]>) => void;
		const pending = new Promise<EngineResult<MethodEntry[]>>((resolve) => {
			finish = resolve;
		});
		render(MethodCatalog, {
			locale: 'en',
			url: new URL('https://transit1.yesid.dev/metrics?provider=octranspo'),
			city: 'octranspo',
			period,
			catalog: pending,
		});
		expect(screen.getByText('Calculating…')).toBeVisible();
		expect(screen.queryByRole('link', { name: 'Methodology for the archived record' })).toBeNull();
		finish(settled);
		const archive = await screen.findByRole('link', {
			name: 'Methodology for the archived record',
		});
		expect(archive).toHaveAttribute('href', '/metrics/archive?provider=octranspo');
		const section = archive.closest('[data-slot="page-section"]');
		expect(section?.previousElementSibling).toHaveAttribute('data-slot', 'page-section-boundary');
	},
);

it('renders absent readings and both not-measured reasons while methods can fail independently', async () => {
	const url = new URL('https://transit1.yesid.dev/status');
	const answer = health as DataHealthAnswer;
	let finish!: (result: EngineResult<DataHealthAnswer>) => void;
	render(RecordDataHealth, {
		locale: 'en',
		url,
		record: {
			...agencyWaiting(),
			city: health.city,
			period,
			health: new Promise<EngineResult<DataHealthAnswer>>((resolve) => {
				finish = resolve;
			}),
			methods: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'busy' }),
		},
	});
	expect((await screen.findAllByText('Waiting for a reading.'))[0]).toBeVisible();
	expect(screen.getAllByText('Calculating…')[0]).toBeVisible();
	finish({ kind: 'answer', answer });
	const table = await screen.findByRole('table');
	for (const label of [
		'Present',
		'Not tracked',
		'Missing (File size differs from the file list)',
	]) {
		expect(within(table).getAllByRole('cell', { name: label })[0]).toBeVisible();
	}
	for (const reason of ['No raw captures', 'No schedule edition']) {
		expect(within(table).getAllByRole('cell', { name: `Not measured (${reason})` })).toHaveLength(
			2,
		);
	}
	expect(within(table).queryByRole('cell', { name: '0' })).toBeNull();
	expect(screen.getByText('Present', { exact: true })).toBeVisible();
	expect(screen.getByText('3 of 4 days have a gap.')).toBeVisible();
	expect(document.body).not.toHaveTextContent(/table days|clean tables?/iu);
	expect(screen.getByText('Not tracked', { exact: true })).toBeVisible();
	expect(screen.queryByText('Incomplete', { exact: true })).not.toBeInTheDocument();
	expect(screen.getByRole('list', { name: 'Day states' })).not.toHaveTextContent('Unknown');
});

it.each([
	['en', '/status', 'Not measured (Schedule archive unreadable)'],
	['fr', '/fr/status', 'Non mesuré (Archive de l’horaire illisible)'],
] as const)('renders the unreadable schedule archive reason in %s', async (locale, path, label) => {
	const answer: DataHealthAnswer = {
		city: health.city,
		...period,
		cleaning_version: '9',
		days: [
			{
				service_date: period.from,
				cleaning_version: '9',
				status: 'not_measured',
				reason: 'schedule_archive_unreadable',
				tables: { stop_events: { status: 'not_measured' } },
			},
		],
	};
	render(RecordDataHealth, {
		locale,
		url: new URL(path, 'https://transit1.yesid.dev'),
		record: {
			...agencyWaiting(),
			city: answer.city,
			period,
			health: Promise.resolve<EngineResult<DataHealthAnswer>>({ kind: 'answer', answer }),
			methods: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: [] }),
		},
	});
	const table = await screen.findByRole('table');
	const readings = within(table).getAllByRole('cell', { name: label });
	expect(readings).toHaveLength(1);
	for (const reading of readings) expect(reading).toBeVisible();
});

it.each([
	[
		'en',
		'65.1%',
		'of scheduled stop events have a reading.',
		'What OC Transpo publishes',
		'Transit does not collect OC Transpo’s alerts yet.',
		'Check official service alerts',
	],
	[
		'fr',
		/^65,1\s%$/u,
		'des passages prévus aux arrêts ont un relevé.',
		'Ce que publie OC Transpo',
		'Transit ne collecte pas encore les avis d’OC Transpo.',
		'Consulter les avis officiels',
	],
] as const)(
	'leads with the agency in %s',
	async (locale, value, sentence, publishes, notCollected, official) => {
		const waiting = agencyWaiting();
		render(RecordDataHealth, {
			locale,
			url: new URL('https://transit1.yesid.dev/status'),
			operator: 'OC Transpo',
			subject: 'OC Transpo, Ottawa',
			alerts: { tracked: false, officialUrl: 'https://example.test/alerts' },
			record: {
				...waiting,
				city: 'octranspo',
				period,
				coverage: Promise.resolve<EngineResult<MeasureAnswer>>({
					kind: 'answer',
					answer: {
						measure: 'punctuality',
						state: 'measured',
						state_text: { en: '', fr: '' },
						value: { on_time: 0.8 },
						coverage_note: null,
						evidence: {
							start_date: period.from,
							end_date: period.to,
							days_included: [period.from],
							days_measured: [period.from],
							days_not_measured: [],
							method_version: 'punctuality-v3',
							cleaning_versions: [12],
							query_ms: 1,
							share_observed: 0.651,
							counts: { scheduled: 1000, classified: 651 },
							excluded: {},
						},
					},
				}),
				accessibility: Promise.resolve<EngineResult<RecordMeasure>>({ kind: 'unreachable' }),
				scorecard: {
					...waiting.scorecard,
					vehicle_field_completeness: Promise.resolve<EngineResult<ScorecardAnswer>>({
						kind: 'unreachable',
					}),
				},
				health: Promise.resolve<EngineResult<DataHealthAnswer>>({
					kind: 'answer',
					answer: health as DataHealthAnswer,
				}),
				methods: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: [] }),
			},
		});
		expect(await screen.findByText(value)).toBeVisible();
		expect(screen.getByText(sentence)).toBeVisible();
		expect(screen.getByRole('heading', { name: publishes })).toBeVisible();
		expect(await screen.findByText(notCollected)).toBeVisible();
		expect(screen.getByRole('link', { name: official })).toHaveAttribute(
			'href',
			'https://example.test/alerts',
		);
		// Transit's own files come last, in plain words.
		const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
		expect(headings.indexOf(publishes)).toBeLessThan(
			headings.indexOf(locale === 'fr' ? 'Jours dans le bilan' : 'Days in the record'),
		);
		expect(document.body).not.toHaveTextContent(/feed diagnostics|diagnostic des flux/iu);
	},
);
