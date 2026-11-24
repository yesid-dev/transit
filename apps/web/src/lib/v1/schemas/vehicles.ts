import { z } from 'zod';
import {
	VehicleSchema as PublishedVehicleSchema,
	VehiclesFileSchema as PublishedVehiclesFileSchema,
} from './generated/live_vehicles';

import { StatusCodeSchema } from './types';

export const VehicleSchema = PublishedVehicleSchema.extend({
	status: StatusCodeSchema,
	direction_id: z.int().nonnegative().nullable().optional(),
});
export type Vehicle = z.infer<typeof VehicleSchema>;
export const VehiclesFileSchema = PublishedVehiclesFileSchema.extend({
	vehicles: z.array(VehicleSchema),
});
export type VehiclesFile = z.infer<typeof VehiclesFileSchema>;
