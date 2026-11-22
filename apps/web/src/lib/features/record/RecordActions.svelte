<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';
	import { choose } from './recordText.ts';

	let {
		locale,
		title,
		href,
		csv,
		citation,
	}: { locale: Locale; title: string; href: string; csv: string; citation: string } = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const citationText = $derived(
		citation.endsWith(href) ? citation.slice(0, -href.length) : citation,
	);
	const urlParts = $derived(href.split(/(?<=[/?&=#_.:%-])/u));
</script>

{#key href}
	<div class="flex flex-wrap items-start gap-x-4 gap-y-2">
		<CopyAction
			text={href}
			label={t('Copy link', 'Copier le lien')}
			done={t('Link copied.', 'Lien copié.')}
			fallback={t('Copy the link below.', 'Copiez le lien ci-dessous.')}
			fallbackLabel={t('Link to this section', 'Lien vers cette section')}
		/>
		<a
			class="inline-flex min-h-11 min-w-11 items-center justify-center"
			href={csv}
			download
			aria-label={t(`Download CSV for ${title}`, `Télécharger le CSV pour ${title}`)}>CSV</a
		>
		<details class="min-w-0 open:basis-full">
			<summary class="min-h-11 min-w-11 cursor-pointer py-3">{t('Cite', 'Citer')}</summary>
			<p class="wrap-break-word">
				{citationText}{#if citationText !== citation}{#each urlParts as part, index (index)}{part}<wbr
						/>{/each}{/if}
			</p>
		</details>
	</div>
{/key}

<style>
	details:not([open]) > p {
		display: none;
	}
</style>
