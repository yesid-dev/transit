import { z } from 'zod';
import {
	VehicleSchema as PublishedVehicleSchema,
	VehiclesFileSchema as PublishedVehiclesFileSchema,
} from './generated/live_vehicles';

import { LiveStatusCodeSchema } from './types';

export const VehicleSchema = PublishedVehicleSchema.extend({
	direction_id: z.int().nonnegative().nullable().optional(),
});
export const VehiclesFileSchema = PublishedVehiclesFileSchema.extend({
	vehicles: z.array(VehicleSchema),
});
export const LiveVehicleSchema = VehicleSchema.extend({ status: LiveStatusCodeSchema });
export type Vehicle = z.infer<typeof LiveVehicleSchema>;
export const LiveVehiclesFileSchema = VehiclesFileSchema.extend({
	vehicles: z.array(LiveVehicleSchema),
});
export type VehiclesFile = z.infer<typeof LiveVehiclesFileSchema>;
