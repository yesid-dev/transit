<script lang="ts">
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import type { StopsRecord } from '#lib/server/finderRecord.ts';
	import FinderRecordActions from '#lib/features/record/FinderRecordActions.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import {
		finderCells,
		finderRecordUrl,
		finderShare,
		type FinderResult,
	} from '#lib/features/record/finderText.ts';
	import {
		choose,
		lastGoodNote,
		recordConnection,
		tally,
	} from '#lib/features/record/recordText.ts';
	import type { FinderRow } from './finderState.ts';

	let {
		record,
		locale,
		url,
		stops,
		stopMeta,
		noLiveData,
	}: {
		record: StopsRecord;
		locale: Locale;
		url: URL;
		stops: FinderRow[];
		stopMeta: (row: FinderRow) => string;
		noLiveData: (stop: FinderRow['stop']) => boolean;
	} = $props();

	let result = $state.raw<FinderResult | null>(null);
	$effect(() => {
		const pending = record.punctuality;
		let current = true;
		result = null;
		void pending.then((answer) => {
			if (current) result = answer;
		});
		return () => {
			current = false;
		};
	});
	const cells = $derived(finderCells(result, 'stop'));
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Stop results', 'Résultats de recherche d’arrêts'));
	const headers = $derived([
		t('Stop', 'Arrêt'),
		t('Stop details', 'Détails de l’arrêt'),
		t('On-time share', 'Part à l’heure'),
		t('Classified stop events', 'Passages classés'),
	]);
	const pinned = $derived(finderRecordUrl(url, record.city, record.period));
	const rows = $derived(
		stops.map((row) => {
			const cell = cells.get(row.stop.id);
			const reading =
				!cell && noLiveData(row.stop)
					? { text: t('No live data', 'Aucune donnée en direct'), value: null }
					: finderShare(cell, result, 'on_time', locale);
			return {
				name: stopDisplayName(row.stop.name),
				id: row.stop.id,
				code: row.stop.code ?? '',
				meta: stopMeta(row),
				reading,
				count: cell?.evidence.counts.classified ?? null,
				onTime: cell?.evidence.counts.on_time ?? null,
				href: carryFrameState(
					localizeHref(routeFor({ kind: 'stop', id: row.stop.id }), locale, record.city),
					pinned,
				),
			};
		}),
	);
</script>

<section id="stop-results" aria-labelledby="stop-results-title" class="grid min-w-0 gap-3">
	<h2 id="stop-results-title">{title}</h2>
	{#if !result}
		{#key record}<RecordPending {locale} />{/key}
	{:else if result.kind === 'answer'}
		{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
		{#if result.answer.coverage_note}<p>{result.answer.coverage_note[locale]}</p>{/if}
	{:else}
		<p>{recordConnection[result.kind][locale]}</p>
	{/if}
	<RecordTable
		{title}
		{headers}
		stack
		rowHrefs={rows.map((row) => row.href)}
		rows={rows.map((row) => [
			row.name,
			row.meta,
			row.reading.text,
			row.count == null ? t('Unknown', 'Inconnu') : tally(row.count, locale),
		])}
	/>
	{#if result}
		<FinderRecordActions
			{locale}
			{title}
			url={pinned}
			section="stop-results"
			city={record.city}
			period={record.period}
			sources={result.kind === 'answer' ? [result.answer.evidence] : []}
			headers={[
				t('Stop ID', 'Identifiant de l’arrêt'),
				t('Code', 'Code'),
				headers[0],
				...headers.slice(2),
				t('On-time events', 'Passages à l’heure'),
				t('Status', 'État'),
			]}
			rows={rows.map((row) => [
				row.id,
				row.code,
				row.name,
				row.reading.value,
				row.count,
				row.onTime,
				row.reading.value == null ? row.reading.text : '',
			])}
		/>
	{/if}
</section>
