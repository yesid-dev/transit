<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import { SurfaceRail, type SurfaceRailProps } from '@yesid/ui/layout';
	import { frameSurfaceRailContext, type RegisterFrameSurfaceRail } from './frameSurfaceRail.ts';

	let props: SurfaceRailProps = $props();
	const register = getContext<RegisterFrameSurfaceRail | undefined>(frameSurfaceRailContext);
	$effect(() => {
		const rail = props.rail;
		return untrack(() => register?.(rail));
	});
</script>

<SurfaceRail {...props} mobileVisible={register ? false : props.mobileVisible} />
