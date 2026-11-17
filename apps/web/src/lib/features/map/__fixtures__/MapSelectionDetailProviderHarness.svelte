<script lang="ts">
	import { setLocaleContext, type Locale } from '#lib/i18n/index.ts';
	import MapSelectionDetail from '../MapSelectionDetail.svelte';
	import type { MapSelectionDetail as SelectionDetail } from '../mapSelectionSession.svelte';

	interface Props {
		detail: SelectionDetail | null;
		locale: Locale;
		provider: string;
		timeZone?: string;
	}

	let { detail, locale, provider, timeZone }: Props = $props();

	// The real root layout provides the request locale and the provider every in-app link keeps.
	setLocaleContext(
		() => locale,
		() => provider,
	);
</script>

<MapSelectionDetail {detail} {locale} {timeZone} presentation="body" />
<MapSelectionDetail {detail} {locale} presentation="action" />
