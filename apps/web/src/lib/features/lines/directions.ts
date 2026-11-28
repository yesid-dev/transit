import { stopDisplayName } from '#lib/site/transitDisplay.ts';
import type { RouteFile, RouteStop } from '#lib/v1/index.ts';

export function directionHeadsigns(
	directions: RouteFile['directions'] | undefined | null,
	stopNames?: ReadonlyMap<string, string>,
): Record<number, string> {
	const byDir: Record<number, string> = {};
	const terminalByDir: Record<number, string> = {};
	for (const d of directions ?? []) {
		if (d.dir == null) continue;
		const sign = (d.headsign ?? '').trim();
		if (sign) {
			byDir[d.dir] ??= sign;
			continue;
		}
		if (!stopNames || byDir[d.dir] || terminalByDir[d.dir]) continue;
		const last = d.stops?.reduce<RouteStop | undefined>(
			(terminal, stop) => (!terminal || stop.seq > terminal.seq ? stop : terminal),
			undefined,
		);
		const name = last && (last.name?.trim() || stopNames.get(last.id)?.trim());
		if (name) terminalByDir[d.dir] = stopDisplayName(name);
	}
	return { ...terminalByDir, ...byDir };
}
