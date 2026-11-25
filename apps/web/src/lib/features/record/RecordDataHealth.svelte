<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { HourGrid, type HourGridCell } from '@yesid/ui/chart';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { DataHealthAnswer, EngineResult, MethodEntry } from '#lib/server/engine.ts';
	import { carryFrameState, frameHref, RECORD_START } from '#lib/site/frameState.ts';
	import {
		dateRange,
		countedUnit,
		longDate,
		recordStamp,
		singularCount,
		versionNumber,
		healthTableDays,
	} from '#lib/site/presenter.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import { healthReading, tableName } from './dataHealthText.ts';
	import RecordActionGroup from './RecordActionGroup.svelte';
	import RecordAnswer from './RecordAnswer.svelte';
	import AboutFigures from './AboutFigures.svelte';
	import RecordCard from './RecordCard.svelte';
	import RecordDataTable, { type RecordTableRow } from './RecordDataTable.svelte';
	import RecordEvidenceLine from './RecordEvidenceLine.svelte';
	import RecordPending from './RecordPending.svelte';
	import ScreenTitle from './ScreenTitle.svelte';
	import StateMark from './StateMark.svelte';
	import { recordSectionLinks } from './recordLinks.ts';
	import { choose, lastGoodNote, recordConnection, tally } from './recordText.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';

	let {
		locale,
		url,
		record,
		subject = '',
		operator = '',
	}: {
		locale: Locale;
		url: URL;
		record: {
			city: string;
			period: DateWindow;
			health: Promise<EngineResult<DataHealthAnswer>>;
			methods: Promise<EngineResult<MethodEntry[]>>;
		} | null;
		subject?: string;
		operator?: string;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const term = $derived(overviewCopy[locale]);
	const title = $derived(t('Data health', 'Santé des données'));
	const dailyTitle = $derived(
		t('Each clean table, day by day', 'État des tables nettoyées, jour par jour'),
	);
	const methodLabel = $derived(term.method);
	const stamp = $derived(
		record ? { kind: 'record' as const, label: recordStamp(record.period, locale) } : undefined,
	);
	const pinned = $derived.by(() => {
		const selected = new URL(url.pathname, url);
		if (record) selected.searchParams.set('provider', record.city);
		return new URL(
			frameHref(selected, { mode: 'record', period: record && { ...record.period, preset: null } }),
			url,
		);
	});
	const share = $derived(recordSectionLinks(pinned, 'table-health').share);
	const methodHref = $derived(
		carryFrameState(localizeHref('/metrics', locale, record?.city), pinned),
	);

	const labels = $derived({
		present: t('Present', 'Présent'),
		missing: t('Missing: no file for that day', 'Manquant : aucun fichier pour ce jour'),
		not_measured: t('Not measured: its source was missing', 'Non mesuré : la source manquait'),
		incomplete: t('Incomplete', 'Incomplet'),
		not_tracked: t('Not tracked', 'Non suivi'),
		unknown: t('Unknown', 'Inconnu'),
	});
	const marks = {
		present: { text: '●', level: 0 },
		not_tracked: { text: '⊠', level: 1 },
		unknown: { text: '?', level: 2 },
		incomplete: { text: '◐', level: null, state: 'few' },
		missing: { text: '×', level: null, state: 'none' },
		not_measured: { text: '○', level: null, state: 'unmeasured' },
	} as const satisfies Record<string, Omit<HourGridCell, 'name'>>;
	const familiesFor = (entries: MethodEntry[]) => [
		...new Map(
			entries
				.toSorted((left, right) => left.since.localeCompare(right.since))
				.map((entry) => [entry.family, entry]),
		).values(),
	];
	const methodVersion = (entries: MethodEntry[]) =>
		versionNumber(
			(
				entries.find(({ id }) => id === 'punctuality') ??
				entries.find(({ family }) => family === 'punctuality')
			)?.method_version,
		);
	const versionText = (type: string, version: string | null) =>
		version ? `${type} ${version}` : null;
	const cleaningText = (answer: DataHealthAnswer) =>
		versionText(t('cleaning', 'nettoyage'), versionNumber(answer.cleaning_version));
	const methodText = (entries: MethodEntry[]) =>
		versionText(t('method', 'méthode'), methodVersion(entries));
	const versionsText = (answer: DataHealthAnswer, entries: MethodEntry[]) =>
		[methodText(entries), cleaningText(answer)].filter(Boolean).join(', ');
	const tablesFor = (answer: DataHealthAnswer) => [
		...new Set(answer.days.flatMap((day) => Object.keys(day.tables))),
	];

	function sample(answer: DataHealthAnswer) {
		const tables = new Set(
			answer.days.flatMap(({ tables }) =>
				Object.entries(tables).flatMap(([id, cell]) => (cell.status === 'not_tracked' ? [] : [id])),
			),
		).size;
		const days = countedUnit(answer.days.length, 'day', locale);
		return t(
			`${tally(tables, locale)} ${singularCount(tables, locale) ? 'clean table' : 'clean tables'} over ${days}`,
			`${tally(tables, locale)} ${singularCount(tables, locale) ? 'table nettoyée' : 'tables nettoyées'} sur ${days}`,
		);
	}

	function coverage(totals: ReturnType<typeof healthTableDays>) {
		const tracked = tally(totals.tracked, locale);
		const missing = tally(totals.missing, locale);
		const unmeasured = tally(totals.notMeasured, locale);
		return t(
			`of the ${tracked} table days in these dates are present. ${missing} ${totals.missing === 1 ? 'is' : 'are'} missing and ${unmeasured} could not be measured.`,
			`jours de données sur ${tracked} sont présents pour cette période. ${missing} ${singularCount(totals.missing, locale) ? 'jour manque' : 'jours manquent'} et ${unmeasured} ${singularCount(totals.notMeasured, locale) ? 'jour n’a pas pu être mesuré' : 'jours n’ont pas pu être mesurés'}.`,
		);
	}

	function grid(answer: DataHealthAnswer) {
		const days = answer.days.slice(-14);
		const tables = tablesFor(answer);
		const states = new Set<keyof typeof marks>([
			'present',
			'missing',
			'not_measured',
			...days.flatMap((day) => tables.map((id) => day.tables[id]?.status ?? 'unknown')),
		]);
		const day = intl.dateTime(locale, { day: 'numeric', timeZone: 'UTC' });
		return {
			columns: days.map(({ service_date }) => ({
				id: service_date,
				label: day.format(new Date(service_date)),
			})),
			rows: tables.map((id) => ({
				id,
				label: tableName(id, locale),
				cells: days.map((date): HourGridCell => {
					const cell = date.tables[id];
					const state = cell?.status ?? 'unknown';
					return {
						...marks[state],
						name: healthReading(cell, locale, cell?.status === 'present' ? undefined : date.reason),
					};
				}),
			})),
			from: days[0]?.service_date,
			to: days.at(-1)?.service_date,
			states,
		};
	}
</script>

<RecordScreen class="min-w-0">
	<RecordGroup><ScreenTitle {title} subtitle={subject} /></RecordGroup>
	<div data-slot="screen-content">
		<RecordGroup>
			<div class="table-days-answer" data-slot="screen-answer">
				{#if record}
					{#await record.health}
						{#key record.health}<RecordPending {locale} answer={record.health} />{/key}
					{:then result}
						{#if result.kind === 'busy'}<RecordPending {locale} busy />
						{:else if result.kind !== 'answer'}
							<RecordAnswer
								{locale}
								value={null}
								sentence={recordConnection.unreachable[locale]}
								time={stamp}
							/>
						{:else}
							{@const answer = result.answer}
							{@const totals = healthTableDays(answer.days)}
							<RecordAnswer
								{locale}
								value={totals.tracked ? tally(totals.present, locale) : null}
								state={totals.tracked ? undefined : 'not_measured'}
								sentence={totals.tracked ? coverage(totals) : t('Not measured', 'Non mesuré')}
								time={stamp}
							>
								{#snippet meta()}
									{#if totals.tracked}
										<p>{term.counted}{t(':', ' :')} {sample(answer)}</p>
									{/if}
									{#if cleaningText(answer)}<p class="font-mono">{cleaningText(answer)}</p>{/if}
									{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
								{/snippet}
								{#snippet actions()}
									<RecordActionGroup {locale} href={share} files={[]}>
										{#snippet citation()}
											<p>
												Transit. {title} ({record.city}). {dateRange(record.period, locale)}. {t(
													'Cleaning version',
													'Version du nettoyage',
												)}
												{versionNumber(answer.cleaning_version)}. {share}
											</p>
										{/snippet}
									</RecordActionGroup>
								{/snippet}
							</RecordAnswer>
						{/if}
					{/await}
				{:else}
					<RecordAnswer
						{locale}
						value={null}
						state="not_measured"
						sentence={t('Not measured', 'Non mesuré')}
					/>
				{/if}
			</div>

			{#if record}
				<section id="table-health" class="min-w-0">
					<RecordCard interactive title={dailyTitle} {stamp}>
						{#await record.health then result}
							{#if result.kind === 'answer'}
								{@const display = grid(result.answer)}
								{#if display.from && display.to && display.rows.length}
									<div class="table-days">
										<HourGrid
											label={dailyTitle}
											columns={display.columns}
											rows={display.rows}
											scale={{ label: '', steps: [] }}
											stateLabels={{ few: '', none: '', unmeasured: '' }}
										/>
										<ul
											class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground"
											role="list"
											aria-label={t('Table-day states', 'États par table et par jour')}
										>
											{#each [...display.states] as state (state)}
												<li class="flex gap-2">
													<span aria-hidden="true" class="min-w-4 text-center"
														>{marks[state].text}</span
													>
													{labels[state]}
												</li>
											{/each}
										</ul>
									</div>
									{#if result.answer.days.length > display.columns.length}
										<p class="mt-3 text-small text-muted-foreground">
											{t(
												'The grid shows the last 14 days. The counts cover the full period.',
												'La grille montre les 14 derniers jours. Les totaux couvrent toute la période.',
											)}
										</p>
									{/if}
								{:else}<StateMark state="not_measured" {locale} />{/if}
							{:else if result.kind !== 'busy'}<p>{recordConnection.unreachable[locale]}</p>{/if}
						{/await}
						{#snippet evidence()}
							{#await record.health then result}
								{#if result.kind === 'answer'}
									{#await record.methods then methods}
										<RecordEvidenceLine
											{locale}
											sample={sample(result.answer)}
											versions={versionsText(
												result.answer,
												methods.kind === 'answer' ? methods.answer : [],
											)}
										/>
									{/await}
								{/if}
							{/await}
						{/snippet}
					</RecordCard>
				</section>
				<RecordCard interactive title={t('Versions in force', 'Versions en vigueur')}>
					<dl class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<div>
							<dt class="font-semibold">{t('Method', 'Méthode')}</dt>
							<dd class="font-mono">
								{#await record.methods then result}
									{(result.kind === 'answer' && methodText(result.answer)) || labels.unknown}
								{/await}
							</dd>
						</div>
						<div>
							<dt class="font-semibold">{t('Cleaning', 'Nettoyage')}</dt>
							<dd class="font-mono">
								{#await record.health then result}
									{(result.kind === 'answer' && cleaningText(result.answer)) || labels.unknown}
								{/await}
							</dd>
						</div>
						<div>
							<dt class="font-semibold">{t('Record starts', 'Début du bilan')}</dt>
							<dd>{longDate(RECORD_START, locale)}</dd>
						</div>
						<div>
							<dt class="font-semibold">{t('Rebuilt', 'Recalcul')}</dt>
							<dd>
								{t(
									'Each night, after the service day closes',
									'Chaque nuit, après la fin de la journée de service',
								)}
							</dd>
						</div>
					</dl>
					{#await record.methods}
						{#key record.methods}<RecordPending {locale} answer={record.methods} />{/key}
					{:then result}
						{#if result.kind === 'busy'}<RecordPending {locale} busy />
						{:else if result.kind !== 'answer'}<p>{recordConnection.unreachable[locale]}</p>
						{:else if result.answer.length}
							{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
							{#snippet version(row: RecordTableRow & { version: string })}{row.version}{/snippet}
							<RecordDataTable
								{locale}
								title={t('Versions in force', 'Versions en vigueur')}
								rowHeader={t('Measure family', 'Famille de mesures')}
								rows={familiesFor(result.answer).map((entry) => ({
									id: entry.family,
									label: entry.family_text?.[locale] ?? entry.family,
									href: `${methodHref}#${entry.id}`,
									version: `${t('method', 'méthode')} ${versionNumber(entry.method_version)}, ${t('since', 'depuis le')} ${longDate(entry.since, locale)}`,
								}))}
								columns={[{ key: 'version', header: t('Version', 'Version'), cell: version }]}
								value="version"
							/>
						{:else}<StateMark state="not_measured" {locale} />{/if}
					{/await}
				</RecordCard>
				<RecordCard
					interactive
					title={t('What a missing day does', 'Ce que change un jour manquant')}
				>
					<p>
						{t(
							'A day with a missing table is left out of every figure that needs it. The figure then says how many days it counted, so a gap never looks like a good day.',
							'Un jour où une table manque est exclu de chaque résultat qui en dépend. Le résultat indique ensuite combien de jours ont été comptés, pour qu’un jour sans données ne soit jamais pris pour un bon jour.',
						)}
					</p>
					{#snippet links()}
						<a class="inline-flex min-h-11 items-center text-primary underline" href={methodHref}
							>{methodLabel}</a
						>
					{/snippet}
				</RecordCard>
			{/if}
		</RecordGroup>
		{#if record && stamp}
			<RecordGroup>
				{#await record.health then health}
					{#await record.methods then methods}
						<AboutFigures
							title={term.about}
							fields={[
								{ key: 'period', label: term.period, text: dateRange(record.period, locale) },
								{
									key: 'counted',
									label: term.counted,
									text: t(
										'One reading for each clean table and service day. Tables outside the published coverage are excluded.',
										'Un état par table nettoyée et par jour de service. Les tables hors de la couverture publiée sont exclues.',
									),
								},
								{
									key: 'observed',
									label: term.observed,
									text: t(
										'The files available for each table and service day.',
										'Les fichiers disponibles pour chaque table et jour de service.',
									),
								},
								{ key: 'means', label: term.means, text: term.definition },
								{
									key: 'versions',
									label: term.versions,
									text:
										health.kind === 'answer'
											? versionsText(health.answer, methods.kind === 'answer' ? methods.answer : [])
											: null,
								},
								{
									key: 'source',
									label: term.source,
									text: operator ? term.feeds(operator) : null,
								},
							]}
							versionsLink={{ href: methodHref, label: methodLabel }}
						/>
					{/await}
				{/await}
			</RecordGroup>
		{/if}
	</div>
</RecordScreen>

<style>
	.table-days-answer :global(.answer-value) {
		flex-shrink: 0;
	}
	/* The kit's hour legend always includes all states. The table-day legend uses the visible cells. */
	.table-days :global([data-slot='hour-grid'] > ul) {
		display: none;
	}
</style>
