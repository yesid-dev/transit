import { redirect } from '@sveltejs/kit';
import { legacyRankingHref } from '#lib/features/rankings/rankingSelection.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, params }) =>
	redirect(301, legacyRankingHref('/repeat-offenders', url, params.lang === 'fr' ? 'fr' : 'en'));
