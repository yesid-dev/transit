import { z } from 'zod';

// Zod probes dynamic code generation when a schema is constructed.
if (typeof window !== 'undefined') z.config({ jitless: true });
