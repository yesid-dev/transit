<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import { HOME_INVITE_LINKS, homeInviteCopy } from './homePulse.copy';

	let { locale }: { readonly locale: Locale } = $props();
	const t = $derived(homeInviteCopy[locale]);
	const links = $derived([
		[t.contribute, HOME_INVITE_LINKS.contribute],
		[t.code, HOME_INVITE_LINKS.code],
		[t.contact, HOME_INVITE_LINKS.contact[locale]],
	] as const);
</script>

<!-- The contribution invitation, compact, at the end of the page (UX plan §6.1). -->
<section class="home-invite" data-slot="home-invite" aria-labelledby="home-invite-title">
	<h2 id="home-invite-title">{t.title}</h2>
	<p>{t.body}</p>
	<p class="invite-actions">
		{#each links as [label, href] (href)}
			<a {href} target="_blank" rel="noopener noreferrer"
				>{label}<span aria-hidden="true"> ↗</span><span class="sr-only">
					{navPillCopy[locale].newTab}</span
				></a
			>
		{/each}
	</p>
</section>

<style>
	.home-invite {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}
	.home-invite h2 {
		margin: 0;
		font-family: var(--font-heading);
		font-size: var(--text-card-title);
		font-weight: 800;
		letter-spacing: var(--tracking-tight);
	}
	.home-invite p {
		max-width: var(--measure-body);
		margin: 0;
		line-height: 1.6;
		color: var(--muted-foreground);
	}
	.home-invite .invite-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.5rem;
	}
	.invite-actions a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--primary);
	}
	.invite-actions a:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
</style>
