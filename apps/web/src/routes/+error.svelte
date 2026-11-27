<script lang="ts">
	import { page } from '$app/state';
	import { ErrorPage } from '@yesid/ui/layout';
	import { getLocalizeHref, pathLocale, type Locale } from '#lib/i18n/index.ts';
	import { errorDocumentHead, errorPageCopy } from '#lib/site/errorPage.ts';
	import { trackEvent } from '#lib/site/analytics.ts';

	const localizeHref = getLocalizeHref();

	const locale = $derived<Locale>(pathLocale(page.url?.pathname ?? '/'));
	const status = $derived(page.status);
	const is404 = $derived(status === 404);

	const copy = $derived(errorPageCopy[locale]);
	const localized = (suggestions: readonly { label: string; href: string }[]) =>
		suggestions.map((suggestion) => ({
			...suggestion,
			href: localizeHref(suggestion.href, locale),
		}));
	const view = $derived.by(() => {
		const code = is404 ? page.error?.code : undefined;
		if (code === 'TRIP_ENDED') {
			// The server already localized the line's address and kept its city.
			const line = page.error?.line;
			return {
				heading: copy.tripEnded.heading,
				body: copy.tripEnded.body,
				illustration: 'none' as const,
				suggestions: [
					...(line ? [{ href: line, label: copy.tripEnded.line }] : []),
					...localized(copy.tripEnded.suggestions),
				],
			};
		}
		if (code === 'STOP_NOT_FOUND')
			return {
				heading: copy.stopNotFound.heading,
				body: copy.stopNotFound.body,
				illustration: 'none' as const,
				suggestions: localized(copy.stopNotFound.suggestions),
			};
		if (is404)
			return {
				heading: copy.notFound.heading,
				body: copy.notFound.description,
				statusNote: copy.notFound.statusNote,
				signLabel: 'STATION',
				suggestions: localized(copy.notFound.suggestions),
			};
		return {
			label: copy.generic.label,
			heading: copy.generic.heading,
			body: copy.generic.body,
			detail: page.error?.message,
			suggestions: [
				{
					href: page.url.origin + page.url.pathname + page.url.search,
					label: locale === 'fr' ? 'Réessayer' : 'Try again',
				},
				{ href: localizeHref('/', locale), label: copy.generic.home },
			],
		};
	});

	const documentHead = $derived(errorDocumentHead(status, locale, page.error?.code));
	let tracked404: string | undefined;
	$effect(() => {
		const path = page.url.pathname;
		if (is404 && path !== tracked404) {
			tracked404 = path;
			trackEvent('404');
		}
	});
</script>

<svelte:head>
	<title>{documentHead.title} · Transit</title>
</svelte:head>

<div data-sveltekit-reload={is404 ? undefined : true}>
	<ErrorPage {status} suggestionsLabel={copy.suggestionsLabel} {...view} />
</div>
