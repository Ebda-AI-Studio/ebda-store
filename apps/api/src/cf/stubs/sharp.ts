// `sharp` is a native addon. On Workers, image work is Cloudflare Images (resize on
// delivery) and the services that used sharp take a Workers branch
// (services/image-resize.service.ts); anything that still reaches this stub is a
// listed TODO (docs/ebda/design/stage1-worker-status.md), not a silent no-op.
import { unavailable } from './_unavailable';

function sharp(): never {
  return unavailable('sharp', 'use Cloudflare Images (resize on delivery)');
}
export default sharp;
