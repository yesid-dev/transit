<script lang="ts">
	import { Stamp } from '@yesid/ui/brand';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, ScorecardAnswer } from '#lib/server/engine.ts';
	import { type CaptureSnapshot, feedState } from '#lib/live/captureSnapshot.ts';
	import LiveCapture from '#lib/live/LiveCapture.svelte';
	import {
		healthFeedName,
		captureAge,
		captureCadence,
		captureSize,
		liveStampAge,
		recordRatio,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import {
		networkMeasures,
		type NetworkMeasure,
		networkRows,
	} from '../network/networkRecordText.ts';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordTable from '../record/RecordTable.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { choose, lastGoodNote, recordConnection, tally } from '../record/recordText.ts';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import { countedUnit, dateRange, methodEvidence } from '#lib/site/presenter.ts';

	let diagnosticsExpanded = $state<boolean>();

	let {
		city,
		capture,
		diagnostics,
		subject,
		operator,
		locale,
		url,
	}: {
		city: string | null;
		capture: Promise<CaptureSnapshot | null>;
		diagnostics: {
			period: { from: string; to: string };
			city: string;
			sections: { measure: NetworkMeasure; answer: Promise<EngineResult<ScorecardAnswer>> }[];
		} | null;
		subject: string;
		operator: string;
		locale: Locale;
		url: URL;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const table = $derived(t('Each feed, at its last capture', 'Dernière collecte de chaque flux'));
	const diagnosticsTitle = $derived(
		t('Feed diagnostics for the selected dates', 'Diagnostic des flux pour les dates choisies'),
	);
	const hold = $derived(
		t(
			'A late feed is held: the screens keep showing what was last received, and say so.',
			'Si un flux est en retard, les écrans conservent les dernières données reçues et le signalent.',
		),
	);
	const pinned = $derived.by(() => {
		const link = new URL(url.pathname.replace(/\/status$/, '/network'), url);
		if (diagnostics) link.searchParams.set('provider', diagnostics.city);
		return new URL(
			frameHref(link, {
				mode: 'record',
				period: diagnostics && { ...diagnostics.period, preset: null },
			}),
			url,
		);
	});
	const labels = $derived({
		live: t('Fresh', 'À jour'),
		stale: t('Late', 'En retard'),
		no_live_data: t('No live data', 'Aucune donnée en direct'),
		refresh_unavailable: t('Refresh unavailable', 'Actualisation indisponible'),
		not_tracked: t('Not tracked', 'Non suivi'),
		unknown: t('Unknown', 'Inconnu'),
		not_measured: t('Not measured', 'Non mesuré'),
	});

	function reading(
		snapshot: CaptureSnapshot | null,
		now: number,
	): {
		id: string;
		name: string;
		age: string | null;
		cadence: string | null;
		size: string | null;
		state: ReturnType<typeof feedState>;
	}[] {
		return Object.entries(snapshot?.feeds ?? {}).map(([id, feed]) => ({
			id,
			name: healthFeedName(feed.family, locale),
			age: captureAge(feed.captured_at, now, locale),
			cadence: captureCadence(feed.expected_every_seconds, locale),
			size: captureSize(feed.bytes, locale),
			state: feedState(feed, now),
		}));
	}
	type FeedRow = {
		id: string;
		label: string;
		age: string;
		cadence: string;
		size: string;
		state: string;
	};
	const feedColumns = $derived<DataTableColumn<FeedRow>[]>([
		{ key: 'age', header: t('Last capture', 'Dernière collecte'), cell: ageCell },
		{ key: 'cadence', header: t('Expected', 'Fréquence prévue'), cell: cadenceCell },
		{ key: 'size', header: t('Size', 'Taille'), numeric: true, cell: sizeCell },
		{ key: 'state', header: t('State', 'État'), cell: stateCell },
	]);
</script>

{#snippet ageCell(row: FeedRow)}{row.age}{/snippet}
{#snippet cadenceCell(row: FeedRow)}{row.cadence}{/snippet}
{#snippet sizeCell(row: FeedRow)}{row.size}{/snippet}
{#snippet stateCell(row: FeedRow)}{row.state}{/snippet}

{#snippet diagnosticsGroup()}
	{#if diagnostics}
		{@const stamp = { kind: 'record' as const, label: recordStamp(diagnostics.period, locale) }}
		<RecordGroup>
			<RecordCard
				title={diagnosticsTitle}
				bind:open={diagnosticsExpanded}
				disclosure={{
					id: 'feed-diagnostics',
					initiallyOpen: Object.hasOwn(networkMeasures, url.hash.slice(1)),
				}}
			>
				{#if diagnosticsExpanded ?? Object.hasOwn(networkMeasures, url.hash.slice(1))}
					<div class="grid min-w-0 gap-4">
						<DashboardGrid gutter={false} minTile="32rem">
							{#each diagnostics.sections as { measure, answer } (measure)}
								{@const copy = networkMeasures[measure]}
								{@const title = t(...copy.title)}
								<section id={measure} class="min-w-0">
									<div class="grid gap-4">
										<header class="flex flex-wrap justify-between gap-2">
											<h3 class="text-subheading font-semibold">{title}</h3>
											<Stamp {...stamp} />
										</header>
										{#await answer}
											{#key answer}<RecordPending {locale} {answer} />{/key}
										{:then result}
											{#if result.kind === 'answer'}
												{@const minimum = result.answer.info.find(
													(entry) => entry.id === measure,
												)?.minimum_sample}
												{@const states = Object.values(
													result.answer.evidence.dimension_states[measure] ?? {},
												)}
												<RecordTable
													{title}
													{...networkRows(measure, result.answer, locale)}
													stack
												/>
												{#if minimum != null && (result.answer.state === 'too_few_to_judge' || states.includes('too_few_to_judge'))}
													<p class="mt-2 text-small text-muted-foreground">
														{measure === 'prediction_error'
															? t(
																	`At least ${tally(minimum, locale)} observed arrivals per lead time.`,
																	`Au moins ${tally(minimum, locale)} arrivées observées par temps d’avance.`,
																)
															: t(
																	`At least ${tally(minimum, locale)} samples per reading.`,
																	`Au moins ${tally(minimum, locale)} observations par résultat.`,
																)}
													</p>
												{/if}
												{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
											{:else if result.kind === 'busy'}<RecordPending {locale} busy />
											{:else}<p>{recordConnection.unreachable[locale]}</p>{/if}
										{/await}

										{#await answer then result}
											{#if result.kind === 'answer'}
												<RecordEvidenceLine
													{locale}
													evidence={result.answer.evidence}
													sample={countedUnit(
														result.answer.evidence.days_included.length,
														'day',
														locale,
													)}
												/>
											{/if}
										{/await}
									</div>
								</section>
							{/each}
						</DashboardGrid>
						<RecordActionGroup
							{locale}
							href={url.href}
							files={diagnostics.sections.map(({ measure }) => ({
								label: t(...networkMeasures[measure].title),
								href: recordSectionLinks(pinned, measure).csv,
							}))}
						>
							{#snippet citation()}
								{#each diagnostics.sections as { measure, answer } (measure)}
									{#await answer then result}
										{#if result.kind === 'answer'}
											{@const { evidence } = result.answer}
											<p>
												Transit · {subject}. {t(...networkMeasures[measure].title)}. {dateRange(
													{ from: evidence.start_date, to: evidence.end_date },
													locale,
												)}. {methodEvidence(evidence, locale)}
												{result.lastGood ? lastGoodNote[locale] : ''}
												{recordSectionLinks(pinned, measure).share}
											</p>
										{/if}
									{/await}
								{/each}
							{/snippet}
						</RecordActionGroup>
					</div>
				{/if}
			</RecordCard>
		</RecordGroup>
	{/if}
{/snippet}

<RecordScreen class="min-w-0">
	<RecordGroup
		><ScreenTitle title={t('Data health', 'Santé des données')} subtitle={subject} /></RecordGroup
	>
	<div data-slot="screen-content">
		<LiveCapture {capture} {city}>
			{#snippet pending()}
				<RecordGroup
					><div data-slot="screen-answer">
						<p role="status">{t('Checking live feeds…', 'Vérification des flux en direct…')}</p>
					</div></RecordGroup
				>{/snippet}
			{#snippet children(snapshot, now)}
				{@const feeds = reading(snapshot, now)}
				{@const schedule = snapshot?.schedule}
				{@const fresh = feeds.filter((feed) => feed.state === 'live')}
				{@const lastCapture = Object.values(snapshot?.feeds ?? {})
					.flatMap((feed) => feed.captured_at ?? [])
					.sort((left, right) => Date.parse(left) - Date.parse(right))
					.at(-1)}
				{@const publicationAge = snapshot
					? Math.max(0, (now - Date.parse(snapshot.published_at)) / 1000)
					: null}
				{@const late = feeds
					.filter((feed) => feed.state === 'stale')
					.map((feed) => feed.name)
					.join(', ')}
				{@const stamp = snapshot
					? {
							kind: 'live' as const,
							label: liveStampAge(publicationAge, locale),
						}
					: undefined}
				<RecordGroup>
					<div data-slot="screen-answer">
						<RecordAnswer
							{locale}
							value={feeds.length ? recordRatio(fresh.length, String(feeds.length), locale) : null}
							state={feeds.length ? undefined : 'no_live_data'}
							sentence={feeds.length
								? late
									? t(`feeds are fresh. Late: ${late}.`, `flux sont à jour. En retard : ${late}.`)
									: t('feeds are fresh.', 'flux sont à jour.')
								: labels.no_live_data}
							time={stamp}
						>
							{#snippet meta()}
								{#if feeds.length}
									<p>
										{t(
											'A count of feeds at their last capture.',
											'Le nombre de flux à leur dernier relevé.',
										)}
									</p>
								{/if}
							{/snippet}
						</RecordAnswer>
					</div>
					<div class="grid min-w-0 gap-4">
						<RecordCard title={table} {stamp}>
							{#if feeds.length || schedule}
								<RecordDataTable
									{locale}
									title={table}
									rowHeader={t('Feed', 'Flux')}
									columns={feedColumns}
									rows={[
										...feeds.map(({ id, name, age, cadence, size, state }) => ({
											id: 'feed:' + id,
											label: name,
											age: age ?? labels.unknown,
											cadence: cadence ?? labels.not_measured,
											size: size ?? labels.not_measured,
											state:
												state === 'stale' && age
													? t(`Late: last received ${age}`, `En retard : dernière réception ${age}`)
													: labels[state],
										})),
										...(schedule
											? [
													{
														id: 'schedule',
														label: t('Schedule', 'Horaire'),
														age: captureAge(schedule.captured_at, now, locale) ?? labels.unknown,
														cadence: t(
															'when the agency publishes',
															'à la publication par l’agence',
														),
														size: captureSize(schedule.bytes, locale) ?? labels.not_measured,
														state: schedule.effective_date
															? t('In use', 'En vigueur')
															: labels.not_measured,
													},
												]
											: []),
									]}
									scrollMinWidth="24rem"
								/>
								<p class="mt-3 text-small text-muted-foreground">{hold}</p>
							{:else}<StateMark state="no_live_data" {locale} />{/if}
						</RecordCard>
					</div>
				</RecordGroup>
				{@render diagnosticsGroup()}
				<RecordGroup>
					<AboutLiveFigures
						{locale}
						{operator}
						scope={t(
							'The state of each feed at its last capture.',
							'L’état de chaque flux à son dernier relevé.',
						)}
						statusLabel={t('How a feed gets its state', 'Comment est déterminé l’état d’un flux')}
						definition={t(
							'A feed is fresh while its latest capture is within its freshness window.',
							'Un flux reste à jour tant que son dernier relevé respecte le délai de fraîcheur.',
						)}
						captureText={captureAge(lastCapture ?? null, now, locale) ?? labels.no_live_data}
					/>
				</RecordGroup>
			{/snippet}
		</LiveCapture>
	</div>
</RecordScreen>
