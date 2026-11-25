<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import { StillMap } from '@yesid/ui/map';
	import type { Coord } from '#lib/components/map/polyline.ts';
	import type { Locale } from '#lib/i18n/index.ts';

	type Point = { lat: number; lon: number };
	type Stop = Point & { name: string };

	let {
		vehicle,
		line,
		next,
		previous,
		shape,
		locale,
	}: {
		vehicle: Point;
		line?: string;
		next?: Stop;
		previous?: Stop;
		shape: readonly Coord[] | null;
		locale: Locale;
	} = $props();
	const fr = $derived(locale === 'fr');
	const markers = $derived([
		...(previous
			? [{ ...previous, kind: 'previous', label: fr ? 'Arrêt quitté' : 'Stop it left' }]
			: []),
		...(next ? [{ ...next, kind: 'next', label: fr ? 'Prochain arrêt' : 'Next stop' }] : []),
		{ ...vehicle, kind: 'vehicle', name: '', label: fr ? 'Ce véhicule' : 'This vehicle' },
	]);
	const finite = $derived(
		markers.every(({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon)),
	);
	const projected = $derived.by(() => {
		const ratio = Math.cos((vehicle.lat * Math.PI) / 180);
		const local = ({ lon, lat }: Point) => ({
			x: (lon - vehicle.lon) * ratio,
			y: vehicle.lat - lat,
		});
		const points = markers.map((point) => ({ ...point, ...local(point) }));
		const left = Math.min(...points.map(({ x }) => x));
		const right = Math.max(...points.map(({ x }) => x));
		const top = Math.min(...points.map(({ y }) => y));
		const bottom = Math.max(...points.map(({ y }) => y));
		const scale = 1 / Math.max((right - left) / 320, (bottom - top) / 120, 0.000003);
		const project = ({ x, y }: { x: number; y: number }) => ({
			x: 200 + (x - (left + right) / 2) * scale,
			y: 90 + (y - (top + bottom) / 2) * scale,
		});
		return {
			markers: points.map((point) => ({ ...point, ...project(point) })),
			line: shape
				?.map(([lon, lat]) => {
					const { x, y } = project(local({ lon, lat }));
					return `${x},${y}`;
				})
				.join(' '),
		};
	});
</script>

{#snippet mark(kind: string, x: number, y: number)}
	<circle
		cx={x}
		cy={y}
		r={kind === 'vehicle' ? 9 : 6}
		class:vehicle-marker={kind === 'vehicle'}
		class:previous-marker={kind === 'previous'}
	/>
	{#if kind === 'vehicle'}<circle cx={x} cy={y} r="3" class="vehicle-centre" />{/if}
{/snippet}

{#if finite}
	<StillMap
		label={fr ? 'Position du véhicule et arrêts à proximité' : 'Vehicle position and nearby stops'}
		viewBox={[0, 0, 400, 180]}
	>
		{#if projected.line}<polyline points={projected.line} />{/if}
		{#each projected.markers as point (point.kind)}
			{@render mark(point.kind, point.x, point.y)}
		{/each}
		{#snippet overlay()}{#if line}<RoutePlate code={line} />{/if}{/snippet}
	</StillMap>
	<ul class="flex flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground">
		{#each markers as { kind, label, name } (kind)}
			<li class="inline-flex items-center gap-1">
				<svg aria-hidden="true" viewBox="0 0 24 24" class="size-4 shrink-0"
					>{@render mark(kind, 12, 12)}</svg
				>
				{label}{#if name}{fr ? ' : ' : ': '}{name}{/if}
			</li>
		{/each}
		{#if shape}<li class="inline-flex items-center gap-1">
				<svg aria-hidden="true" viewBox="0 0 24 24" class="size-4 shrink-0"
					><polyline points="2,12 22,12" /></svg
				>{fr ? 'Sa ligne' : 'Its line'}
			</li>{/if}
	</ul>
{/if}

<style>
	polyline {
		fill: none;
		stroke: var(--primary);
		stroke-width: 4;
		stroke-linejoin: round;
	}
	circle {
		fill: var(--foreground);
		stroke: var(--background);
		stroke-width: 2;
	}
	.previous-marker {
		fill: var(--background);
		stroke: var(--foreground);
	}
	.vehicle-marker {
		fill: var(--background);
		stroke: var(--primary);
		stroke-width: 4;
	}
	.vehicle-centre {
		fill: var(--primary);
		stroke: none;
	}
</style>
