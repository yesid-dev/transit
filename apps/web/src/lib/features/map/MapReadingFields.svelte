<script lang="ts">
	import type { FilterStore } from '#lib/filters/index.ts';
	import {
		MAP_TIME_BANDS,
		mapReadingHours,
		readMapVehicleType,
		type MapTimeChoice,
	} from '#lib/filters/mapReadings.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import { railLegendName } from './mapLegend';

	let {
		store,
		routes,
		provider,
		locale,
		direction,
		onDirection,
	}: {
		store: FilterStore;
		routes: readonly RouteIndexEntry[];
		provider: Parameters<typeof railLegendName>[1];
		locale: Locale;
		direction?: 0 | 1;
		onDirection: (direction: 0 | 1 | undefined) => void;
	} = $props();

	const tr = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const readings = $derived(store.state.mapReadings);
	const vehicleType = $derived(readings?.vehicleType ?? '');
	const directionValue = $derived(readings?.direction ?? direction);
	const typeChoices = $derived(
		[...new Set(routes.map((route) => route.type))]
			.filter((type): type is number => type != null)
			.sort((a, b) => a - b),
	);
	const timeChoice = $derived(readings?.timeOfDay);
	const band = $derived(MAP_TIME_BANDS.find((item) => item.id === timeChoice));
	const timeValue = $derived(band?.id ?? (timeChoice ? 'custom' : ''));
	const range = $derived(mapReadingHours(timeChoice) ?? ([0, 24] as const));
	const hourChoices = Array.from({ length: 25 }, (_, hour) => hour);
	const lightRail = $derived(
		railLegendName(
			locale,
			provider,
			routes.filter(({ type }) => type === 0),
		),
	);

	function typeLabel(type: number): string {
		switch (type) {
			case 0:
				return lightRail
					? lightRail[0].toLocaleUpperCase(locale) + lightRail.slice(1)
					: tr('Tram', 'Tramway');
			case 1:
				return 'Métro';
			case 2:
				return 'Train';
			case 3:
				return tr('Road vehicles', 'Véhicules routiers');
			case 4:
				return tr('Ferry', 'Traversier');
			default:
				return tr('Other vehicles', 'Autres véhicules');
		}
	}

	function changeTime(value: string) {
		const next: MapTimeChoice | undefined =
			value === 'custom' ? '0-24' : MAP_TIME_BANDS.find((item) => item.id === value)?.id;
		store.setMapReadings({ ...readings, timeOfDay: next });
	}

	function changeHours(from: number, to: number) {
		store.setMapReadings({ ...readings, timeOfDay: `${from}-${to}` });
	}

	const selectClass =
		'min-h-11 w-full min-w-0 rounded-md border border-border bg-card px-2 text-sm text-foreground';
</script>

<div class="grid min-w-0 gap-2">
	<label class="grid min-w-0 gap-1 text-sm">
		<span>{tr('Vehicle type', 'Type de véhicule')}</span>
		<select
			class={selectClass}
			value={vehicleType}
			onchange={(event) =>
				store.setMapReadings({
					...readings,
					vehicleType: readMapVehicleType(event.currentTarget.value),
				})}
		>
			<option value="">{tr('All vehicle types', 'Tous les types de véhicules')}</option>
			{#each typeChoices as type (type)}
				<option value={type}>{typeLabel(type)}</option>
			{/each}
		</select>
	</label>
	<label class="grid min-w-0 gap-1 text-sm">
		<span>{tr('Time of day', 'Moment de la journée')}</span>
		<select
			class={selectClass}
			value={timeValue}
			onchange={(event) => changeTime(event.currentTarget.value)}
		>
			<option value="">{tr('All day', 'Toute la journée')}</option>
			{#each MAP_TIME_BANDS as choice (choice.id)}
				<option value={choice.id}>{choice[locale]}</option>
			{/each}
			<option value="custom">{tr('Custom hours', 'Heures choisies')}</option>
		</select>
	</label>
	{#if timeValue === 'custom'}
		<div class="grid min-w-0 grid-cols-2 gap-2">
			<label class="grid min-w-0 gap-1 text-sm">
				<span>{tr('From', 'De')}</span>
				<select
					class={selectClass}
					value={range[0]}
					onchange={(event) => changeHours(Number(event.currentTarget.value), range[1])}
				>
					{#each hourChoices.slice(0, 24) as hour (hour)}
						<option value={hour} disabled={hour === range[1]}
							>{String(hour).padStart(2, '0')}:00</option
						>
					{/each}
				</select>
			</label>
			<label class="grid min-w-0 gap-1 text-sm">
				<span>{tr('Until', 'Jusqu’à')}</span>
				<select
					class={selectClass}
					value={range[1]}
					onchange={(event) => changeHours(range[0], Number(event.currentTarget.value))}
				>
					{#each hourChoices as hour (hour)}
						<option value={hour} disabled={hour === range[0]}
							>{String(hour).padStart(2, '0')}:00</option
						>
					{/each}
				</select>
			</label>
		</div>
	{/if}
	<label class="grid min-w-0 gap-1 text-sm">
		<span>{tr('Direction', 'Sens')}</span>
		<select
			class={selectClass}
			value={directionValue === undefined ? '' : String(directionValue)}
			onchange={(event) => {
				const value = event.currentTarget.value;
				onDirection(value === '0' ? 0 : value === '1' ? 1 : undefined);
			}}
		>
			<option value="">{tr('Both directions', 'Les deux sens')}</option>
			<option value="0">{tr('Direction 1', 'Sens 1')}</option>
			<option value="1">{tr('Direction 2', 'Sens 2')}</option>
		</select>
	</label>
</div>
