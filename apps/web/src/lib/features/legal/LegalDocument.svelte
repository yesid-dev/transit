<script lang="ts">
	import InfoPage from '#lib/components/layout/InfoPage.svelte';
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

<InfoPage title={document.title} titleId="legal-title" testId="legal-document">
	{#snippet beforeTitle()}
		<p class="legal-document__kicker">{document.kicker}</p>
	{/snippet}
	{#snippet afterTitle()}
		<p class="legal-document__effective">
			{document.effectiveLabel}:
			<time datetime={LEGAL_EFFECTIVE_DATES[kind]}>{document.effectiveDate}</time>
		</p>
		<p class="legal-document__summary">{document.summary}</p>
	{/snippet}

	{#each document.sections as section (section.id)}
		<section aria-labelledby={`legal-${section.id}`}>
			<h2 id={`legal-${section.id}`}>{section.title}</h2>
			{#each section.paragraphs as paragraph (paragraph)}
				<p>{paragraph}</p>
			{/each}
			{#if section.bullets}
				<ul>
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
</InfoPage>

<style>
	.legal-document__kicker,
	.legal-document__effective {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
	}

	.legal-document__kicker {
		color: var(--primary);
		font-weight: 700;
		letter-spacing: var(--tracking-eyebrow);
	}

	.legal-document__effective {
		color: var(--muted-foreground);
	}

	.legal-document__summary {
		font-size: var(--text-reading-support);
	}

	.legal-document__links {
		list-style: none;
		padding-inline-start: 0;
	}

	.legal-document__links :global(li > a) {
		display: inline-block;
		min-block-size: 24px;
		align-content: center;
	}
</style>
