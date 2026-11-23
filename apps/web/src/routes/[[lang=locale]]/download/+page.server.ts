import { z } from 'zod';
import { getDownloadListing } from '#lib/server/downloads.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { providerId, provider, providers, discoveryError } = await event.parent();
	const requested = event.url.searchParams.getAll('date');
	const parsed = z.iso.date().safeParse(requested[0]);
	const invalidDate = requested.length > 1 || (requested.length === 1 && !parsed.success);
	const date = parsed.data ?? null;
	if (!discoveryError) event.setHeaders({ 'cache-control': 'no-store' });
	return {
		providerId,
		providers: providers.map(({ id, labels }) => ({ id, labels })),
		date,
		invalidDate,
		listing:
			provider && !invalidDate
				? getDownloadListing(providerId, date, event.request.headers.get('cf-connecting-ip'))
				: null,
	};
};
