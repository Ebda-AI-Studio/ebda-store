// packages/shared/src/data/egypt-areas.ts
//
// Governorate → major cities/districts for Egyptian addresses and per-area
// shipping rates. The 27 governorates come from `REGION.governorates`
// (region/governorates.ts, ISO 3166-2:EG codes); this file only adds the
// selectable `areas` under each. The list is deliberately the well-known
// cities/districts, not an exhaustive gazetteer — merchants add custom areas
// in the shipping editor (the API accepts any area under a governorate).
import { REGION } from '../region';

export interface EgyptArea {
  en: string;
  ar: string;
}
export interface EgyptGovernorate {
  /** ISO 3166-2:EG subdivision code without the `EG-` prefix (e.g. `C`, `GZ`). */
  code: string;
  en: string;
  ar: string;
  areas: EgyptArea[];
}

const AREAS: Record<string, EgyptArea[]> = {
  C: [
    { en: 'Nasr City', ar: 'مدينة نصر' },
    { en: 'Heliopolis', ar: 'مصر الجديدة' },
    { en: 'Maadi', ar: 'المعادي' },
    { en: 'New Cairo', ar: 'القاهرة الجديدة' },
    { en: 'Zamalek', ar: 'الزمالك' },
    { en: 'Downtown', ar: 'وسط البلد' },
    { en: 'Shubra', ar: 'شبرا' },
    { en: 'Mokattam', ar: 'المقطم' },
    { en: 'Ain Shams', ar: 'عين شمس' },
    { en: 'Helwan', ar: 'حلوان' },
    { en: 'Shorouk City', ar: 'مدينة الشروق' },
    { en: 'Badr City', ar: 'مدينة بدر' },
    { en: 'New Administrative Capital', ar: 'العاصمة الإدارية الجديدة' },
  ],
  GZ: [
    { en: 'Dokki', ar: 'الدقي' },
    { en: 'Mohandessin', ar: 'المهندسين' },
    { en: 'Agouza', ar: 'العجوزة' },
    { en: 'Haram', ar: 'الهرم' },
    { en: 'Faisal', ar: 'فيصل' },
    { en: '6th of October City', ar: 'مدينة السادس من أكتوبر' },
    { en: 'Sheikh Zayed', ar: 'الشيخ زايد' },
    { en: 'Imbaba', ar: 'إمبابة' },
    { en: 'Hadayek El Ahram', ar: 'حدائق الأهرام' },
  ],
  ALX: [
    { en: 'Smouha', ar: 'سموحة' },
    { en: 'Montaza', ar: 'المنتزه' },
    { en: 'Miami', ar: 'ميامي' },
    { en: 'Sidi Gaber', ar: 'سيدي جابر' },
    { en: 'Roushdy', ar: 'رشدي' },
    { en: 'Laurent', ar: 'لوران' },
    { en: 'Mansheya', ar: 'المنشية' },
    { en: 'Agami', ar: 'العجمي' },
    { en: 'Borg El Arab', ar: 'برج العرب' },
  ],
  KB: [
    { en: 'Banha', ar: 'بنها' },
    { en: 'Shubra El Kheima', ar: 'شبرا الخيمة' },
    { en: 'Qalyub', ar: 'قليوب' },
    { en: 'Obour City', ar: 'مدينة العبور' },
    { en: 'Khanka', ar: 'الخانكة' },
    { en: 'Shibin El Qanater', ar: 'شبين القناطر' },
  ],
  PTS: [
    { en: 'Port Said', ar: 'بورسعيد' },
    { en: 'Port Fouad', ar: 'بورفؤاد' },
  ],
  SUZ: [
    { en: 'Suez', ar: 'السويس' },
    { en: 'Ain Sokhna', ar: 'العين السخنة' },
  ],
  DK: [
    { en: 'Mansoura', ar: 'المنصورة' },
    { en: 'Mit Ghamr', ar: 'ميت غمر' },
    { en: 'Talkha', ar: 'طلخا' },
    { en: 'Dikirnis', ar: 'دكرنس' },
    { en: 'Belqas', ar: 'بلقاس' },
    { en: 'Sherbin', ar: 'شربين' },
    { en: 'Aga', ar: 'أجا' },
  ],
  SHR: [
    { en: 'Zagazig', ar: 'الزقازيق' },
    { en: '10th of Ramadan City', ar: 'مدينة العاشر من رمضان' },
    { en: 'Belbeis', ar: 'بلبيس' },
    { en: 'Minya Al Qamh', ar: 'منيا القمح' },
    { en: 'Abu Kabir', ar: 'أبو كبير' },
    { en: 'Faqous', ar: 'فاقوس' },
  ],
  GH: [
    { en: 'Tanta', ar: 'طنطا' },
    { en: 'El Mahalla El Kubra', ar: 'المحلة الكبرى' },
    { en: 'Kafr El Zayat', ar: 'كفر الزيات' },
    { en: 'Zefta', ar: 'زفتى' },
    { en: 'Samannoud', ar: 'سمنود' },
    { en: 'Basyoun', ar: 'بسيون' },
  ],
  MNF: [
    { en: 'Shebin El Kom', ar: 'شبين الكوم' },
    { en: 'Menouf', ar: 'منوف' },
    { en: 'Sadat City', ar: 'مدينة السادات' },
    { en: 'Ashmoun', ar: 'أشمون' },
    { en: 'Quesna', ar: 'قويسنا' },
    { en: 'Tala', ar: 'تلا' },
  ],
  BH: [
    { en: 'Damanhur', ar: 'دمنهور' },
    { en: 'Kafr El Dawar', ar: 'كفر الدوار' },
    { en: 'Rashid', ar: 'رشيد' },
    { en: 'Edku', ar: 'إدكو' },
    { en: 'Abu Hummus', ar: 'أبو حمص' },
    { en: 'Kom Hamada', ar: 'كوم حمادة' },
    { en: 'Wadi El Natrun', ar: 'وادي النطرون' },
  ],
  KFS: [
    { en: 'Kafr El Sheikh', ar: 'كفر الشيخ' },
    { en: 'Desouk', ar: 'دسوق' },
    { en: 'Baltim', ar: 'بلطيم' },
    { en: 'Qallin', ar: 'قلين' },
    { en: 'Fuwwah', ar: 'فوه' },
    { en: 'Metoubes', ar: 'مطوبس' },
  ],
  DT: [
    { en: 'Damietta', ar: 'دمياط' },
    { en: 'New Damietta', ar: 'دمياط الجديدة' },
    { en: 'Ras El Bar', ar: 'رأس البر' },
    { en: 'Faraskur', ar: 'فارسكور' },
    { en: 'Kafr Saad', ar: 'كفر سعد' },
  ],
  IS: [
    { en: 'Ismailia', ar: 'الإسماعيلية' },
    { en: 'Fayed', ar: 'فايد' },
    { en: 'Qantara Gharb', ar: 'القنطرة غرب' },
    { en: 'Qantara Sharq', ar: 'القنطرة شرق' },
    { en: 'Tell El Kebir', ar: 'التل الكبير' },
  ],
  FYM: [
    { en: 'Faiyum', ar: 'الفيوم' },
    { en: 'Sinnuris', ar: 'سنورس' },
    { en: 'Tamiya', ar: 'طامية' },
    { en: 'Ibsheway', ar: 'إبشواي' },
    { en: 'Itsa', ar: 'إطسا' },
    { en: 'Youssef El Seddik', ar: 'يوسف الصديق' },
  ],
  BNS: [
    { en: 'Beni Suef', ar: 'بني سويف' },
    { en: 'Beba', ar: 'ببا' },
    { en: 'El Fashn', ar: 'الفشن' },
    { en: 'Nasser', ar: 'ناصر' },
    { en: 'Ihnasya', ar: 'إهناسيا' },
    { en: 'Samasta', ar: 'سمسطا' },
    { en: 'El Wasta', ar: 'الواسطى' },
  ],
  MN: [
    { en: 'Minya', ar: 'المنيا' },
    { en: 'Mallawi', ar: 'ملوي' },
    { en: 'Samalut', ar: 'سمالوط' },
    { en: 'Maghagha', ar: 'مغاغة' },
    { en: 'Beni Mazar', ar: 'بني مزار' },
    { en: 'Abu Qirqas', ar: 'أبو قرقاص' },
    { en: 'Deir Mawas', ar: 'دير مواس' },
  ],
  AST: [
    { en: 'Assiut', ar: 'أسيوط' },
    { en: 'Dairut', ar: 'ديروط' },
    { en: 'Manfalut', ar: 'منفلوط' },
    { en: 'Abnub', ar: 'أبنوب' },
    { en: 'El Qusiya', ar: 'القوصية' },
    { en: 'Abutig', ar: 'أبوتيج' },
    { en: 'Sahel Selim', ar: 'ساحل سليم' },
  ],
  SHG: [
    { en: 'Sohag', ar: 'سوهاج' },
    { en: 'Akhmim', ar: 'أخميم' },
    { en: 'Girga', ar: 'جرجا' },
    { en: 'Tahta', ar: 'طهطا' },
    { en: 'El Balyana', ar: 'البلينا' },
    { en: 'El Maragha', ar: 'المراغة' },
    { en: 'Tima', ar: 'طما' },
  ],
  KN: [
    { en: 'Qena', ar: 'قنا' },
    { en: 'Nag Hammadi', ar: 'نجع حمادي' },
    { en: 'Dishna', ar: 'دشنا' },
    { en: 'Qus', ar: 'قوص' },
    { en: 'Abu Tesht', ar: 'أبو تشت' },
    { en: 'Farshut', ar: 'فرشوط' },
    { en: 'Naqada', ar: 'نقادة' },
  ],
  LX: [
    { en: 'Luxor', ar: 'الأقصر' },
    { en: 'Esna', ar: 'إسنا' },
    { en: 'Armant', ar: 'أرمنت' },
    { en: 'El Tod', ar: 'الطود' },
  ],
  ASN: [
    { en: 'Aswan', ar: 'أسوان' },
    { en: 'Edfu', ar: 'إدفو' },
    { en: 'Kom Ombo', ar: 'كوم أمبو' },
    { en: 'Daraw', ar: 'دراو' },
    { en: 'Nasr El Nuba', ar: 'نصر النوبة' },
    { en: 'Abu Simbel', ar: 'أبو سمبل' },
  ],
  BA: [
    { en: 'Hurghada', ar: 'الغردقة' },
    { en: 'El Gouna', ar: 'الجونة' },
    { en: 'Safaga', ar: 'سفاجا' },
    { en: 'Quseir', ar: 'القصير' },
    { en: 'Marsa Alam', ar: 'مرسى علم' },
    { en: 'Ras Gharib', ar: 'رأس غارب' },
    { en: 'Shalateen', ar: 'الشلاتين' },
  ],
  WAD: [
    { en: 'Kharga', ar: 'الخارجة' },
    { en: 'Dakhla', ar: 'الداخلة' },
    { en: 'Farafra', ar: 'الفرافرة' },
    { en: 'Paris', ar: 'باريس' },
    { en: 'Balat', ar: 'بلاط' },
  ],
  MT: [
    { en: 'Marsa Matrouh', ar: 'مرسى مطروح' },
    { en: 'El Alamein', ar: 'العلمين' },
    { en: 'Siwa', ar: 'سيوة' },
    { en: 'Sidi Barrani', ar: 'سيدي براني' },
    { en: 'El Hammam', ar: 'الحمام' },
    { en: 'El Dabaa', ar: 'الضبعة' },
    { en: 'Salloum', ar: 'السلوم' },
  ],
  SIN: [
    { en: 'Arish', ar: 'العريش' },
    { en: 'Sheikh Zuweid', ar: 'الشيخ زويد' },
    { en: 'Rafah', ar: 'رفح' },
    { en: 'Bir al-Abd', ar: 'بئر العبد' },
    { en: 'Nakhl', ar: 'نخل' },
    { en: 'Hasana', ar: 'الحسنة' },
  ],
  JS: [
    { en: 'Sharm El Sheikh', ar: 'شرم الشيخ' },
    { en: 'Dahab', ar: 'دهب' },
    { en: 'Nuweiba', ar: 'نويبع' },
    { en: 'Taba', ar: 'طابا' },
    { en: 'Saint Catherine', ar: 'سانت كاترين' },
    { en: 'El Tor', ar: 'الطور' },
    { en: 'Ras Sudr', ar: 'رأس سدر' },
    { en: 'Abu Zenima', ar: 'أبو زنيمة' },
  ],
};

/** The 27 governorates, each with its selectable cities/districts. */
export const EGYPT_GOVERNORATES: EgyptGovernorate[] = REGION.governorates.map(g => ({
  code: g.code,
  en: g.nameEn,
  ar: g.nameAr,
  areas: AREAS[g.code] ?? [],
}));

export const GOVERNORATES_EN = EGYPT_GOVERNORATES.map(g => g.en);

export function areasForGovernorate(governorateEn: string): EgyptArea[] {
  return EGYPT_GOVERNORATES.find(g => g.en === governorateEn)?.areas ?? [];
}

export function findGovernorateByArea(areaEn: string): EgyptGovernorate | undefined {
  return EGYPT_GOVERNORATES.find(g => g.areas.some(a => a.en === areaEn));
}
