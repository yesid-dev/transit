<script lang="ts">
	import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
	import RecordPending from './RecordPending.svelte';
	import RecordUnavailable from './RecordUnavailable.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { recoverRecord } from './recordRecovery.svelte.ts';

	let {
		sections,
		scope,
		locale = 'en',
	}: {
		sections: { section: string; answer: Promise<EngineResult<RecordAnswer>> }[];
		scope: string;
		locale?: Locale;
	} = $props();
	const record = $derived({ sections });
	const readings = recoverRecord(
		() => record,
		() => ({ id: scope, city: 'demo', kind: 'vehicle', from: '2026-11-17', to: '2026-11-23' }),
	);
</script>

{#each readings()?.sections ?? [] as { section, answer } (section)}
	{#await answer}
		<p>{section} pending</p>
	{:then result}
		{#if result.kind === 'answer'}<button type="button">{section}</button>
		{:else if result.kind === 'busy'}<RecordPending {locale} busy />
		{:else if result.kind === 'unreachable'}<RecordUnavailable {locale} retry={result.retry} />
		{:else}<p>{section} {result.kind}</p>{/if}
	{/await}
{/each}
