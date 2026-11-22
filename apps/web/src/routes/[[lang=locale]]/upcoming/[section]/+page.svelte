<script lang="ts">
	import { getLocale } from '#lib/i18n/index.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
</script>

<section class="mx-auto grid w-full max-w-3xl gap-3 px-6 py-8">
	<h1 class="text-3xl font-bold">{data.label[locale]}</h1>
	<p>
		{locale === 'fr' ? 'Cette page reste à construire.' : 'This page has yet to be built.'}
	</p>
</section>
