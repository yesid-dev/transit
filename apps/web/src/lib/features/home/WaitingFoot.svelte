<script lang="ts">
	import { Skeleton } from '@yesid/ui/skeleton';
</script>

<!-- The card foot's evidence line while its answer is on the way: drawn from the first frame so
     the card does not grow by its foot when the answer arrives (holistic pass D2). -->
<span class="flex min-h-6 items-center" aria-hidden="true" aria-busy="true" data-waiting-foot>
	<Skeleton class="h-4 w-72 max-w-full" />
</span>
