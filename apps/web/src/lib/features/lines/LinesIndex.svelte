<script lang="ts">
	import { page } from '$app/state';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import LinesDirectory from './LinesDirectory.svelte';

	/**
	 * The directory's owner: its state lives in the URL, and its evidence cache belongs to one
	 * publication. A provider change is a navigation, and a data refresh bumps the epoch, so both
	 * remount the inner directory instead of letting a previous provider's or an older response's
	 * figures stay on screen. The URL is the source of truth, so the remount keeps the view.
	 */
	const runtime = getV1Runtime();
	const provider = $derived(page.url.searchParams.get('provider') ?? '');
</script>

{#key `${provider}|${runtime.refresh.epoch}`}
	<LinesDirectory />
{/key}
