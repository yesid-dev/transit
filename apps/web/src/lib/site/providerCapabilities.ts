export function providerHasAlerts<T extends { inputs: Record<string, boolean> }>(
	provider: T | null | undefined,
): boolean {
	return !(provider?.inputs.i3_alerts === false && provider.inputs.service_alerts === false);
}

export function vehicleTrackingDisabled(
	provider: { inputs: Record<string, boolean> } | null | undefined,
): boolean {
	return (
		provider?.inputs.vehicle_positions === false || provider?.inputs.stable_vehicle_ids === false
	);
}

export function lineIsScheduleOnly(
	provider:
		| {
				lines_without_live_data: readonly {
					route_ids: readonly string[];
					route_types: readonly number[];
				}[];
		  }
		| null
		| undefined,
	id: string,
	type: number | null,
): boolean {
	return (
		provider?.lines_without_live_data.some(
			(gap) => gap.route_ids.includes(id) || (type !== null && gap.route_types.includes(type)),
		) ?? false
	);
}

/** Whether a city declares any line without live data; unknown cities keep the rail key. */
export function hasScheduleOnlyLines(provider: Parameters<typeof lineIsScheduleOnly>[0]): boolean {
	return (
		provider?.lines_without_live_data.some(
			(gap) => gap.route_ids.length > 0 || gap.route_types.length > 0,
		) ?? true
	);
}
