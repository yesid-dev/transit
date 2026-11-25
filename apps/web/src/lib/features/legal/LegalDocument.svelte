<script lang="ts">
	import { ReadingFrame, Surface } from '@yesid/ui/layout';
	import { Separator } from '@yesid/ui/separator';
	import { getLocale, type Locale } from '#lib/i18n/index.ts';
	import { LEGAL_EFFECTIVE_DATES, legalDocument, type LegalPageKind } from './legal.copy';

	interface Props {
		kind: LegalPageKind;
		locale?: Locale;
	}

	let { kind, locale: localeProp }: Props = $props();
	const contextLocale = getLocale();
	const locale = $derived(localeProp ?? contextLocale);
	const document = $derived(legalDocument(locale, kind));
</script>

<Surface class="@container" style="--space-page-x: var(--space-card-gap)">
	<ReadingFrame
		title={document.title}
		titleId="legal-title"
		style="--reading-gutter: 0; padding-block: 0"
		aria-labelledby="legal-title"
		data-testid="legal-document"
		updated={{
			datetime: LEGAL_EFFECTIVE_DATES[kind],
			label: document.effectiveLabel + ':',
			text: document.effectiveDate,
		}}
	>
		{#snippet summary()}
			<p>{document.summary}</p>
		{/snippet}

		{#each document.sections as section, index (section.id)}
			{#if index > 0}<Separator variant="hand-drawn" class="my-6 @max-[12rem]:my-4" />{/if}
			<section class="legal-section grid gap-3" aria-labelledby={`legal-${section.id}`}>
				<h2 id={`legal-${section.id}`}>{section.title}</h2>
				{#each section.paragraphs as paragraph (paragraph)}
					<p>{paragraph}</p>
				{/each}
				{#if section.bullets}
					<ul class="ms-5 list-disc">
						{#each section.bullets as item (item)}
							<li>{item}</li>
						{/each}
					</ul>
				{/if}
				{#if section.links}
					<ul class="legal-document__links">
						{#each section.links as link (link.href)}
							<li>
								<a
									class="text-primary underline"
									href={link.href}
									target={link.href.startsWith('https://') ? '_blank' : undefined}
									rel={link.href.startsWith('https://') ? 'noreferrer' : undefined}>{link.label}</a
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
		min-block-size: 24px;
		align-content: center;
	}
</style>
