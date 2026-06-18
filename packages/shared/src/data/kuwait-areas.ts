// packages/shared/src/data/kuwait-areas.ts
export interface KuwaitArea {
  en: string;
  ar: string;
}
export interface KuwaitGovernorate {
  en: string;
  ar: string;
  areas: KuwaitArea[];
}

export const KUWAIT_GOVERNORATES: KuwaitGovernorate[] = [
  {
    en: 'Capital',
    ar: 'العاصمة',
    areas: [
      { en: 'Kuwait City', ar: 'مدينة الكويت' },
      { en: 'Sharq', ar: 'شرق' },
      { en: 'Mirqab', ar: 'المرقاب' },
      { en: 'Jibla', ar: 'جبلة' },
      { en: 'Dasma', ar: 'الدسمة' },
      { en: 'Daiya', ar: 'الدعية' },
      { en: 'Mansouriya', ar: 'المنصورية' },
      { en: 'Bnaid Al-Qar', ar: 'بنيد القار' },
      { en: 'Kaifan', ar: 'كيفان' },
      { en: 'Faiha', ar: 'الفيحاء' },
      { en: 'Shamiya', ar: 'الشامية' },
      { en: 'Rawda', ar: 'الروضة' },
      { en: 'Adailiya', ar: 'العديلية' },
      { en: 'Khaldiya', ar: 'الخالدية' },
      { en: 'Qadsiya', ar: 'القادسية' },
      { en: 'Nuzha', ar: 'النزهة' },
      { en: 'Yarmouk', ar: 'اليرموك' },
      { en: 'Qortuba', ar: 'قرطبة' },
      { en: 'Surra', ar: 'السرة' },
      { en: 'Abdullah Al-Salem', ar: 'ضاحية عبدالله السالم' },
      { en: 'Shaab', ar: 'الشعب' },
      { en: 'Doha', ar: 'الدوحة' },
      { en: 'Sulaibikhat', ar: 'الصليبخات' },
      { en: 'Granada', ar: 'غرناطة' },
      { en: 'Qairawan', ar: 'القيروان' },
      { en: 'Nahda', ar: 'النهضة' },
      { en: 'North West Sulaibikhat', ar: 'شمال غرب الصليبخات' },
      { en: 'Shuwaikh Residential', ar: 'الشويخ السكنية' },
      { en: 'Shuwaikh Industrial', ar: 'الشويخ الصناعية' },
    ],
  },
  {
    en: 'Hawalli',
    ar: 'حولي',
    areas: [
      { en: 'Hawalli', ar: 'حولي' },
      { en: 'Salmiya', ar: 'السالمية' },
      { en: 'Rumaithiya', ar: 'الرميثية' },
      { en: 'Jabriya', ar: 'الجابرية' },
      { en: 'Bayan', ar: 'بيان' },
      { en: 'Mishref', ar: 'مشرف' },
      { en: 'Salwa', ar: 'سلوى' },
      { en: 'Maidan Hawalli', ar: 'ميدان حولي' },
      { en: 'Al-Bidaa', ar: 'البدع' },
      { en: 'Anjafa', ar: 'أنجفة' },
      { en: 'Shuhada', ar: 'الشهداء' },
      { en: 'Salam', ar: 'سلام' },
      { en: 'Zahra', ar: 'الزهراء' },
      { en: 'Hitteen', ar: 'حطين' },
      { en: 'Al-Siddiq', ar: 'الصديق' },
      { en: 'Mubarak Al-Abdullah', ar: 'مبارك العبدالله' },
    ],
  },
  {
    en: 'Farwaniya',
    ar: 'الفروانية',
    areas: [
      { en: 'Farwaniya', ar: 'الفروانية' },
      { en: 'Khaitan', ar: 'خيطان' },
      { en: 'Abraq Khaitan', ar: 'أبرق خيطان' },
      { en: 'Omariya', ar: 'العمرية' },
      { en: 'Rabiya', ar: 'الرابية' },
      { en: 'Andalus', ar: 'الأندلس' },
      { en: 'Riggae', ar: 'الرقعي' },
      { en: 'Ferdous', ar: 'الفردوس' },
      { en: 'Ardiya', ar: 'العارضية' },
      { en: 'Sabah Al-Nasser', ar: 'صباح الناصر' },
      { en: 'Ishbiliya', ar: 'إشبيلية' },
      { en: 'Rehab', ar: 'الرحاب' },
      { en: 'Al-Dajeej', ar: 'الضجيج' },
      { en: 'Jleeb Al-Shuyoukh', ar: 'جليب الشيوخ' },
      { en: 'Abdullah Al-Mubarak', ar: 'عبدالله المبارك' },
      { en: 'West Abdullah Al-Mubarak', ar: 'غرب عبدالله المبارك' },
      { en: 'South Abdullah Al-Mubarak', ar: 'جنوب عبدالله المبارك' },
      { en: 'Al-Rai', ar: 'الري' },
    ],
  },
  {
    en: 'Mubarak Al-Kabeer',
    ar: 'مبارك الكبير',
    areas: [
      { en: 'Mubarak Al-Kabeer', ar: 'مبارك الكبير' },
      { en: 'Sabah Al-Salem', ar: 'صباح السالم' },
      { en: 'Al-Adan', ar: 'العدان' },
      { en: 'Al-Qusour', ar: 'القصور' },
      { en: 'Al-Qurain', ar: 'القرين' },
      { en: 'Abu Ftaira', ar: 'أبو فطيرة' },
      { en: 'Messila', ar: 'المسيلة' },
      { en: 'Al-Masayel', ar: 'المسايل' },
      { en: 'Al-Fnaitees', ar: 'الفنيطيس' },
      { en: 'Abu Al-Hasaniya', ar: 'أبو الحصانية' },
      { en: 'Wista', ar: 'الوسطى' },
      { en: 'Sabhan Industrial', ar: 'صبحان الصناعية' },
    ],
  },
  {
    en: 'Ahmadi',
    ar: 'الأحمدي',
    areas: [
      { en: 'Fahaheel', ar: 'الفحيحيل' },
      { en: 'Mangaf', ar: 'المنقف' },
      { en: 'Mahboula', ar: 'المهبولة' },
      { en: 'Abu Halifa', ar: 'أبو حليفة' },
      { en: 'Fintas', ar: 'الفنطاس' },
      { en: 'Egaila', ar: 'العقيلة' },
      { en: 'Sabahiya', ar: 'الصباحية' },
      { en: 'Riqqa', ar: 'الرقة' },
      { en: 'Hadiya', ar: 'هدية' },
      { en: 'Jaber Al-Ali', ar: 'جابر العلي' },
      { en: 'Dhaher', ar: 'الظهر' },
      { en: 'Ali Sabah Al-Salem', ar: 'علي صباح السالم' },
      { en: 'Umm Al-Haiman', ar: 'أم الهيمان' },
      { en: 'Khairan', ar: 'الخيران' },
      { en: 'Magwa', ar: 'المقوع' },
      { en: 'Sabah Al-Ahmad', ar: 'صباح الأحمد' },
      { en: 'Ahmadi', ar: 'الأحمدي' },
      { en: 'Mina Abdulla', ar: 'ميناء عبدالله' },
      { en: 'Wafra', ar: 'الوفرة' },
      { en: 'Bnaider', ar: 'بنيدر' },
      { en: 'Julaia', ar: 'الجليعة' },
      { en: 'Zoor', ar: 'الزور' },
    ],
  },
  {
    en: 'Jahra',
    ar: 'الجهراء',
    areas: [
      { en: 'Jahra', ar: 'الجهراء' },
      { en: 'Naeem', ar: 'النعيم' },
      { en: 'Nasseem', ar: 'النسيم' },
      { en: 'Oyoun', ar: 'العيون' },
      { en: 'Qasr', ar: 'القصر' },
      { en: 'Waha', ar: 'الواحة' },
      { en: 'Taima', ar: 'تيماء' },
      { en: 'Saad Al-Abdullah', ar: 'سعد العبدالله' },
      { en: 'Sulaibiya', ar: 'الصليبية' },
      { en: 'Sulaibiya Residential', ar: 'الصليبية السكنية' },
      { en: 'Kabd', ar: 'كبد' },
      { en: 'Subiya', ar: 'الصبية' },
      { en: 'Amghara Industrial', ar: 'أمغرة' },
    ],
  },
];

export const GOVERNORATES_EN = KUWAIT_GOVERNORATES.map(g => g.en);

export function areasForGovernorate(governorateEn: string): KuwaitArea[] {
  return KUWAIT_GOVERNORATES.find(g => g.en === governorateEn)?.areas ?? [];
}

export function findGovernorateByArea(areaEn: string): KuwaitGovernorate | undefined {
  return KUWAIT_GOVERNORATES.find(g => g.areas.some(a => a.en === areaEn));
}
