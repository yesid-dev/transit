<script lang="ts">
	import LegalDocument from '#lib/features/legal/LegalDocument.svelte';

	let { data } = $props();
</script>

<LegalDocument kind="terms" providers={data.providers} />
