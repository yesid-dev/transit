<script lang="ts">
	import { onMount } from 'svelte';
	import { prefersReducedMotion } from '@yesid/motion/stores/reducedMotion';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Manifest, RouteFile, Vehicle } from '#lib/v1/schemas/index.ts';
	import type { VehicleMapStop } from './vehicleLocationRoute.ts';

	let {
		vehicle,
		manifest,
		route,
		next,
		previous,
		locale,
		href,
	}: {
		vehicle: Vehicle;
		manifest: Manifest;
		route: RouteFile | null;
		next?: VehicleMapStop;
		previous?: VehicleMapStop;
		locale: Locale;
		href: string;
	} = $props();

	let preview: HTMLDivElement;
	let Canvas = $state<typeof import('./VehicleMapCanvas.svelte').default>();
	let ready = $state(false);
	let unavailable = $state(false);
	const fr = $derived(locale === 'fr');

	onMount(() => {
		let active = true;
		function load() {
			void import('./VehicleMapCanvas.svelte').then(
				({ default: component }) => {
					if (active) Canvas = component;
				},
				() => {
					if (active) unavailable = true;
				},
			);
		}

		const observer = new IntersectionObserver((entries) => {
			if (!entries.some(({ isIntersecting }) => isIntersecting)) return;
			observer.disconnect();
			load();
		});
		observer.observe(preview);
		return () => {
			active = false;
			observer.disconnect();
		};
	});
</script>

<div
	bind:this={preview}
	class="vehicle-map-preview"
	data-slot="vehicle-map-preview"
	data-ripple-exempt
	data-ready={ready}
>
	{#if Canvas && !unavailable}
		<div
			class="vehicle-map-runtime absolute inset-0"
			class:invisible={!ready}
			aria-hidden={ready ? undefined : true}
			inert={!ready}
			style:transition={$prefersReducedMotion ? 'none' : undefined}
		>
			<Canvas
				{vehicle}
				{manifest}
				{route}
				{next}
				{previous}
				{locale}
				onready={() => (ready = true)}
				onrecovering={() => (ready = false)}
				onunavailable={() => {
					ready = false;
					unavailable = true;
				}}
			/>
		</div>
	{/if}
	{#if ready}
		<!-- The footer offers the same destination in the keyboard order. -->
		<a
			{href}
			class="absolute inset-0 z-10"
			tabindex="-1"
			aria-hidden="true"
			data-slot="vehicle-map-link"
		></a>
	{:else}
		<p class="m-0 text-small text-muted-foreground" role="status">
			{unavailable
				? fr
					? 'La carte est indisponible.'
					: 'The map is unavailable.'
				: fr
					? 'Chargement de la carte…'
					: 'Loading the map…'}
		</p>
	{/if}
</div>

<style>
	.vehicle-map-preview {
		position: relative;
		isolation: isolate;
		display: grid;
		place-items: center;
		min-inline-size: 0;
		block-size: 16rem;
		border-radius: var(--radius-lg);
		background-color: var(--muted);
		--map-attribution-bottom: 0.75rem;
	}

	.vehicle-map-runtime {
		transition: opacity var(--duration-normal) var(--ease-out);
	}

	.vehicle-map-preview[data-ready='false'] .vehicle-map-runtime {
		opacity: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.vehicle-map-runtime {
			transition: none;
		}
	}
</style>
