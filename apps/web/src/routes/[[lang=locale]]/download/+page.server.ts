import { z } from 'zod';
import { redirect } from '@sveltejs/kit';
import { downloadWindow, getDownloadWindow } from '#lib/server/downloads.ts';
import { getMethodCatalog } from '#lib/server/engine.ts';
import { frameHref, frameToday, parseFrameState, periodError } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { providerId, provider, lang, discoveryError } = await event.parent();
	const today = frameToday(provider?.timezone);
	const { searchParams } = event.url;
	const { period } = parseFrameState(searchParams, today);
	const requested = searchParams.getAll('date');
	const parsed = z.iso.date().safeParse(requested[0]);
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	if (
		requested.length === 1 &&
		parsed.success &&
		!searchParams.has('recordFrom') &&
		!periodError({ from: parsed.data, to: parsed.data }, today)
	) {
		const target = new URL(event.url);
		target.searchParams.delete('date');
		redirect(
			307,
			frameHref(target, {
				mode: 'record',
				period: { from: parsed.data, to: parsed.data, preset: null },
			}),
		);
	}
	const window = period && downloadWindow(period, searchParams.get('daysPage'));
	if (!discoveryError) event.setHeaders({ 'cache-control': 'no-store' });
	return {
		providerId,
		city: provider?.labels[lang] ?? null,
		period,
		window,
		listing: provider && window ? getDownloadWindow(providerId, window, visitorIp) : null,
		methods: provider ? getMethodCatalog(visitorIp) : null,
	};
};
