import { render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { DataHealthAnswer, EngineResult, MethodEntry } from '#lib/server/engine.ts';
import health from '../../../../e2e/clean-table-health.json';
import catalog from '../../../../e2e/method-catalog.json';
import MethodCatalog from './MethodCatalog.svelte';
import RecordDataHealth from './RecordDataHealth.svelte';

const period = { from: health.from, to: health.to };

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
	const entry = await screen.findByRole('article', { name: catalog[0].text.fr.definition });
	expect(entry).toHaveAttribute('id', catalog[0].id);
	expect(entry).toHaveTextContent(catalog[0].text.fr.exclusions);
	expect(entry).toHaveTextContent(catalog[0].text.fr.limits);
	expect(entry).toHaveTextContent(/45/);
	expect(screen.getByText(/calcul précédent/)).toBeVisible();
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
