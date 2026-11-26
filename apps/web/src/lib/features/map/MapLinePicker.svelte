<script lang="ts">
	import { Combobox } from '@yesid/ui/combobox';
	import type { Locale } from '#lib/i18n/index.ts';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';

	let {
		routes,
		locale,
		label,
		placeholder,
		value = null,
		additive = false,
		onchange,
	}: {
		routes: readonly RouteIndexEntry[];
		locale: Locale;
		label: string;
		placeholder: string;
		value?: string | null;
		additive?: boolean;
		onchange: (id: string | null) => void;
	} = $props();
	const display = transitDisplay();
	const fr = $derived(locale === 'fr');
	let selected = $derived(value);
	const options = $derived(
		routes.map((route) => {
			const label = route.short || display.line(route.id);
			const sublabel = route.long ? display.readName(route.long, locale) : undefined;
			return {
				value: route.id,
				label,
				sublabel: sublabel === label ? undefined : sublabel,
				search: foldSearchText([route.id, label, sublabel].filter(Boolean).join(' ')),
			};
		}),
	);
</script>

<Combobox
	{options}
	{label}
	{placeholder}
	bind:value={selected}
	onValueChange={(id) => {
		onchange(id);
		if (additive) selected = null;
	}}
	clearLabel={fr ? 'Effacer la ligne' : 'Clear line'}
	emptyLabel={fr ? 'Aucune ligne correspondante' : 'No matching lines'}
	fold={foldSearchText}
/>
