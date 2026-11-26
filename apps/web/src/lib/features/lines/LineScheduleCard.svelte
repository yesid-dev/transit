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
	}: {
		record: ReturnType<typeof loadLineRecord>;
		locale: Locale;
		url: URL;
		headsigns: Record<number, string>;
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
		{#key frequencyAnswer}<RecordPending {locale} answer={frequencyAnswer} />{/key}
	{:then frequency}
		{#await boundariesAnswer}
			{#key boundariesAnswer}<RecordPending {locale} answer={boundariesAnswer} />{/key}
		{:then boundaries}
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
				/>
			{/key}
		{/await}
	{/await}
</div>
