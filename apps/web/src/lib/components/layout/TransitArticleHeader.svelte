<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { ArticleHeader } from '@yesid/ui/layout';
	import { readableName } from '#lib/components/surface/readableName.ts';
	import { getLocale, getLocalizeHref } from '#lib/i18n/index.ts';
	import { isRecordMetaEntry } from '#lib/v1/recordStamp.svelte.ts';
	/** `notice`: a sentence shown under the stamp, linking to Data health (the record warning). */
	let { notice, ...props }: ComponentProps<typeof ArticleHeader> & { notice?: string | null } =
		$props();
	const localizeHref = getLocalizeHref();
	const locale = getLocale();
	// A record page's header has its final height from the first render, so nothing below it moves
	// when the record's files arrive: the stamp ends the meta row, drawn over the room of the longest
	// stamp this language can show; the warning row holds its sentence's room; the sections control
	// keeps its row while the sections it counts are still loading.
	const stamp = $derived(props.meta?.find(isRecordMetaEntry));
	const meta = $derived([
		...(props.meta?.filter(
			(entry) =>
				!isRecordMetaEntry(entry) && (typeof entry === 'string' ? entry : entry.text).trim(),
		) ?? []),
		...(stamp ? [stamp] : []),
	]);
	const stampState = $derived(
		stamp && (stamp.text ? 'ready' : stamp.recordStamp.pending ? 'pending' : 'absent'),
	);
	const noticeReserve = $derived(stamp?.recordStamp.noticeReserve ?? null);
	function headline(node: HTMLElement, title: string) {
		// The aria-hidden watermark intentionally bleeds past its drawing frame.
		node
			.querySelector('.header__decoration-layer[aria-hidden="true"]')
			?.setAttribute('data-allow-clip', '');
		const heading = node.querySelector('h1');
		if (!heading) return;
		heading.classList.add('readable-name');
		heading.title = title;
		const action = readableName(heading);
		return {
			update(nextTitle: string) {
				heading.title = nextTitle;
				delete heading.dataset.expanded;
			},
			destroy: action.destroy,
		};
	}
</script>

<div
	class="transit-article-header"
	data-record-stamp={stampState}
	style:--record-reserve={stamp ? JSON.stringify(stamp.recordStamp.reserve) : undefined}
	use:headline={props.title}
>
	<ArticleHeader {...props} {meta} actions={notice || noticeReserve ? withNotice : props.actions} />
</div>

{#snippet withNotice()}
	<p class="record-notice" data-slot={notice ? 'record-notice' : 'record-notice-reserve'}>
		{#if notice}<a href={localizeHref('/status', locale)}>{notice}</a>{/if}
		{#if noticeReserve}<span class="reserve" aria-hidden="true" data-reserve={noticeReserve}
			></span>{/if}
	</p>
	{@render props.actions?.()}
{/snippet}

<style>
	/* The stamp's text, and the dot before it, sit centred over its reserved room. Every rule is
	   global, so the wrapper stays unscoped and headers without a stamp render exactly as before. */
	:global(.transit-article-header[data-record-stamp])
		:global(.header__meta > .header__meta-item:last-child) {
		display: grid;
		justify-items: center;
	}
	:global(.transit-article-header[data-record-stamp])
		:global(.header__meta > .header__meta-item:last-child > .header__meta-sep) {
		display: none;
	}
	:global(.transit-article-header[data-record-stamp='ready'])
		:global(
			.header__meta > .header__meta-item:last-child:has(> .header__meta-sep) > :last-child::before
		) {
		content: '';
		display: inline-block;
		width: 3px;
		height: 3px;
		margin-inline-end: 1rem;
		border-radius: 50%;
		background: var(--article-accent, var(--primary));
		opacity: 0.4;
		vertical-align: middle;
	}
	:global(.transit-article-header[data-record-stamp])
		:global(.header__meta > .header__meta-item:last-child:has(> .header__meta-sep)::after) {
		padding-inline-start: calc(3px + 1rem);
	}
	:global(.transit-article-header[data-record-stamp])
		:global(.header__meta > .header__meta-item:last-child > :last-child),
	:global(.transit-article-header[data-record-stamp])
		:global(.header__meta > .header__meta-item:last-child::after) {
		grid-area: 1 / 1;
		min-width: 0;
	}
	:global(.transit-article-header[data-record-stamp])
		:global(.header__meta > .header__meta-item:last-child::after) {
		content: var(--record-reserve);
		justify-self: stretch;
		visibility: hidden;
	}
	:global(.transit-article-header[data-record-stamp='pending'])
		:global(.header__meta > .header__meta-item:last-child > :last-child) {
		width: clamp(8rem, 18vw, 14rem);
		height: 0.625rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--article-accent, var(--primary)) 12%, transparent);
	}
	:global(.transit-article-header[data-record-stamp])
		:global([data-slot='article-header-controls']) {
		min-height: 44px;
	}
	.record-notice {
		display: grid;
		flex-basis: 100%;
		justify-items: center;
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.5;
		text-align: center;
	}
	.record-notice > * {
		grid-area: 1 / 1;
		min-width: 0;
	}
	.record-notice .reserve {
		justify-self: stretch;
		visibility: hidden;
	}
	.record-notice .reserve::after {
		content: attr(data-reserve);
	}
	.record-notice a {
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.record-notice a:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
