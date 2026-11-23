// Lists candidate formal-MSA strings in the admin ar.json for manual review.
import { readFileSync } from 'node:fs';
const file = process.argv[2] ?? 'apps/admin/src/i18n/messages/ar.json';
const markers = ['الذين','اللذين','التي ','يمكن','لا تحتاج','سيصل','سوف','قم ب','انقر','إذا','لماذا','يتطلب','كحد أقصى','ستحتاج','لن ','تم ','ستظهر','سيتم','يجب أن','عليك أن','حيث','وذلك','لكي','بإمكانك','يرجى','كما '];
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' && v ? flat(v, p ? `${p}.${k}` : k) : [[p ? `${p}.${k}` : k, String(v)]]);
const rows = flat(JSON.parse(readFileSync(file, 'utf8')));
let n = 0;
for (const [k, v] of rows) {
  if (markers.some((m) => v.includes(m)) || /(^|\s)ي[ُ][؀-ۿ]+/.test(v)) { console.log(`${k}\t${v}`); n++; }
}
console.error(`${n} candidates / ${rows.length} strings`);
