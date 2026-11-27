import { json, type RequestHandler } from '@sveltejs/kit';
import {
	READING_PATH,
	readingName,
	readingPaths,
	recoveryScreens,
	type RecoveryScreen,
} from '#lib/features/record/recordReadings.ts';
import { readScreenAgain } from '#lib/server/screenReadings.ts';
import { periodError } from '#lib/site/frameState.ts';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import { validEntityId } from '#lib/server/entityIdentity.ts';

const MAX_READINGS = 20;
const screensWithId = new Set<RecoveryScreen>(['line', 'stop', 'vehicle', 'departure']);

/** Asks one screen's missing readings again, with the cut of the page that asked first. */
export const GET: RequestHandler = async ({ request, url }) => {
	const { searchParams } = url;
	const screen = recoveryScreens.find((name) => name === searchParams.get('screen'));
	const city = searchParams.get('city') ?? '';
	const id = searchParams.get('id') ?? '';
	const from = searchParams.get('from') ?? '';
	const to = searchParams.get('to') ?? '';
	const page = searchParams.get('page') ?? '';
	const paths = (searchParams.get('readings') ?? '').split(',');
	if (
		!screen ||
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) ||
		(screen === 'departure'
			? id.length > 300 || !departureFromKey(id)
			: screensWithId.has(screen)
				? !validEntityId(id)
				: id !== '') ||
		page.length > 2048 ||
		paths.length > MAX_READINGS ||
		paths.some((path) => !READING_PATH.test(path)) ||
		periodError({ from, to }, '9999-12-31')
	) {
		return json({}, { status: 400 });
	}
	const root = await readScreenAgain(
		{
			screen,
			scope: { from, to, city, visitorIp: request.headers.get('cf-connecting-ip') },
			id,
			page: new URLSearchParams(page),
			lang: searchParams.get('lang') === 'fr' ? 'fr' : 'en',
			request,
		},
		new Set(paths.map(readingName)),
	);
	const results = await Promise.all(
		[...readingPaths(root)].map(async ([path, reading]) => [path, await reading]),
	);
	return json(Object.fromEntries(results), { headers: { 'cache-control': 'no-store' } });
};
