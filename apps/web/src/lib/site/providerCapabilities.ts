export function providerHasAlerts<T extends { inputs: Record<string, boolean> }>(
	provider: T | null | undefined,
): boolean {
	return !(provider?.inputs.i3_alerts === false && provider.inputs.service_alerts === false);
}
