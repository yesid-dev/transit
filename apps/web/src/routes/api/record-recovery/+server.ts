import { json, type RequestHandler } from '@sveltejs/kit';
import { lineDirection, loadLineRecord } from '#lib/server/lineRecord.ts';
import { readVehicleSections } from '#lib/server/vehicleRecord.ts';
import { periodError } from '#lib/site/frameState.ts';

export const GET: RequestHandler = async ({ request, url }) => {
	const { searchParams } = url;
	const kind = searchParams.get('kind');
	const city = searchParams.get('city') ?? '';
	const id = searchParams.get('id') ?? '';
	const from = searchParams.get('from') ?? '';
	const to = searchParams.get('to') ?? '';
	const sections = (searchParams.get('sections') ?? '').split(',');
	if (
		(kind !== 'line' && kind !== 'vehicle') ||
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) ||
		!id ||
		id.length > 256 ||
		id !== id.trim() ||
		/[^\S ]|\p{C}/u.test(id) ||
		sections.length > 15 ||
		sections.some((name) => !/^[a-zA-Z]+$/.test(name)) ||
		periodError({ from, to }, '9999-12-31')
	) {
		return json({}, { status: 400 });
	}
	const only = new Set(sections);
	const visitorIp = request.headers.get('cf-connecting-ip');
	const period = { from, to };
	const readings =
		kind === 'line'
			? loadLineRecord(period, city, id, lineDirection(searchParams), visitorIp, false, only)
			: readVehicleSections({ ...period, city, visitorIp, retryBusy: true }, id, only);
	const entries: [string, (typeof readings.sections)[number]['answer']][] = readings.sections.map(
		({ section, answer }) => [section, answer],
	);
	if ('days' in readings && readings.days) entries.push(['days', readings.days]);
	if ('network' in readings && readings.network) entries.push(['network', readings.network]);
	if ('networkDaily' in readings && readings.networkDaily)
		entries.push(['networkDaily', readings.networkDaily]);
	const results = await Promise.all(entries.map(async ([name, answer]) => [name, await answer]));
	return json(Object.fromEntries(results), { headers: { 'cache-control': 'no-store' } });
};
