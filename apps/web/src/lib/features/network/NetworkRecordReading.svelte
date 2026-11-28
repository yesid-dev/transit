<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
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
	import WaitingFoot from '../home/WaitingFoot.svelte';
	import RecordSkeleton from '../record/RecordSkeleton.svelte';
	import { skeletonBlockSize, type RecordWaiting } from '../record/recordWaiting.ts';
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
		collapseEmpty = true,
		waiting,
		more,
		after,
	}: {
		answer: Awaitable<EngineResult<RecordAnswer>>;
		title: string;
		locale: Locale;
		stamp: StampProps;
		reading: Snippet<[RecordMeasure | RecordSeries]>;
		control?: Snippet;
		id: string;
		fill?: boolean;
		/** Collapse the reserved height when settled to a non-measured/empty state. */
		collapseEmpty?: boolean;
		/** The body's final shape, drawn while it waits or the engine is busy. */
		waiting: RecordWaiting;
		/** More of the final shape under the first one, for a card in two parts. */
		more?: RecordWaiting;
		/** Parts of the card that need no answer from this reading, drawn from the first frame. */
		after?: Snippet;
	} = $props();
	const reserved = $derived(skeletonBlockSize(waiting));

	function keepsReservedHeight(result: EngineResult<RecordAnswer>) {
		if (!collapseEmpty || result.kind === 'busy') return true;
		if (result.kind !== 'answer') return false;
		if ('cells' in result.answer) {
			return result.answer.cells.some((cell) => cell.state === 'measured');
		}
		if ('value' in result.answer) {
			return result.answer.state === 'measured';
		}
		return false;
	}

	function sample(result: RecordMeasure | RecordSeries) {
		const values = (key: string) => {
			if (!('cells' in result)) return result.evidence.counts[key] ?? null;
			const counts = result.cells.flatMap((cell) => cell.evidence.counts[key] ?? []);
			return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
		};
		const events = values('classified');
		const trips = values('eligible');
		const readings = values('occupancy_readings');
		const counted = [
			events != null ? countedUnit(events, 'event', locale) : null,
			trips != null ? countedUnit(trips, 'trip', locale) : null,
			readings != null ? countedUnit(readings, 'reading', locale) : null,
		].filter(Boolean);
		// A foot says what was counted over the days; the days alone say nothing.
		if (!counted.length) return null;
		return [...counted, countedUnit(result.evidence.days_included.length, 'day', locale)].join(
			', ',
		);
	}
</script>

<section {id} class="grid min-w-0">
	<RecordCard {title} {stamp} stampRule {fill} interactive={!!control}>
		{#await answer}
			<div class="reading" class:fill style:min-block-size={reserved}>
				{#key answer}<RecordPending {locale} {answer} shape={waiting} />{/key}
				{#if more}<RecordSkeleton shape={more} />{/if}
			</div>
		{:then result}
			<div
				class="reading"
				class:fill
				style:min-block-size={keepsReservedHeight(result) ? reserved : undefined}
			>
				{#if result.kind === 'busy'}<RecordPending {locale} busy shape={waiting} />
					{#if more}<RecordSkeleton shape={more} />{/if}
				{:else if result.kind !== 'answer'}<p>{recordConnection.unreachable[locale]}</p>
				{:else if !('rows' in result.answer)}
					{@render reading(result.answer)}
					{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				{/if}
			</div>
		{/await}
		{@render after?.()}
		{#snippet evidence()}
			{#await answer}<WaitingFoot />{:then result}
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

<style>
	.reading {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		min-inline-size: 0;
	}
	.reading.fill {
		display: flex;
		flex: 1;
		flex-direction: column;
	}
</style>
