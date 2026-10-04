// `pino` on Workers: lib/logger.ts uses lib/console-logger.ts (console JSON).
import { unavailable } from './_unavailable';

function pino(): never {
  return unavailable('pino', 'lib/logger.ts uses the console JSON logger');
}
pino.transport = (): never => unavailable('pino.transport', 'worker_threads');
export default pino;
