export type LiveMapChoice =
	| { kind: 'vehicle'; id: string }
	| { kind: 'line'; id: string; trip?: string };

export function readLiveMapChoice(params: URLSearchParams): LiveMapChoice | null {
	const vehicle = params.get('selectedVehicle');
	const line = params.get('line');
	if (vehicle) return { kind: 'vehicle', id: vehicle };
	if (!line) return null;
	const trip = params.get('lineTrip');
	return { kind: 'line', id: line, ...(trip ? { trip } : {}) };
}

export function setLiveMapChoice(params: URLSearchParams, choice: LiveMapChoice | null): void {
	params.delete('selectedVehicle');
	params.delete('line');
	params.delete('lineTrip');
	if (choice?.kind === 'vehicle') params.set('selectedVehicle', choice.id);
	if (choice?.kind === 'line') {
		params.set('line', choice.id);
		if (choice.trip) params.set('lineTrip', choice.trip);
	}
}
