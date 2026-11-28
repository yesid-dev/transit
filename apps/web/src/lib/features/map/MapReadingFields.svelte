<script lang="ts">
	import type { FilterStore } from '#lib/filters/index.ts';
	import { Combobox } from '@yesid/ui/combobox';
	import {
		MAP_TIME_BANDS,
		mapReadingHours,
		readMapVehicleType,
		type MapTimeChoice,
	} from '#lib/filters/mapReadings.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { readerClock } from '#lib/site/presenter.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import { railLegendName } from './mapLegend';

	let {
		store,
		routes,
		provider,
		locale,
		direction,
		directions,
		hasOneLine,
		onDirection,
	}: {
		store: FilterStore;
		routes: readonly RouteIndexEntry[];
		provider: Parameters<typeof railLegendName>[1];
		locale: Locale;
		direction?: 0 | 1;
		directions: readonly { value: 0 | 1; label: string }[];
		hasOneLine: boolean;
		onDirection: (direction: 0 | 1 | undefined) => void;
	} = $props();

	const tr = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const directionHintId = $props.id();
	const readings = $derived(store.state.mapReadings);
	const vehicleType = $derived(readings?.vehicleType ?? '');
	const directionValue = $derived(readings?.direction ?? direction);
	const directionChoices = $derived([
		{ value: 'both', label: tr('Both directions', 'Les deux sens') },
		...directions.map(({ value, label }) => ({ value: String(value), label })),
	]);
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

<div class="grid min-w-0 grid-cols-1 gap-2">
	<label class="grid min-w-0 grid-cols-1 gap-1 text-sm">
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
			<option value="">{tr('All types', 'Tous les types')}</option>
			{#each typeChoices as type (type)}
				<option value={type}>{typeLabel(type)}</option>
			{/each}
		</select>
	</label>
	<label class="grid min-w-0 grid-cols-1 gap-1 text-sm">
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
			<label class="grid min-w-0 grid-cols-1 gap-1 text-sm">
				<span>{tr('From', 'De')}</span>
				<select
					class={selectClass}
					value={range[0]}
					onchange={(event) => changeHours(Number(event.currentTarget.value), range[1])}
				>
					{#each hourChoices.slice(0, 24) as hour (hour)}
						<option value={hour} disabled={hour === range[1]}>{readerClock(hour, 0, locale)}</option
						>
					{/each}
				</select>
			</label>
			<label class="grid min-w-0 grid-cols-1 gap-1 text-sm">
				<span>{tr('Until', 'Jusqu’à')}</span>
				<select
					class={selectClass}
					value={range[1]}
					onchange={(event) => changeHours(range[0], Number(event.currentTarget.value))}
				>
					{#each hourChoices as hour (hour)}
						<option value={hour} disabled={hour === range[0]}>{readerClock(hour, 0, locale)}</option
						>
					{/each}
				</select>
			</label>
		</div>
	{/if}
	<div class="grid min-w-0 grid-cols-1 gap-1 text-sm" data-map-direction-filter>
		<span>{tr('Direction', 'Sens')}</span>
		{#if hasOneLine}
			<Combobox
				searchable={false}
				clearable={false}
				disabled={!directions.length}
				label={tr('Direction', 'Sens')}
				placeholder={tr('Direction unavailable', 'Sens indisponible')}
				options={directionChoices}
				value={directions.length
					? directionValue === undefined
						? 'both'
						: String(directionValue)
					: null}
				onValueChange={(value) => onDirection(value === '0' ? 0 : value === '1' ? 1 : undefined)}
			/>
		{:else}
			<select
				class={`${selectClass} disabled:text-muted-foreground`}
				aria-label={tr('Direction', 'Sens')}
				aria-describedby={directionHintId}
				disabled
			>
				<option>{tr('Choose a direction', 'Choisir un sens')}</option>
			</select>
			<p id={directionHintId} class="text-sm text-muted-foreground">
				{tr('Pick one line first.', 'Choisissez d’abord une ligne.')}
			</p>
		{/if}
	</div>
</div>
