// Writes public/site-nav.js from SITE_NAV_JS (packages/shared/src/brand): the one header-nav behaviour every Ebda site
// serves. tests/unit/site-nav-behaviour.test.ts fails until this has been run after a change to the constant.
//   npm run site-nav-js -w apps/marketing
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_NAV_JS } from '@ebda/shared/brand';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'site-nav.js');
writeFileSync(file, SITE_NAV_JS);
console.log(`wrote ${file}`);
