<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { loadLineRecord } from '#lib/server/lineRecord.ts';
	import { recordStamp } from '#lib/site/presenter.ts';
	import RecordPending from '../record/RecordPending.svelte';
	import LineRecordSchedule from './LineRecordSchedule.svelte';

	let {
		record,
		locale,
		url,
		headsigns,
		reserve = false,
	}: {
		record: ReturnType<typeof loadLineRecord>;
		locale: Locale;
		url: URL;
		headsigns: Record<number, string>;
		/**
		 * Keep the card's room while it loads. Only where it is the first reading under the answer
		 * (a timetable-only line): further down, content above it streams in and a tall waiting
		 * card would only move more of the screen.
		 */
		reserve?: boolean;
	} = $props();
	const frequencyAnswer = $derived(
		record.sections.find(({ section }) => section === 'frequency')!.answer,
	);
	const boundariesAnswer = $derived(
		record.sections.find(({ section }) => section === 'boundaries')!.answer,
	);
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
</script>

<div id="schedule" class="min-w-0">
	{#await frequencyAnswer}
		{#key frequencyAnswer}<div class={{ 'schedule-waiting': reserve }}>
				<RecordPending {locale} answer={frequencyAnswer} />
			</div>{/key}
	{:then frequency}
		{#await boundariesAnswer}
			{#key boundariesAnswer}<div class={{ 'schedule-waiting': reserve }}>
					<RecordPending {locale} answer={boundariesAnswer} />
				</div>{/key}
		{:then boundaries}
			{@const retry = [frequency, boundaries].flatMap((result) =>
				result.kind === 'unreachable' && result.retry ? [result.retry] : [],
			)}
			{#if frequency.kind === 'busy' || boundaries.kind === 'busy'}
				<RecordPending {locale} busy />
			{/if}
			{#key url.search}
				<LineRecordSchedule
					frequency={frequency.kind === 'answer' && 'value' in frequency.answer
						? frequency.answer
						: undefined}
					boundaries={boundaries.kind === 'answer' && 'cells' in boundaries.answer
						? boundaries.answer
						: undefined}
					{locale}
					{stamp}
					{headsigns}
					direction={record.direction}
					directionalFrequency={record.directionalFrequency}
					day={url.searchParams.get('dayType') ?? url.searchParams.get('day_type')}
					unavailable={[frequency, boundaries].some(
						({ kind }) => kind !== 'answer' && kind !== 'busy',
					)}
					busy={frequency.kind === 'busy' || boundaries.kind === 'busy'}
					retry={retry.length ? () => retry.forEach((read) => read()) : undefined}
				/>
			{/key}
		{/await}
	{/await}
</div>

<style>
	/* The schedule card keeps about its height while its readings load, so the cards under it do
	   not jump when it fills (measured on the métro and bus lines). */
	.schedule-waiting {
		min-block-size: min(42rem, calc(100dvh - var(--app-frame-header-height, 0px)));
	}
	@media (min-width: 40rem) {
		.schedule-waiting {
			min-block-size: 36rem;
		}
	}
	@media (min-width: 80rem) {
		.schedule-waiting {
			min-block-size: 30rem;
		}
	}
</style>
