import { render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { DataHealthAnswer, EngineResult, MethodEntry } from '#lib/server/engine.ts';
import health from '../../../../e2e/clean-table-health.json';
import catalog from '../../../../e2e/method-catalog.json';
import MethodCatalog from './MethodCatalog.svelte';
import RecordDataHealth from './RecordDataHealth.svelte';
import { recordState } from './recordStates';

const period = { from: health.from, to: health.to };
const fixtureDelay = catalog.find(({ id }) => id === 'fixture_delay')!;

it.each([
	['en', undefined, 'method v3'],
	['en', 12, 'method v3, cleaning v12'],
	['fr', undefined, 'méthode v3'],
	['fr', 12, 'méthode v3, nettoyage v12'],
] as const)(
	'renders the method versions in %s with cleaning version %s',
	async (locale, cleaningVersion, label) => {
		render(MethodCatalog, {
			locale,
			url: new URL('https://transit1.yesid.dev/metrics'),
			city: 'stm',
			period,
			cleaningVersion,
			catalog: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: catalog }),
		});
		expect(await screen.findByText(label, { exact: true })).toBeVisible();
	},
);

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
	const trigger = await screen.findByText(fixtureDelay.text.fr.definition);
	const entry = trigger.closest('details')!;
	expect(entry).toHaveAttribute('id', fixtureDelay.id);
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
	expect(document.getElementById('early')?.querySelector('a[href="#on_time"]')).toHaveTextContent(
		'On-time share',
	);
});

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
	expect(document.querySelector('#family-vehicles > summary')).toHaveTextContent(
		'Early share by vehicle and Late share by vehicle.',
	);
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

it('renders absent readings and both not-measured reasons while methods can fail independently', async () => {
	const url = new URL('https://transit1.yesid.dev/status');
	const answer = health as DataHealthAnswer;
	let finish!: (result: EngineResult<DataHealthAnswer>) => void;
	render(RecordDataHealth, {
		locale: 'en',
		url,
		record: {
			city: health.city,
			period,
			health: new Promise<EngineResult<DataHealthAnswer>>((resolve) => {
				finish = resolve;
			}),
			methods: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'busy' }),
		},
	});
	expect(
		await screen.findByText('The record is busy right now. You can come back later.'),
	).toBeVisible();
	expect(screen.getByText('Calculating…')).toBeVisible();
	finish({ kind: 'answer', answer });
	const table = await screen.findByRole('table');
	for (const label of [
		'Present',
		'Not tracked',
		'Incomplete',
		'Missing (File size differs from the manifest)',
	]) {
		expect(within(table).getAllByRole('cell', { name: label })[0]).toBeVisible();
	}
	for (const reason of ['No raw captures', 'No schedule edition']) {
		expect(within(table).getAllByRole('cell', { name: `Not measured (${reason})` })).toHaveLength(
			3,
		);
	}
	expect(within(table).queryByRole('cell', { name: '0' })).toBeNull();
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
			city: answer.city,
			period,
			health: Promise.resolve<EngineResult<DataHealthAnswer>>({ kind: 'answer', answer }),
			methods: Promise.resolve<EngineResult<MethodEntry[]>>({ kind: 'answer', answer: [] }),
		},
	});
	const table = await screen.findByRole('table');
	const readings = within(table).getAllByRole('cell', { name: label });
	expect(readings).toHaveLength(2);
	for (const reading of readings) expect(reading).toBeVisible();
});
