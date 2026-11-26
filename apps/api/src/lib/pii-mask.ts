/**
 * Contact masking for surfaces whose output leaves the platform (merchant MCP tools, log drain, Sentry text). The implementation moved to the
 * foundation (`observe/mask`, vendored, byte-pinned by foundation.lock.json; Ruling FDN-OBSERVE-1); this file keeps the old import path.
 * Behaviour differences from the pre-move code are listed in the F6 PR: `maskPhone` and `redactFreeText` now also read Arabic-Indic and Persian digits.
 */
export {
  SCRUB_EMAILS_MAX,
  maskAddress,
  maskEmail,
  maskEmailList,
  maskIp,
  maskPhone,
  redactFreeText,
  scrubEmails,
} from '@ebda/shared/observe';
