// The Gmail alert poller is Ebda ops plumbing (R-EBDA-001 §5: dropped). Ebda's alerts
// come from Sentry and the status page.
import { unavailable } from './_unavailable';

export class ImapFlow {
  constructor() {
    unavailable('imapflow', 'the Gmail alert poller is not part of the Ebda Store API');
  }
}
