<script lang="ts" module>
	/** Split a citation so its web addresses may wrap after their punctuation, never inside a word. */
	export function citationParts(text: string): { text: string; address: boolean }[] {
		return text
			.split(/(https?:\/\/\S+)/u)
			.filter(Boolean)
			.map((part) => ({ text: part, address: /^https?:\/\//u.test(part) }));
	}
</script>

<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';

	let { locale, text }: { locale: Locale; text: string } = $props();
	const fr = $derived(locale === 'fr');
</script>

<div class="grid min-w-0 justify-items-start gap-2" data-slot="cite-block">
	<p
		class="m-0 min-w-0 group-data-[cite-window]/cite:max-w-[72ch] group-data-[cite-window]/cite:wrap-anywhere group-data-[cite-window]/cite:font-mono"
		data-slot="cite-text"
	>
		{#each citationParts(text) as part, index (index)}{#if part.address}{#each part.text.split(/(?<=[/?&=#_.:%-])/u) as piece, pieceIndex (pieceIndex)}{piece}<wbr
					/>{/each}{:else}{part.text}{/if}{/each}
	</p>
	<div
		class="min-w-0 max-w-full group-data-[cite-window]/cite:row-start-1 group-data-[cite-window]/cite:justify-self-end"
	>
		<CopyAction
			size="cta-sm"
			{text}
			label={fr ? 'Copier' : 'Copy'}
			done={fr ? 'Citation copiée.' : 'Citation copied.'}
			fallback={fr ? 'Copiez la citation ci-dessous.' : 'Copy the citation below.'}
			fallbackLabel={fr ? 'Citation' : 'Citation'}
		/>
	</div>
</div>
