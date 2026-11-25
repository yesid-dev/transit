<script lang="ts">
	import AlertsScreen from '#lib/features/alerts/AlertsScreen.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

{#key JSON.stringify([data.providerId, data.alertRecord.mode])}
	<AlertsScreen data={data.alertRecord} locale={data.lang} manifest={data.v1?.manifest} />
{/key}
