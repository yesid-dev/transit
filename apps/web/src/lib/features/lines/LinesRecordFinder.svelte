<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Surface } from '@yesid/ui/layout';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { createLineDirectory } from '#lib/site/lineDirectory.ts';
	import { routeNameFallback } from '#lib/site/nameFallback.ts';
	import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
	import type { LinesRecord } from '#lib/server/finderRecord.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import FinderRecordActions from '#lib/features/record/FinderRecordActions.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordLineLabel from '#lib/features/record/RecordLineLabel.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import {
		finderCells,
		finderRecordUrl,
		finderShare,
		finderTrips,
		type FinderResult,
	} from '#lib/features/record/finderText.ts';
	import {
		choose,
		lastGoodNote,
		pooledDays,
		punctualityWeighting,
		recordConnection,
		tally,
	} from '#lib/features/record/recordText.ts';
	import { dateRange } from '#lib/site/presenter.ts';

	let {
		locale,
		url,
		record,
		routes,
		provider = null,
	}: {
		locale: Locale;
		url: URL;
		record: LinesRecord;
		routes: RouteIndexEntry[];
		provider?: PublicCity | null;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Lines', 'Lignes'));
	const tableTitle = $derived(t('Line performance', 'Performance des lignes'));
	const noLiveTitle = $derived(t('Lines without live data', 'Lignes sans données en direct'));
	const noLive = $derived(t('No live data', 'Aucune donnée en direct'));
	const unknown = $derived(t('Unknown', 'Inconnu'));
	const pinned = $derived(finderRecordUrl(url, record.city, record.period));
	const directory = $derived(
		createLineDirectory(routes, {
			line: (id) => routeNameFallback(id, locale),
		}),
	);
	const collator = $derived(intl.collator(locale, { numeric: true, sensitivity: 'base' }));
	const headers = $derived([
		t('Line', 'Ligne'),
		t('On-time share', 'Part à l’heure'),
		t('Late share', 'Part en retard'),
		t('Trips run of scheduled', 'Trajets effectués sur prévus'),
		t('Classified stop events', 'Passages classés'),
	]);

	let sort = $state<'line' | 'onTime' | 'late' | 'trips'>('line');
	let punctuality = $state.raw<FinderResult | null>(null);
	let trips = $state.raw<FinderResult | null>(null);
	$effect(() => {
		const pending = record.punctuality;
		let current = true;
		punctuality = null;
		void pending.then((answer) => {
			if (current) punctuality = answer;
		});
		return () => {
			current = false;
		};
	});
	$effect(() => {
		const pending = record.trips;
		let current = true;
		trips = null;
		void pending.then((answer) => {
			if (current) trips = answer;
		});
		return () => {
			current = false;
		};
	});
	const punctualityCells = $derived(finderCells(punctuality, 'line'));
	const tripCells = $derived(finderCells(trips, 'line'));
	const ids = $derived(
		new Set([...routes.map((route) => route.id), ...punctualityCells.keys(), ...tripCells.keys()]),
	);
	const all = $derived(
		[...ids]
			.map((id) => {
				const timing = punctualityCells.get(id);
				const delivery = tripCells.get(id);
				return {
					id,
					number: directory.number(id),
					label: directory.name(id).label,
					href: carryFrameState(
						localizeHref(routeFor({ kind: 'line', id }), locale, record.city),
						pinned,
					),
					noLive:
						(timing?.state ?? delivery?.state) === 'no_live_data' ||
						(!timing && !delivery && lineIsScheduleOnly(provider, id, directory.type(id))),
					onTime: finderShare(timing, punctuality, 'on_time', locale),
					late: finderShare(timing, punctuality, 'late', locale),
					trips: finderTrips(delivery, trips, locale),
					ran: delivery?.evidence.counts.ran ?? null,
					scheduled: delivery?.evidence.counts.scheduled ?? null,
					count: timing?.evidence.counts.classified ?? null,
					onTimeCount: timing?.evidence.counts.on_time ?? null,
					lateCount: timing?.evidence.counts.late ?? null,
				};
			})
			.sort((a, b) => collator.compare(a.number, b.number) || collator.compare(a.id, b.id)),
	);
	const scheduleOnly = $derived(all.filter((row) => row.noLive));
	const measured = $derived(
		all
			.filter((row) => !row.noLive)
			.sort((a, b) => {
				if (sort === 'line') return 0;
				const av = a[sort].value;
				const bv = b[sort].value;
				if (av == null) return bv == null ? 0 : 1;
				if (bv == null) return -1;
				return sort === 'late' ? bv - av : av - bv;
			}),
	);
	const sources = $derived(
		[punctuality, trips].flatMap((result) =>
			result?.kind === 'answer' ? [result.answer.evidence] : [],
		),
	);
</script>

{#snippet lineLink(row: (typeof all)[number])}
	<a class="inline-flex min-h-11 flex-wrap items-center gap-x-1" href={row.href}>
		<RecordLineLabel
			label={row.label}
			code={directory.name(row.id).number}
			scheduleOnly={row.noLive}
		/>
	</a>
{/snippet}

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<h1>{title}</h1>
			<p>{dateRange(record.period, locale)}</p>
			<p>{punctualityWeighting[locale]}</p>
			{#if record.period.from !== record.period.to}<p>{pooledDays[locale]}</p>{/if}
		</header>
		<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
			<section
				id="line-performance"
				aria-labelledby="line-performance-title"
				class="grid min-w-0 gap-3"
			>
				<h2 id="line-performance-title">{tableTitle}</h2>
				{#if !punctuality || !trips}
					{#key record}<RecordPending {locale} />{/key}
				{/if}
				{#each [punctuality, trips] as result, index (index)}
					{#if result?.kind === 'answer'}
						{#if result.lastGood}<p>{headers[index === 0 ? 1 : 3]}. {lastGoodNote[locale]}</p>{/if}
						{#if result.answer.coverage_note}<p>{result.answer.coverage_note[locale]}</p>{/if}
					{:else if result}
						<StateNotice
							presentation="frameless"
							title={`${headers[index === 0 ? 1 : 3]}. ${recordConnection[result.kind][locale]}`}
						/>
					{/if}
				{/each}
				{#if measured.length}
					<label class="flex flex-wrap items-center gap-2">
						{t('Sort by', 'Trier par')}
						<select
							bind:value={sort}
							class="min-h-11 rounded border border-border bg-background px-2"
						>
							<option value="line">{headers[0]}</option>
							<option value="onTime">{headers[1]}</option>
							<option value="late">{headers[2]}</option>
							<option value="trips">{headers[3]}</option>
						</select>
					</label>
					<RecordTable
						title={tableTitle}
						{headers}
						stack
						rows={measured.map((row) => [
							row.label,
							row.onTime.text,
							row.late.text,
							row.trips.text,
							row.count == null ? unknown : tally(row.count, locale),
						])}
					>
						{#snippet rowLabel(_label, index)}{@render lineLink(measured[index]!)}{/snippet}
					</RecordTable>
					{#if punctuality && trips}
						<FinderRecordActions
							{locale}
							title={tableTitle}
							url={pinned}
							section="line-performance"
							city={record.city}
							period={record.period}
							{sources}
							headers={[
								t('Line ID', 'Identifiant de la ligne'),
								...headers.slice(0, 3),
								t('Trips run', 'Trajets effectués'),
								t('Scheduled trips', 'Trajets prévus'),
								headers[4],
								t('On-time events', 'Passages à l’heure'),
								t('Late events', 'Passages en retard'),
								t('Punctuality status', 'État de la ponctualité'),
								t('Trip status', 'État des trajets'),
							]}
							rows={measured.map((row) => [
								row.id,
								row.label,
								row.onTime.value,
								row.late.value,
								row.ran,
								row.scheduled,
								row.count,
								row.onTimeCount,
								row.lateCount,
								row.onTime.value == null ? row.onTime.text : '',
								row.trips.value == null ? row.trips.text : '',
							])}
						/>
					{/if}
				{:else if punctuality && trips}
					<p>
						{t(
							'No lines with performance records for these dates.',
							'Aucune ligne avec un bilan pour ces dates.',
						)}
					</p>
				{/if}
			</section>
		</Card>
		{#if scheduleOnly.length}
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<section
					id="lines-without-live-data"
					aria-labelledby="lines-without-live-data-title"
					class="grid min-w-0 gap-3"
				>
					<h2 id="lines-without-live-data-title">{noLiveTitle}</h2>
					<RecordTable
						title={noLiveTitle}
						headers={[headers[0], t('Status', 'État')]}
						rows={scheduleOnly.map((row) => [row.label, noLive])}
					>
						{#snippet rowLabel(_label, index)}{@render lineLink(scheduleOnly[index]!)}{/snippet}
					</RecordTable>
					<FinderRecordActions
						{locale}
						title={noLiveTitle}
						url={pinned}
						section="lines-without-live-data"
						headers={[headers[0], t('Status', 'État')]}
						rows={scheduleOnly.map((row) => [row.label, noLive])}
						city={record.city}
						period={record.period}
						{sources}
					/>
				</section>
			</Card>
		{/if}
	</div>
</Surface>
