<script lang="ts">
	import type { Ready } from '#lib/site/ready.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { loadLineRecord } from '#lib/server/lineRecord.ts';
	import { recordStamp } from '#lib/site/presenter.ts';
	import LineRecordSchedule from './LineRecordSchedule.svelte';

	let {
		record,
		locale,
		url,
		headsigns,
	}: {
		record: Ready<ReturnType<typeof loadLineRecord>>;
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
	{#snippet loading(answer: typeof frequencyAnswer)}
		<LineRecordSchedule
			{locale}
			{stamp}
			{headsigns}
			direction={record.direction}
			directionalFrequency={null}
			pending={{ answer }}
		/>
	{/snippet}
	{#await frequencyAnswer}
		{@render loading(frequencyAnswer)}
	{:then frequency}
		{#await boundariesAnswer}
			{@render loading(boundariesAnswer)}
		{:then boundaries}
			{@const retry = [frequency, boundaries].flatMap((result) =>
				result.kind === 'unreachable' && result.retry ? [result.retry] : [],
			)}
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
				pending={frequency.kind === 'busy' || boundaries.kind === 'busy'
					? { busy: true }
					: undefined}
				retry={retry.length ? () => retry.forEach((read) => read()) : undefined}
			/>
		{/await}
	{/await}
</div>
