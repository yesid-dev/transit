export function readScheduleLineIds(raw: string): string[] | null {
	let ids: unknown;
	try {
		ids = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		!Array.isArray(ids) ||
		ids.length < 1 ||
		ids.length > 256 ||
		!ids.every(
			(id): id is string =>
				typeof id === 'string' &&
				id.length > 0 &&
				[...id].length <= 256 &&
				id === id.trim() &&
				!/[\p{C}\p{Z}]/u.test(id.replaceAll(' ', '')),
		)
	)
		return null;
	return [...new Set(ids)].sort();
}
