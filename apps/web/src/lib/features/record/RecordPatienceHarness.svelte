<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordPatience from './RecordPatience.svelte';
	import RecordPending from './RecordPending.svelte';

	let { readings, locale = 'en' }: { readings: Promise<{ kind: string }>[]; locale?: Locale } =
		$props();
</script>

<RecordPatience {locale} period={{ from: '2026-11-08', to: '2026-11-14' }} scope="fixture">
	{#each readings as answer (answer)}
		{#await answer}
			<RecordPending {locale} {answer} />
		{:then result}
			{#if result.kind === 'busy'}<RecordPending {locale} busy />
			{:else}<p>{result.kind}</p>{/if}
		{/await}
	{/each}
</RecordPatience>
