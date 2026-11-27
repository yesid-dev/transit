<script lang="ts">
	import AlertsScreen from '#lib/features/alerts/AlertsScreen.svelte';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const readings = recoverReadings(
		() => data.alertRecord,
		({ period, city }) =>
			period ? { screen: 'alerts', from: period.from, to: period.to, city } : null,
	);
	const alertRecord = $derived(readings() ?? data.alertRecord);
</script>

{#key JSON.stringify([data.providerId, data.alertRecord.mode])}
	<AlertsScreen data={alertRecord} locale={data.lang} />
{/key}
