<script lang="ts">
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import RecordDataHealth from '#lib/features/record/RecordDataHealth.svelte';
	import HealthStatus from '#lib/features/health/HealthStatus.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.url.href));
</script>

{#if data.view === 'record'}
	<RecordDataHealth {locale} {url} record={data.record} />
{:else if data.v1}
	<HealthStatus
		manifest={data.v1.manifest}
		provenanceSeed={data.provenanceSeed ?? undefined}
		dataHealthSeed={data.dataHealthSeed ?? undefined}
		historicAvailabilitySeed={data.historicAvailabilitySeed ?? undefined}
	/>
{/if}
