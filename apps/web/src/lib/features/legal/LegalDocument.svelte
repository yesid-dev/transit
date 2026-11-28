<script lang="ts" module>
	// Offer a line break after "@" or "." inside an address, so enlarged text wraps
	// "contact@yesid.dev" between its parts instead of inside a word. Copying is unchanged.
	export function addressParts(text: string) {
		return text.split(/(?<=[a-z0-9][@.])(?=[a-z])/);
	}
</script>

<script lang="ts">
	import { ReadingFrame, Surface } from '@yesid/ui/layout';
	import { Separator } from '@yesid/ui/separator';
	import { getLocale, type Locale } from '#lib/i18n/index.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import { LEGAL_EFFECTIVE_DATES, legalDocument, type LegalPageKind } from './legal.copy';

	interface Props {
		kind: LegalPageKind;
		locale?: Locale;
		/** Published networks; each one's licence becomes a credit link on the terms page. */
		providers?: readonly Pick<PublicCity, 'download_licence'>[];
	}

	let { kind, locale: localeProp, providers = [] }: Props = $props();
	const contextLocale = getLocale();
	const locale = $derived(localeProp ?? contextLocale);
	const document = $derived(legalDocument(locale, kind, providers));
</script>

{#snippet wrapping(
	text: string,
)}{#each addressParts(text) as part, index (index)}{#if index > 0}<wbr
			/>{/if}{part}{/each}{/snippet}

<Surface class="@container" style="--space-page-x: var(--space-card-gap); padding-block-start: 0">
	<ReadingFrame
		title={document.title}
		titleId="legal-title"
		style="--reading-gutter: 0; --reading-measure: var(--transit-measure-listing); padding-block-end: 0"
		aria-labelledby="legal-title"
		data-testid="legal-document"
		updated={{
			datetime: LEGAL_EFFECTIVE_DATES[kind],
			label: document.effectiveLabel + (locale === 'fr' ? '\u00a0:' : ':'),
			text: document.effectiveDate,
		}}
	>
		{#snippet summary()}
			<p>{document.summary}</p>
		{/snippet}

		{#each document.sections as section, index (section.id)}
			{#if index > 0}<Separator
					variant="hand-drawn"
					class="my-6 @max-[12rem]:my-4"
					style="color: var(--page-boundary-color)"
				/>{/if}
			<section class="legal-section grid gap-3" aria-labelledby={`legal-${section.id}`}>
				<h2 id={`legal-${section.id}`}>{section.title}</h2>
				{#each section.paragraphs as paragraph (paragraph)}
					<p>{@render wrapping(paragraph)}</p>
				{/each}
				{#if section.bullets}
					<ul class="ms-5 list-disc">
						{#each section.bullets as item (item)}
							<li>{@render wrapping(item)}</li>
						{/each}
					</ul>
				{/if}
				{#if section.links}
					<ul class="legal-document__links">
						{#each section.links as link (link.href)}
							<li>
								<a
									class="min-h-11 text-primary underline"
									href={link.href}
									target={link.href.startsWith('https://') ? '_blank' : undefined}
									rel={link.href.startsWith('https://') ? 'noreferrer' : undefined}
									>{@render wrapping(link.label)}</a
								>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}
	</ReadingFrame>
</Surface>

<style>
	.legal-section > :is(h2, p, ul) {
		margin-block: 0;
	}

	.legal-section :is(p, li) {
		line-height: 1.7;
	}

	.legal-document__links {
		list-style: none;
		padding-inline-start: 0;
	}

	.legal-document__links a {
		display: inline-block;
		align-content: center;
	}
</style>
