import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

// the progressive account delay (M-066) would make a 15-request burst take minutes; the SHAPE is tested, not the clock
import { setBrakeBaseMs } from '../src/throttle';
setBrakeBaseMs(1);
