<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';

	let {
		label,
		code,
		scheduleOnly = false,
		size = 'md',
	}: {
		label: string;
		code: string | null;
		scheduleOnly?: boolean;
		size?: 'md' | 'lg';
	} = $props();
</script>

{#if code && label.startsWith(code)}
	<RoutePlate {code} {scheduleOnly} {size} />{label.slice(code.length)}
{:else}
	{label}
{/if}
