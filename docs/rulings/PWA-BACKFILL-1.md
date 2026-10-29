# PWA-BACKFILL-1

**Ruling PWA-BACKFILL-1 - the PWA icon backfill is a Node script with an injected `sharp`
resizer, not a Worker job, and it never runs from an agent.** `scripts/backfill-store-pwa-icons.ts`
already existed but was stale (run through the retired `railway run`, source limited to an existing
icon512/icon192, so a store with only a logo was skipped, no cursor, no real race check). It now:
takes `iconSource`, else icon512, else icon192, else the store logo, and skips a store with none;
fetches ONLY the platform's own media origins (`media.ebda.app` plus the host of `STORAGE_PUBLIC_URL`, via `isEbdaMediaUrl`; a hostname screen is bypassable by a public DNS name that resolves to loopback/LAN, and the script holds prod credentials), refuses every redirect (`redirect: 'manual'`), logs every other source as skipped `source_not_platform_media`, and requires a decodable image of at least 256px (a square PNG of 512+ is
used as is, any other logo is centred on a transparent square); is DRY RUN unless `--apply`;
skips a store whose pwaSettings already carry all 8 icon keys and re-reads the settings right
before the write so a merchant's own upload wins; walks stores by id in batches with `--after` and
`--limit` so a crashed run resumes by re-running. Resizing uses `sharp` through a new
`generatePwaIconSet(..., { resizer })` option (sizes still verified, versioned keys unchanged)
because the Cloudflare Images binding (Ruling D1016-ICONS-1) exists only inside the Worker, and
without it the generator would store the 512px source under the 16px favicon key and raise the
resize-fallback P1. Cost if wrong: if the owner runs it without R2 credentials in the shell, every
store fails loudly at upload and nothing is written; if a logo is a poor icon the store gets a
poor icon until the merchant uploads their own, which always replaces it.
