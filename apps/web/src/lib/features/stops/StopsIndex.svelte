<script lang="ts">
	import { page } from '$app/state';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import StopsFinder from './StopsFinder.svelte';

	/**
	 * The finder's owner: its state lives in the URL, and its records belong to one publication. A
	 * provider change is a navigation and a data refresh bumps the epoch, so both remount the finder
	 * instead of leaving another provider's or an older file's figures on screen. The URL keeps the
	 * view across the remount.
	 */
	const runtime = getV1Runtime();
	const provider = $derived(page.url.searchParams.get('provider') ?? '');
</script>

{#key `${provider}|${runtime.refresh.epoch}`}
	<StopsFinder />
{/key}
