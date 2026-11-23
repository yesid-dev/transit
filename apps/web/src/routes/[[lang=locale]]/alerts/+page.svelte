<script lang="ts">
	import AlertHistory from '#lib/features/alerts/AlertHistory.svelte';
	import AlertsRecord from '#lib/features/alerts/AlertsRecord.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

{#if data.alertRecord}
	<AlertsRecord data={data.alertRecord} locale={data.lang} />
{:else}
	<AlertHistory manifest={data.v1?.manifest} />
{/if}
