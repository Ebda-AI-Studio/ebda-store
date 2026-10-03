/**
 * The 27 governorates (muhafazat) of Egypt. `code` is the ISO 3166-2:EG
 * subdivision code (without the `EG-` prefix) — stable, ASCII, safe to store.
 */
export interface Governorate {
  code: string;
  nameEn: string;
  nameAr: string;
}

export const EGYPT_GOVERNORATE_LIST: readonly Governorate[] = [
  { code: 'C', nameEn: 'Cairo', nameAr: 'القاهرة' },
  { code: 'GZ', nameEn: 'Giza', nameAr: 'الجيزة' },
  { code: 'ALX', nameEn: 'Alexandria', nameAr: 'الإسكندرية' },
  { code: 'KB', nameEn: 'Qalyubia', nameAr: 'القليوبية' },
  { code: 'PTS', nameEn: 'Port Said', nameAr: 'بورسعيد' },
  { code: 'SUZ', nameEn: 'Suez', nameAr: 'السويس' },
  { code: 'DK', nameEn: 'Dakahlia', nameAr: 'الدقهلية' },
  { code: 'SHR', nameEn: 'Sharqia', nameAr: 'الشرقية' },
  { code: 'GH', nameEn: 'Gharbia', nameAr: 'الغربية' },
  { code: 'MNF', nameEn: 'Monufia', nameAr: 'المنوفية' },
  { code: 'BH', nameEn: 'Beheira', nameAr: 'البحيرة' },
  { code: 'KFS', nameEn: 'Kafr El Sheikh', nameAr: 'كفر الشيخ' },
  { code: 'DT', nameEn: 'Damietta', nameAr: 'دمياط' },
  { code: 'IS', nameEn: 'Ismailia', nameAr: 'الإسماعيلية' },
  { code: 'FYM', nameEn: 'Faiyum', nameAr: 'الفيوم' },
  { code: 'BNS', nameEn: 'Beni Suef', nameAr: 'بني سويف' },
  { code: 'MN', nameEn: 'Minya', nameAr: 'المنيا' },
  { code: 'AST', nameEn: 'Assiut', nameAr: 'أسيوط' },
  { code: 'SHG', nameEn: 'Sohag', nameAr: 'سوهاج' },
  { code: 'KN', nameEn: 'Qena', nameAr: 'قنا' },
  { code: 'LX', nameEn: 'Luxor', nameAr: 'الأقصر' },
  { code: 'ASN', nameEn: 'Aswan', nameAr: 'أسوان' },
  { code: 'BA', nameEn: 'Red Sea', nameAr: 'البحر الأحمر' },
  { code: 'WAD', nameEn: 'New Valley', nameAr: 'الوادي الجديد' },
  { code: 'MT', nameEn: 'Matrouh', nameAr: 'مطروح' },
  { code: 'SIN', nameEn: 'North Sinai', nameAr: 'شمال سيناء' },
  { code: 'JS', nameEn: 'South Sinai', nameAr: 'جنوب سيناء' },
];
