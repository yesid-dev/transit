<script lang="ts">
	import type { StampProps } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type {
		EngineResult,
		RecordAnswer,
		RecordMeasure,
		RecordSeries,
	} from '#lib/server/engine.ts';
	import { countedUnit } from '#lib/site/presenter.ts';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import type { RecordWaitingShape } from '../record/RecordSkeleton.svelte';
	import { lastGoodNote, recordConnection } from '../record/recordText.ts';

	let {
		answer,
		title,
		locale,
		stamp,
		reading,
		control,
		id,
		fill = false,
		waiting,
	}: {
		answer: Promise<EngineResult<RecordAnswer>>;
		title: string;
		locale: Locale;
		stamp: StampProps;
		reading: Snippet<[RecordMeasure | RecordSeries]>;
		control?: Snippet;
		id: string;
		fill?: boolean;
		waiting?: RecordWaitingShape;
	} = $props();

	function sample(result: RecordMeasure | RecordSeries) {
		const values = (key: string) => {
			if (!('cells' in result)) return result.evidence.counts[key] ?? null;
			const counts = result.cells.flatMap((cell) => cell.evidence.counts[key] ?? []);
			return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
		};
		const events = values('classified');
		const trips = values('eligible');
		return [
			events != null ? countedUnit(events, 'event', locale) : null,
			trips != null ? countedUnit(trips, 'trip', locale) : null,
			countedUnit(result.evidence.days_included.length, 'day', locale),
		]
			.filter(Boolean)
			.join(', ');
	}
</script>

<section {id} class="grid min-w-0">
	<RecordCard {title} {stamp} {fill} interactive={!!control}>
		{#await answer}
			{#key answer}<RecordPending {locale} {answer} shape={waiting} />{/key}
		{:then result}
			{#if result.kind === 'busy'}<RecordPending {locale} busy />
			{:else if result.kind !== 'answer'}<p>{recordConnection.unreachable[locale]}</p>
			{:else if !('rows' in result.answer)}
				{@render reading(result.answer)}
				{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
			{/if}
		{/await}
		{#snippet evidence()}
			{#await answer then result}
				{#if result.kind === 'answer' && !('rows' in result.answer)}
					<RecordEvidenceLine
						evidence={result.answer.evidence}
						sample={sample(result.answer)}
						{locale}
					/>
				{/if}
			{/await}
		{/snippet}
		{#snippet toggle()}
			{#await answer then result}
				{#if result.kind === 'answer' && !('rows' in result.answer)}
					{#if control}{@render control()}{/if}
				{/if}
			{/await}
		{/snippet}
	</RecordCard>
</section>
