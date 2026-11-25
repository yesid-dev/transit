<script lang="ts">
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { localizeHref, pathLocale } from '#lib/i18n/index.ts';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';

	const locale = $derived(pathLocale(page.url.pathname));
</script>

<Surface>
	<ScreenTitle
		title={page.error?.message ?? (locale === 'fr' ? 'Ligne indisponible' : 'Line unavailable')}
		back={{
			href: localizeHref('/lines', locale, page.url.searchParams.get('provider') ?? undefined),
			label: locale === 'fr' ? 'Toutes les lignes' : 'All lines',
		}}
	/>
</Surface>
