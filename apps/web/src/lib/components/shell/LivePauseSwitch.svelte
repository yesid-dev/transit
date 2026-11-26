<!--
  "Pause live updates" (WCAG 2.2.2): one switch in the Controls rail of every Live view. It stops
  the timed refresh, the ticking ages and the map's motion for this tab; the state is announced
  politely. The kit has no Switch part yet, so a kit Button carries role="switch".
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '@yesid/ui/button';
	import type { Locale } from '#lib/i18n/index.ts';
	import { livePause } from '#lib/live/livePause.ts';
	import { stampCopy } from '#lib/v1/stamp.copy.ts';

	let { locale }: { locale: Locale } = $props();
	const copy = $derived(stampCopy[locale]);
	let announcement = $state('');

	onMount(() => livePause.restore());

	function toggle() {
		const paused = !livePause.paused;
		livePause.set(paused);
		announcement = paused ? copy.pausedStatus : copy.resumedStatus;
	}
</script>

<Button
	variant={livePause.paused ? 'default' : 'outline'}
	size="cta-sm"
	wrap
	class="min-h-11 w-full max-w-full justify-between"
	role="switch"
	aria-checked={livePause.paused}
	data-slot="live-pause"
	onclick={toggle}
>
	<span class="text-left">{copy.pause}</span>
	<span aria-hidden="true" class="shrink-0 font-mono text-xs whitespace-nowrap uppercase"
		>{livePause.paused ? copy.switchOn : copy.switchOff}</span
	>
</Button>
<p class="sr-only" role="status" aria-live="polite" data-slot="live-pause-status">
	{announcement}
</p>
