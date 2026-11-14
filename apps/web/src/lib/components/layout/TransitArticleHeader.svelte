<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { ArticleHeader } from '@yesid/ui/layout';
	import { readableName } from '#lib/components/surface/readableName.ts';
	import { getLocale, getLocalizeHref } from '#lib/i18n/index.ts';
	/** `notice`: a sentence shown under the stamp, linking to Data health (the record warning). */
	let { notice, ...props }: ComponentProps<typeof ArticleHeader> & { notice?: string | null } =
		$props();
	const localizeHref = getLocalizeHref();
	const locale = getLocale();
	const meta = $derived(
		props.meta?.filter((entry) => (typeof entry === 'string' ? entry : entry.text).trim()),
	);
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

<div class="transit-article-header" use:headline={props.title}>
	<ArticleHeader {...props} {meta} actions={notice ? withNotice : props.actions} />
</div>

{#snippet withNotice()}
	<p class="record-notice" data-slot="record-notice">
		<a href={localizeHref('/status', locale)}>{notice}</a>
	</p>
	{@render props.actions?.()}
{/snippet}

<style>
	.record-notice {
		flex-basis: 100%;
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.5;
		text-align: center;
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
