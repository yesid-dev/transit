<script lang="ts">
	import { setContext } from 'svelte';
	import { desktop } from '@yesid/ui/state';
	import {
		FrameControlsExtensionContext,
		type FrameControlsExtension,
	} from '#lib/components/shell/FrameControls.svelte';
	import type { ProgressiveMapHeroProps } from '../MapProgressive.svelte';
	import MapHero from '../MapHero.svelte';

	let props: ProgressiveMapHeroProps = $props();
	let extension = $state.raw<FrameControlsExtension>();
	setContext(FrameControlsExtensionContext, (value: FrameControlsExtension) => {
		extension = value;
		return () => {
			if (extension === value) extension = undefined;
		};
	});
</script>

<div data-ripple-exempt>
	{@render extension?.between?.()}
	{@render extension?.extra?.({
		presentation: desktop.current ? 'desktop' : 'mobile',
		closeSheet: () => {},
	})}
	{#if desktop.current}{@render extension?.after?.()}{/if}
</div>
<MapHero {...props} />
