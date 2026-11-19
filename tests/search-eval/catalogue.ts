/**
 * Search quality eval set (search program P1, Task 13; Ruling SEARCH-10).
 *
 * SYNTHETIC store, clearly labelled (plan amendment E24: no real catalogue exists). Product names
 * are written the way Egyptian merchants title products (Jumia Egypt Arabic titles, Egyptian shop
 * pages). Queries are what shoppers type. Vocabulary source: `franco-vocab.json` next to this file
 * (264 terms, 787 Franco spellings, collected online 2026-10-15, every term with its source URLs;
 * `franco_seen` = seen verbatim at a cited source, the rest is convention-derived). Fashion Franco
 * is mostly seen online; food / electronics / home Franco is convention-derived (3=ع, 7=ح, 5=خ,
 * 2=ق/ء, g=ج) because the vocab collection is fashion-heavy.
 *
 * Relevance is by product TYPE: every product of a type (the target `key` and its `siblings`)
 * answers that type's queries; a shopper typing "kotshy" is served by any pair of sneakers.
 * `EVAL_NEGATIVES` are products of OTHER types that share a word or a substring with a target
 * (`شراب` socks vs a berry syrup, `خلاط` blender vs a mixer tap, `بوت` inside `بوتاجاز`,
 * `كحل` inside `كحلي`, `مج` inside `مجمدة`): they are never relevant and catch precision loss.
 * Some types are deliberately dense (21 t-shirts, 11 abayas, 11 sneakers) because real Egyptian
 * fashion stores are, and the keyword-strong threshold (KEYWORD_STRONG_AT) only matters for
 * queries with 20+ keyword matches.
 *
 * Core set = 50 types × 4 forms = 200 queries; the pass bar (SEARCH-10) is computed on it.
 * `EVAL_EXTRA` adds typo / orthographic-variant / mixed-script / real-phrase queries, reported per
 * class but not part of the bar. Deviations from the plan's draft queries (each from the vocab):
 * abaya franco `soda` → `souda` (seen; `soda` is also the drink), boots dialect was the product
 * name verbatim → `بوط حريمي`, slippers msa `نعال` → `خف` (the vocab's MSA), t-shirt franco
 * `tshirt` → `teshert` (vocab), pajama franco `bejama` → `bijama` (vocab).
 */

export interface EvalQueries {
  /** Modern Standard Arabic, correct hamza and taa marbuta. */
  msa: string;
  /** Egyptian dialect as typed: ه for ة, dropped hamza, dialect words. */
  dialect: string;
  /** Egyptian Franco-Arabic (Arabizi). */
  franco: string;
  en: string;
}

export interface EvalProduct {
  key: string;
  nameAr: string;
  name: string;
  q: EvalQueries;
  /** Other products of the same type: [nameAr, name]. */
  siblings?: ReadonlyArray<readonly [string, string]>;
}

export const EVAL_FORMS = ['msa', 'dialect', 'franco', 'en'] as const;
export type EvalForm = (typeof EVAL_FORMS)[number];

export const EVAL_PRODUCTS: readonly EvalProduct[] = [
  {
    key: 'abaya',
    nameAr: 'عباية كريب سوداء',
    name: 'Black crepe abaya',
    q: { msa: 'عباءة سوداء', dialect: 'عبايه سودا', franco: '3abaya souda', en: 'black abaya' },
    siblings: [
      ['عباية شيفون كحلي', 'Navy chiffon abaya'],
      ['عباية خليجي مطرزة', 'Embroidered Gulf abaya'],
      ['عباية جينز', 'Denim abaya'],
      ['عباية قطيفة نبيتي', 'Burgundy velvet abaya'],
      ['عباية لف بيج', 'Beige wrap abaya'],
      ['عباية بهودي رمادي', 'Grey hooded abaya'],
      ['عباية كاجوال زيتي', 'Olive casual abaya'],
      ['عباية خروج سوداء بالحزام', 'Black going-out abaya with belt'],
      ['عباية رمضانية مطرزة', 'Embroidered Ramadan abaya'],
      ['عباية شامواه بني', 'Brown suede abaya'],
    ],
  },
  {
    key: 'sneakers',
    nameAr: 'حذاء رياضي رجالي',
    name: "Men's sport shoes",
    q: { msa: 'حذاء رياضي', dialect: 'كوتشي رجالي', franco: 'kotshy', en: 'sneakers men' },
    siblings: [
      ['كوتشي أبيض حريمي', "Women's white sneakers"],
      ['كوتشي جري خفيف', 'Lightweight running shoes'],
      ['حذاء رياضي أطفال بالأضواء', 'Kids light-up sport shoes'],
      ['سنيكرز جلد أسود', 'Black leather sneakers'],
      ['كوتشي كانفاس', 'Canvas sneakers'],
      ['حذاء تدريب رجالي', "Men's training shoes"],
      ['كوتش شبك تنفس', 'Breathable mesh trainers'],
      ['حذاء رياضي طبي', 'Orthopaedic sport shoes'],
      ['كوتشي نعل عالي', 'Platform sneakers'],
      ['حذاء مشي حريمي', "Women's walking shoes"],
    ],
  },
  {
    key: 'boots',
    nameAr: 'بوت جلد حريمي',
    name: "Women's leather boots",
    q: { msa: 'حذاء طويل جلد', dialect: 'بوط حريمي', franco: 'boot geld', en: 'leather boots' },
    siblings: [
      ['هاف بوت شامواه', 'Suede half boot'],
      ['بوت كعب عالي', 'High-heel boots'],
      ['بوت رجالي جلد طبيعي', "Men's genuine leather boots"],
      ['بوت مطر أطفال', 'Kids rain boots'],
    ],
  },
  {
    key: 'slippers',
    nameAr: 'شبشب منزلي',
    name: 'House slippers',
    q: { msa: 'خف منزلي', dialect: 'شبشب بيتي', franco: 'shibshib', en: 'slippers' },
    siblings: [
      ['شبشب زنوبة', 'Flip-flops'],
      ['سليبر فرو', 'Fur slipper'],
      ['شبشب طبي رجالي', "Men's orthopaedic slippers"],
    ],
  },
  {
    key: 'handbag',
    nameAr: 'حقيبة يد جلد',
    name: 'Leather handbag',
    q: { msa: 'حقيبة يد', dialect: 'شنطه ايد', franco: 'shanta', en: 'handbag' },
    siblings: [
      ['شنطة كتف حريمي', "Women's shoulder bag"],
      ['شنطة كروس صغيرة', 'Small crossbody bag'],
      ['شنطة توت باج قماش', 'Canvas tote bag'],
      ['كلاتش سهرة ذهبي', 'Gold evening clutch'],
      ['شنطة يد كبيرة بني', 'Large brown handbag'],
      ['شنطة يد بيج بسلسلة', 'Beige chain handbag'],
    ],
  },
  {
    key: 'backpack',
    nameAr: 'حقيبة ظهر مدرسية',
    name: 'School backpack',
    q: { msa: 'حقيبة ظهر', dialect: 'شنطه مدرسه', franco: 'shantet madrasa', en: 'school bag' },
    siblings: [
      ['شنطة ضهر لابتوب', 'Laptop backpack'],
      ['شنطة مدرسة بعجل', 'Wheeled school bag'],
      ['شنطة ضهر رياضية', 'Sports backpack'],
    ],
  },
  {
    key: 'galabeya',
    nameAr: 'جلابية قطن رجالي',
    name: "Men's cotton galabeya",
    q: { msa: 'جلباب رجالي', dialect: 'جلابيه قطن', franco: 'galabeya', en: 'galabiya' },
    siblings: [
      ['جلابية بيتي حريمي', "Women's house galabeya"],
      ['جلابية شتوي صوف', 'Wool winter galabeya'],
      ['جلابية صعيدي', 'Saeedi galabeya'],
    ],
  },
  {
    key: 'isdal',
    nameAr: 'إسدال صلاة',
    name: 'Prayer isdal',
    q: { msa: 'ثوب صلاة', dialect: 'اسدال صلاه', franco: 'esdal', en: 'prayer dress' },
    siblings: [
      ['إسدال مغربي بكابشوه', 'Moroccan hooded isdal'],
      ['إسدال صلاة وخروج', 'Isdal for prayer and going out'],
      ['إسدال أطفال بناتي', "Girls' isdal"],
    ],
  },
  {
    key: 'hijab',
    nameAr: 'طرحة شيفون',
    name: 'Chiffon hijab',
    q: { msa: 'حجاب شيفون', dialect: 'طرحه شيفون', franco: 'tar7a', en: 'hijab' },
    siblings: [
      ['طرحة قطن سادة', 'Plain cotton hijab'],
      ['خمار ماليزي', 'Malaysian khimar'],
      ['طرحة ستان لامعة', 'Shiny satin hijab'],
      ['شال كشمير', 'Cashmere shawl'],
      ['طرحة جيرسيه', 'Jersey hijab'],
      ['إيشارب حرير', 'Silk scarf'],
      ['طرحة مطبوعة', 'Printed hijab'],
    ],
  },
  {
    key: 'tshirt',
    nameAr: 'تيشيرت قطن بيزك',
    name: 'Basic cotton t-shirt',
    q: { msa: 'قميص قطني قصير', dialect: 'تيشرت', franco: 'teshert', en: 't-shirt' },
    siblings: [
      ['تيشيرت أوفر سايز أسود', 'Oversized black t-shirt'],
      ['تيشيرت بولو رجالي', "Men's polo t-shirt"],
      ['تيشيرت مطبوع أطفال', 'Kids printed t-shirt'],
      ['تيشيرت رياضي دراي فيت', 'Dri-fit sport t-shirt'],
      ['تيشيرت حريمي كم طويل', "Women's long-sleeve t-shirt"],
      ['تيشيرت قطن أبيض', 'White cotton t-shirt'],
      ['تيشيرت رقبة V', 'V-neck t-shirt'],
      ['تيشيرت كروب', 'Crop t-shirt'],
      ['تيشيرت مخطط', 'Striped t-shirt'],
      ['تيشيرت انمي', 'Anime t-shirt'],
      ['تيشيرت بيبي قطن', 'Baby cotton t-shirt'],
      ['تيشيرت ليكرا', 'Lycra t-shirt'],
      ['تيشيرت عائلي', 'Family matching t-shirt'],
      ['تيشيرت كحلي سادة', 'Plain navy t-shirt'],
      ['تيشيرت هنلي', 'Henley t-shirt'],
      ['تيشيرت تاي داي', 'Tie-dye t-shirt'],
      ['تيشيرت بجيب', 'Pocket t-shirt'],
      ['تيشيرت زيتي', 'Olive t-shirt'],
      ['تيشيرت مقاس كبير', 'Plus-size t-shirt'],
      ['تيشيرت ملتون', 'Milton t-shirt'],
    ],
  },
  {
    key: 'jeans',
    nameAr: 'بنطلون جينز سليم',
    name: 'Slim jeans',
    q: { msa: 'سروال جينز', dialect: 'بنطلون جينز', franco: 'bantalon jeans', en: 'jeans' },
    siblings: [
      ['جينز واسع حريمي', "Women's wide-leg jeans"],
      ['جينز ممزق', 'Ripped jeans'],
      ['بنطلون جينز أطفال', 'Kids jeans'],
      ['جينز مستقيم رجالي', "Men's straight jeans"],
      ['جينز بوي فريند', 'Boyfriend jeans'],
      ['جينز أسود', 'Black jeans'],
      ['جينز مام فيت', 'Mom-fit jeans'],
    ],
  },
  {
    key: 'pajama',
    nameAr: 'بيجامة شتوي',
    name: 'Winter pajamas',
    q: { msa: 'ملابس نوم شتوية', dialect: 'بيجامه شتوي', franco: 'bijama', en: 'pajamas' },
    siblings: [
      ['بيجامة قطن صيفي', 'Summer cotton pajamas'],
      ['بيجامة أطفال كرتون', 'Kids cartoon pajamas'],
      ['بيجامة ستان حريمي', "Women's satin pajamas"],
      ['بيجامة كستور رجالي', "Men's flannel pajamas"],
    ],
  },
  {
    key: 'socks',
    nameAr: 'شراب قطن',
    name: 'Cotton socks',
    q: { msa: 'جوارب قطن', dialect: 'شراب', franco: 'shrab', en: 'socks' },
    siblings: [
      ['شراب رياضي', 'Sport socks'],
      ['شراب أطفال', 'Kids socks'],
      ['شراب طبي ضاغط', 'Compression socks'],
    ],
  },
  {
    key: 'underwear',
    nameAr: 'طقم داخلي رجالي',
    name: "Men's underwear set",
    q: { msa: 'ملابس داخلية', dialect: 'هدوم داخليه', franco: 'hdoum dakhleya', en: 'underwear' },
    siblings: [
      ['بوكسر قطن رجالي', "Men's cotton boxers"],
      ['فانلة داخلي قطن', 'Cotton undershirt'],
    ],
  },
  {
    key: 'perfume',
    nameAr: 'برفان عود',
    name: 'Oud perfume',
    q: { msa: 'عطر عود', dialect: 'برفيوم عود', franco: 'parfan 3od', en: 'oud perfume' },
    siblings: [
      ['برفان مسك', 'Musk perfume'],
      ['عطر فرنسي حريمي', "Women's French perfume"],
      ['برفيوم رجالي خشبي', "Men's woody perfume"],
      ['زيت عطري عود', 'Oud perfume oil'],
      ['بودي سبلاش', 'Body splash'],
      ['عطر مركز ٥٠ مل', '50 ml concentrated perfume'],
    ],
  },
  {
    key: 'bakhoor',
    nameAr: 'بخور معطر',
    name: 'Scented incense',
    q: { msa: 'بخور', dialect: 'بخور للبيت', franco: 'bo5oor', en: 'incense' },
    siblings: [
      ['بخور عود', 'Oud incense'],
      ['بخور مسك', 'Musk incense'],
    ],
  },
  {
    key: 'lipstick',
    nameAr: 'روج مات',
    name: 'Matte lipstick',
    q: { msa: 'أحمر شفاه', dialect: 'روج', franco: 'rouge', en: 'lipstick' },
    siblings: [
      ['روج سائل ثابت', 'Long-lasting liquid lipstick'],
      ['روج أحمر', 'Red lipstick'],
    ],
  },
  {
    key: 'kohl',
    nameAr: 'كحل عيون أسود',
    name: 'Black kohl eyeliner',
    q: { msa: 'كحل', dialect: 'كحل اسود', franco: 'ko7l', en: 'eyeliner' },
    siblings: [
      ['آيلاينر سائل', 'Liquid eyeliner'],
      ['كحل عربي حجر', 'Arabic stone kohl'],
    ],
  },
  {
    key: 'shampoo',
    nameAr: 'شامبو للشعر الجاف',
    name: 'Shampoo for dry hair',
    q: {
      msa: 'منظف شعر',
      dialect: 'شامبو شعر ناشف',
      franco: 'shampoo sha3r',
      en: 'dry hair shampoo',
    },
    siblings: [
      ['شامبو ضد القشرة', 'Anti-dandruff shampoo'],
      ['شامبو أطفال', 'Baby shampoo'],
    ],
  },
  {
    key: 'moisturizer',
    nameAr: 'كريم مرطب للوجه',
    name: 'Face moisturizer',
    q: { msa: 'مرطب بشرة', dialect: 'كريم للوش', franco: 'kreem lel wesh', en: 'moisturizer' },
    siblings: [
      ['كريم ترطيب ليلي', 'Night moisturising cream'],
      ['لوشن جسم مرطب', 'Moisturising body lotion'],
    ],
  },
  {
    key: 'koshari',
    nameAr: 'كشري مصري',
    name: 'Egyptian koshari',
    q: { msa: 'طبق كشري', dialect: 'كشري', franco: 'koshary', en: 'koshari' },
    siblings: [['علبة كشري عائلي', 'Family koshari box']],
  },
  {
    key: 'pasta',
    nameAr: 'مكرونة إسباجتي',
    name: 'Spaghetti pasta',
    q: { msa: 'معكرونة', dialect: 'مكرونه', franco: 'makarona', en: 'spaghetti' },
    siblings: [
      ['مكرونة قلم', 'Penne pasta'],
      ['مكرونة لسان عصفور', 'Orzo pasta'],
      ['مكرونة بشاميل جاهزة', 'Ready bechamel pasta'],
    ],
  },
  {
    key: 'rice',
    nameAr: 'أرز مصري',
    name: 'Egyptian rice',
    q: { msa: 'أرز', dialect: 'رز', franco: 'roz', en: 'rice' },
    siblings: [
      ['أرز بسمتي', 'Basmati rice'],
      ['رز مصري ٥ كيلو', 'Egyptian rice 5 kg'],
    ],
  },
  {
    key: 'foul',
    nameAr: 'فول مدمس',
    name: 'Fava beans',
    q: { msa: 'فول', dialect: 'فول مدمس', franco: 'fool', en: 'fava beans' },
    siblings: [['فول مدمس معلب', 'Canned fava beans']],
  },
  {
    key: 'taameya',
    nameAr: 'طعمية مجمدة',
    name: 'Frozen falafel',
    q: { msa: 'فلافل', dialect: 'طعميه', franco: 'ta3meya', en: 'falafel' },
    siblings: [['خلطة طعمية جاهزة', 'Ready falafel mix']],
  },
  {
    key: 'feteer',
    nameAr: 'فطير مشلتت',
    name: 'Feteer meshaltet',
    q: { msa: 'فطيرة', dialect: 'فطير', franco: 'feteer', en: 'layered pastry' },
    siblings: [['فطيرة جبنة', 'Cheese pie']],
  },
  {
    key: 'kunafa',
    nameAr: 'كنافة بالقشطة',
    name: 'Kunafa with cream',
    q: { msa: 'كنافة', dialect: 'كنافه بالقشطه', franco: 'konafa', en: 'kunafa' },
    siblings: [
      ['كنافة نابلسية', 'Nabulsi kunafa'],
      ['كنافة بالمانجو', 'Mango kunafa'],
    ],
  },
  {
    key: 'basbousa',
    nameAr: 'بسبوسة بالمكسرات',
    name: 'Basbousa with nuts',
    q: { msa: 'حلوى السميد', dialect: 'بسبوسه', franco: 'basbosa', en: 'semolina cake' },
    siblings: [['بسبوسة سادة', 'Plain basbousa']],
  },
  {
    key: 'dates',
    nameAr: 'تمر سيوي',
    name: 'Siwa dates',
    q: { msa: 'تمور', dialect: 'بلح', franco: 'bala7', en: 'dates' },
    siblings: [
      ['تمر مجدول', 'Medjool dates'],
      ['بلح زغلول', 'Zaghloul dates'],
    ],
  },
  {
    key: 'tea',
    nameAr: 'شاي أسود ناعم',
    name: 'Fine black tea',
    q: { msa: 'شاي', dialect: 'شاي كشري', franco: 'shay', en: 'black tea' },
    siblings: [
      ['شاي أخضر', 'Green tea'],
      ['شاي فتلة ١٠٠ كيس', 'Tea bags 100'],
    ],
  },
  {
    key: 'coffee',
    nameAr: 'بن محوج',
    name: 'Spiced ground coffee',
    q: { msa: 'قهوة مطحونة', dialect: 'بن محوج', franco: 'bon', en: 'ground coffee' },
    siblings: [
      ['قهوة تركي فاتح', 'Light Turkish coffee'],
      ['نسكافيه كلاسيك', 'Instant coffee classic'],
    ],
  },
  {
    key: 'honey',
    nameAr: 'عسل نحل طبيعي',
    name: 'Natural bee honey',
    q: { msa: 'عسل', dialect: 'عسل نحل', franco: '3asal', en: 'honey' },
    siblings: [
      ['عسل موالح', 'Citrus honey'],
      ['عسل سدر', 'Sidr honey'],
    ],
  },
  {
    key: 'phonecase',
    nameAr: 'جراب موبايل سيليكون',
    name: 'Silicone phone case',
    q: { msa: 'غطاء هاتف', dialect: 'جراب موبايل', franco: 'grab mobile', en: 'phone case' },
    siblings: [
      ['جراب آيفون شفاف', 'Clear iPhone case'],
      ['جراب سامسونج جلد', 'Leather Samsung case'],
      ['جراب محفظة', 'Wallet phone case'],
    ],
  },
  {
    key: 'charger',
    nameAr: 'شاحن سريع ٢٠ وات',
    name: '20W fast charger',
    q: { msa: 'شاحن هاتف', dialect: 'شاحن سريع 20', franco: 'sha7en', en: 'fast charger' },
    siblings: [
      ['شاحن سيارة', 'Car charger'],
      ['شاحن لاسلكي', 'Wireless charger'],
    ],
  },
  {
    key: 'earbuds',
    nameAr: 'سماعة بلوتوث',
    name: 'Bluetooth earbuds',
    q: { msa: 'سماعات لاسلكية', dialect: 'سماعه بلوتوث', franco: 'sama3a', en: 'earbuds' },
    siblings: [
      ['سماعة أذن لاسلكية رياضية', 'Wireless sport earphones'],
      ['سماعة رأس بلوتوث', 'Bluetooth headphones'],
    ],
  },
  {
    key: 'powerbank',
    nameAr: 'باور بانك ١٠٠٠٠',
    name: 'Power bank 10000',
    q: { msa: 'بطارية متنقلة', dialect: 'باور بانك', franco: 'power bank', en: 'portable battery' },
    siblings: [['باور بانك ٢٠٠٠٠ شحن سريع', 'Power bank 20000 fast charge']],
  },
  {
    key: 'watch',
    nameAr: 'ساعة يد رجالي',
    name: "Men's wristwatch",
    q: { msa: 'ساعة', dialect: 'ساعه ايد', franco: 'sa3a', en: 'watch' },
    siblings: [
      ['ساعة حريمي ذهبي', "Women's gold watch"],
      ['ساعة ذكية', 'Smartwatch'],
      ['ساعة أطفال رقمية', 'Kids digital watch'],
    ],
  },
  {
    key: 'ring',
    nameAr: 'خاتم فضة',
    name: 'Silver ring',
    q: { msa: 'خاتم فضي', dialect: 'دبله فضه', franco: '5atem', en: 'silver ring' },
    siblings: [
      ['دبلة فضة', 'Silver wedding band'],
      ['خاتم ذهب عيار ١٨', '18k gold ring'],
    ],
  },
  {
    key: 'necklace',
    nameAr: 'سلسلة ذهب عيار ٢١',
    name: '21k gold necklace',
    q: { msa: 'قلادة ذهب', dialect: 'سلسله دهب', franco: 'selsela dahab', en: 'gold necklace' },
    siblings: [
      ['سلسلة فضة بحرف', 'Silver initial necklace'],
      ['عقد لولي', 'Pearl necklace'],
    ],
  },
  {
    key: 'kettle',
    nameAr: 'غلاية كهربائية',
    name: 'Electric kettle',
    q: { msa: 'غلاية ماء', dialect: 'كاتل', franco: 'kettle', en: 'kettle' },
    siblings: [['كاتل ستانلس ١.٧ لتر', 'Stainless kettle 1.7 L']],
  },
  {
    key: 'blender',
    nameAr: 'خلاط كهربائي',
    name: 'Electric blender',
    q: { msa: 'خلاط', dialect: 'خلاط عصير', franco: '5alat', en: 'blender' },
    siblings: [['خلاط يدوي', 'Hand blender']],
  },
  {
    key: 'pot',
    nameAr: 'حلة جرانيت',
    name: 'Granite pot',
    q: { msa: 'قدر طبخ', dialect: 'حله', franco: '7alla', en: 'cooking pot' },
    siblings: [
      ['طقم حلل جرانيت ٧ قطع', 'Granite pot set 7 pieces'],
      ['حلة ضغط', 'Pressure cooker'],
    ],
  },
  {
    key: 'mug',
    nameAr: 'مج سيراميك',
    name: 'Ceramic mug',
    q: { msa: 'كوب سيراميك', dialect: 'مج', franco: 'mug', en: 'coffee mug' },
    siblings: [
      ['مج حراري', 'Thermal mug'],
      ['مج مطبوع بالاسم', 'Personalised name mug'],
    ],
  },
  {
    key: 'blanket',
    nameAr: 'بطانية شتوي',
    name: 'Winter blanket',
    q: { msa: 'غطاء سرير', dialect: 'بطانيه', franco: 'bataneya', en: 'blanket' },
    siblings: [
      ['بطانية أطفال', 'Kids blanket'],
      ['بطانية فرو مزدوجة', 'Double fur blanket'],
    ],
  },
  {
    key: 'bedsheet',
    nameAr: 'ملاية سرير قطن',
    name: 'Cotton bed sheet',
    q: { msa: 'شرشف سرير', dialect: 'ملايه', franco: 'malaya', en: 'bed sheet' },
    siblings: [
      ['طقم ملايات ٤ قطع', 'Bed sheet set 4 pieces'],
      ['ملاية سرير أطفال', 'Kids bed sheet'],
    ],
  },
  {
    key: 'curtain',
    nameAr: 'ستارة بلاك أوت',
    name: 'Blackout curtain',
    q: { msa: 'ستارة', dialect: 'ستاره', franco: 'setara', en: 'curtain' },
    siblings: [
      ['ستارة شيفون', 'Sheer chiffon curtain'],
      ['ستارة بانيو', 'Shower curtain'],
    ],
  },
  {
    key: 'stroller',
    nameAr: 'عربية أطفال',
    name: 'Baby stroller',
    q: { msa: 'عربة أطفال', dialect: 'عربيه بيبي', franco: '3arabeyet baby', en: 'stroller' },
    siblings: [
      ['عربية بيبي خفيفة للسفر', 'Lightweight travel stroller'],
      ['عربية توأم', 'Twin stroller'],
    ],
  },
  {
    key: 'diapers',
    nameAr: 'حفاضات مقاس ٤',
    name: 'Diapers size 4',
    q: { msa: 'حفاضات', dialect: 'بامبرز مقاس 4', franco: 'pampers', en: 'diapers' },
    siblings: [
      ['حفاضات مقاس ٢ حديثي الولادة', 'Newborn diapers size 2'],
      ['كولوت حفاضات', 'Diaper pants'],
    ],
  },
  {
    key: 'toycar',
    nameAr: 'عربية ريموت للأطفال',
    name: 'Remote control car',
    q: { msa: 'سيارة لعبة', dialect: 'عربيه ريموت', franco: '3arabeya remote', en: 'rc car' },
    siblings: [
      ['عربية سباق بالريموت', 'RC racing car'],
      ['عربية كهربائية للأطفال', 'Kids electric ride-on car'],
    ],
  },
  {
    key: 'notebook',
    nameAr: 'كشكول ١٠٠ ورقة',
    name: '100-page notebook',
    q: { msa: 'دفتر', dialect: 'كشكول', franco: 'koshkol', en: 'notebook' },
    siblings: [
      ['كشكول سلك ٢٠٠ ورقة', '200-page spiral notebook'],
      ['كراسة رسم', 'Sketchbook'],
    ],
  },
];

/** Products of other types that share a word or substring with a target (never relevant). */
export const EVAL_NEGATIVES: ReadonlyArray<{
  key: string;
  nameAr: string;
  name: string;
  /** The target type it can be confused with. */
  near: string;
}> = [
  { key: 'x-syrup', nameAr: 'شراب توت', name: 'Berry syrup', near: 'socks' },
  { key: 'x-car-freshener', nameAr: 'معطر سيارة', name: 'Car air freshener', near: 'perfume' },
  { key: 'x-hair-oil', nameAr: 'زيت شعر', name: 'Hair oil', near: 'shampoo' },
  { key: 'x-conditioner', nameAr: 'بلسم شعر', name: 'Hair conditioner', near: 'shampoo' },
  { key: 'x-hair-cream', nameAr: 'كريم شعر', name: 'Hair cream', near: 'moisturizer' },
  { key: 'x-whipped-cream', nameAr: 'كريمة شانتيه', name: 'Whipped cream', near: 'moisturizer' },
  { key: 'x-rice-pudding', nameAr: 'رز بلبن', name: 'Rice pudding', near: 'rice' },
  { key: 'x-peanuts', nameAr: 'فول سوداني', name: 'Peanuts', near: 'foul' },
  { key: 'x-tamarind', nameAr: 'تمر هندي', name: 'Tamarind drink', near: 'dates' },
  { key: 'x-tea-glass', nameAr: 'كوب شاي زجاج', name: 'Glass tea cup', near: 'tea' },
  { key: 'x-molasses', nameAr: 'عسل أسود', name: 'Molasses', near: 'honey' },
  { key: 'x-glasses-case', nameAr: 'جراب نظارة', name: 'Glasses case', near: 'phonecase' },
  { key: 'x-hearing-aid', nameAr: 'سماعة طبية للأذن', name: 'Hearing aid', near: 'earbuds' },
  { key: 'x-car-battery', nameAr: 'بطارية سيارة', name: 'Car battery', near: 'powerbank' },
  { key: 'x-wall-clock', nameAr: 'ساعة حائط خشب', name: 'Wooden wall clock', near: 'watch' },
  { key: 'x-keychain', nameAr: 'سلسلة مفاتيح', name: 'Keychain', near: 'necklace' },
  { key: 'x-mixer-tap', nameAr: 'خلاط مياه حوض', name: 'Basin mixer tap', near: 'blender' },
  { key: 'x-trolley', nameAr: 'عربية تسوق', name: 'Shopping trolley', near: 'stroller' },
  {
    key: 'x-laptop',
    nameAr: 'لابتوب نوت بوك ١٥ بوصة',
    name: 'Notebook laptop 15 inch',
    near: 'notebook',
  },
  { key: 'x-gas-stove', nameAr: 'بوتاجاز ٤ شعلة', name: 'Gas cooker 4 burners', near: 'boots' },
  { key: 'x-robot', nameAr: 'روبوت تعليمي للأطفال', name: 'Educational robot', near: 'boots' },
  { key: 'x-burner', nameAr: 'مبخرة كهربائية', name: 'Electric incense burner', near: 'bakhoor' },
  { key: 'x-prayer-rug', nameAr: 'سجادة صلاة', name: 'Prayer rug', near: 'isdal' },
  { key: 'x-cap', nameAr: 'كاب رجالي', name: "Men's cap", near: 'sneakers' },
  { key: 'x-dining-set', nameAr: 'طقم سفرة', name: 'Dining table set', near: 'underwear' },
  { key: 'x-denim-skirt', nameAr: 'جيبة جينز', name: 'Denim skirt', near: 'jeans' },
  { key: 'x-denim-shorts', nameAr: 'شورت جينز', name: 'Denim shorts', near: 'jeans' },
  { key: 'x-steam-iron', nameAr: 'مكواة بخار', name: 'Steam iron', near: 'kettle' },
];

export type EvalExtraClass = 'typo' | 'ortho' | 'mixed' | 'phrase';
export type EvalHardClass = `hard-${EvalForm}`;

/**
 * Supplementary queries (not in the bar). `src: 'vocab'` = verbatim from franco-vocab.json's
 * `queries` (real shopper phrasing collected online).
 * typo = a dropped / swapped / adjacent-key letter; ortho = hamza, taa marbuta, alef maqsura,
 * tashkeel, tatweel and Arabic-Indic vs Latin digits; mixed = Arabic + Latin in one query;
 * phrase = a multi-word Franco or dialect query with attributes.
 */
export const EVAL_EXTRA: ReadonlyArray<{
  key: string;
  cls: EvalExtraClass;
  q: string;
  src?: 'vocab';
}> = [
  // typo
  { key: 'sneakers', cls: 'typo', q: 'كوتسي' },
  { key: 'pajama', cls: 'typo', q: 'بجامة' },
  { key: 'notebook', cls: 'typo', q: 'كشكل' },
  { key: 'earbuds', cls: 'typo', q: 'سماعة بلوتث' },
  { key: 'charger', cls: 'typo', q: 'شاحم سريع' },
  { key: 'perfume', cls: 'typo', q: 'برفام' },
  { key: 'basbousa', cls: 'typo', q: 'بسبوصه' },
  { key: 'curtain', cls: 'typo', q: 'ستاة' },
  { key: 'abaya', cls: 'typo', q: 'عبايا سوداء' },
  { key: 'stroller', cls: 'typo', q: 'عربيه اطفل' },
  { key: 'sneakers', cls: 'typo', q: 'snekers' },
  { key: 'shampoo', cls: 'typo', q: 'shampo' },
  { key: 'perfume', cls: 'typo', q: 'parfume' },
  { key: 'kettle', cls: 'typo', q: 'kettel' },
  { key: 'necklace', cls: 'typo', q: 'necklase' },
  { key: 'diapers', cls: 'typo', q: 'diapres' },
  { key: 'stroller', cls: 'typo', q: 'stroler' },
  { key: 'lipstick', cls: 'typo', q: 'lipstik' },
  { key: 'galabeya', cls: 'typo', q: 'galabya' },
  { key: 'blanket', cls: 'typo', q: 'blankit' },
  // ortho
  { key: 'rice', cls: 'ortho', q: 'ارز' },
  { key: 'isdal', cls: 'ortho', q: 'إسدال صلاة' },
  { key: 'abaya', cls: 'ortho', q: 'عبـــاية' },
  { key: 'abaya', cls: 'ortho', q: 'عَبَايَة' },
  { key: 'diapers', cls: 'ortho', q: 'حفاضات مقاس 4' },
  { key: 'charger', cls: 'ortho', q: 'شاحن ٢٠ وات' },
  { key: 'powerbank', cls: 'ortho', q: 'باور بانك 10000' },
  { key: 'sneakers', cls: 'ortho', q: 'كوتشى' },
  { key: 'bedsheet', cls: 'ortho', q: 'ملاءة سرير' },
  { key: 'blanket', cls: 'ortho', q: 'بطانيه شتوى' },
  { key: 'pasta', cls: 'ortho', q: 'مكرونه اسباجتي' },
  { key: 'necklace', cls: 'ortho', q: 'سلسله ذهب عيار 21' },
  { key: 'notebook', cls: 'ortho', q: 'كشكول 100 ورقه' },
  { key: 'curtain', cls: 'ortho', q: 'ستارة بلاك اوت' },
  { key: 'tea', cls: 'ortho', q: 'شاى' },
  // mixed script
  { key: 'hijab', cls: 'mixed', q: 'طرحة شيفون beige', src: 'vocab' },
  { key: 'abaya', cls: 'mixed', q: '3abaya sooda size L', src: 'vocab' },
  { key: 'isdal', cls: 'mixed', q: 'esdal sala free size', src: 'vocab' },
  { key: 'handbag', cls: 'mixed', q: 'شنطة leather' },
  { key: 'phonecase', cls: 'mixed', q: 'جراب iphone' },
  { key: 'charger', cls: 'mixed', q: 'شاحن type c' },
  { key: 'earbuds', cls: 'mixed', q: 'سماعة bluetooth' },
  { key: 'watch', cls: 'mixed', q: 'ساعة smart' },
  { key: 'jeans', cls: 'mixed', q: 'بنطلون jeans' },
  { key: 'tshirt', cls: 'mixed', q: 'تيشيرت oversize' },
  { key: 'pajama', cls: 'mixed', q: 'بيجامة cotton' },
  { key: 'perfume', cls: 'mixed', q: 'برفان oud' },
  { key: 'diapers', cls: 'mixed', q: 'pampers مقاس 4' },
  { key: 'mug', cls: 'mixed', q: 'mug سيراميك' },
  { key: 'kettle', cls: 'mixed', q: 'kettle كهربا' },
  // real multi-word phrases
  { key: 'hijab', cls: 'phrase', q: 'tar7a chiffon lebny', src: 'vocab' },
  { key: 'isdal', cls: 'phrase', q: 'اسدال صلاه بناتي', src: 'vocab' },
  { key: 'sneakers', cls: 'phrase', q: 'kotshy abyad 38', src: 'vocab' },
  { key: 'sneakers', cls: 'phrase', q: 'كوتشي جلد اسود و ابيض', src: 'vocab' },
  { key: 'handbag', cls: 'phrase', q: 'shanta cross bamby', src: 'vocab' },
  { key: 'galabeya', cls: 'phrase', q: 'galabeya beity shetwy', src: 'vocab' },
  { key: 'galabeya', cls: 'phrase', q: 'جلابيه حريمي قطن', src: 'vocab' },
  { key: 'hijab', cls: 'phrase', q: 'khemar malaysy crepe', src: 'vocab' },
  { key: 'slippers', cls: 'phrase', q: 'shebsheb teby 7erimy', src: 'vocab' },
  { key: 'abaya', cls: 'phrase', q: 'عبايه سودة كاجول', src: 'vocab' },
  { key: 'abaya', cls: 'phrase', q: '3abaya 5aleegy original', src: 'vocab' },
  { key: 'boots', cls: 'phrase', q: 'half boot shamwah' },
  { key: 'backpack', cls: 'phrase', q: 'shantet dahr laptop' },
  { key: 'honey', cls: 'phrase', q: '3asal na7l tabi3y' },
  { key: 'pot', cls: 'phrase', q: 'ta2m 7alal granite' },
];

/**
 * Things this store does NOT sell: the right answer is an empty list. Measures false positives,
 * which a looser SEARCH_VECTOR_MAX_DISTANCE trades for recall. Several share a word or substring
 * with the catalogue on purpose (`عربية` in car tyres and car oil, `اطفال` in kids' books).
 */
export const EVAL_ABSENT: readonly string[] = [
  'ثلاجة',
  'tlaga',
  'تكييف',
  'iphone 15 pro max',
  'كاوتش عربية',
  'laptop gaming',
  'كتب اطفال',
  'دواء برد',
  'لحمة مفرومة',
  'غسالة اطباق',
  'شقة للايجار',
  'tv samsung 55',
  'zeit 3arabeya',
];

/**
 * Harder queries (review M2): the core set is easy-biased (38/50 en and 14/50 msa queries are
 * substrings of the product's own name, and siblings use the same dialect words as the dialect
 * queries). Here no query word of 3+ letters appears inside ANY product name of its type (unit
 * test), so keyword search can only hit through another type or a search word: paraphrases
 * ("حاجه اشيل فيها حاجتي", "timepiece"), descriptions and synonyms. 20 per form, reported as
 * `hard-<form>` with their own lift; not in the bar.
 */
export const EVAL_HARD: ReadonlyArray<{ key: string; form: EvalForm; q: string }> = [
  // msa
  { key: 'sneakers', form: 'msa', q: 'أحذية للجري والتمارين' },
  { key: 'handbag', form: 'msa', q: 'محفظة يد نسائية' },
  { key: 'abaya', form: 'msa', q: 'ثوب فضفاض أسود للنساء' },
  { key: 'tshirt', form: 'msa', q: 'قميص بأكمام قصيرة' },
  { key: 'jeans', form: 'msa', q: 'سروال من قماش الدنيم' },
  { key: 'pajama', form: 'msa', q: 'ملابس للنوم' },
  { key: 'socks', form: 'msa', q: 'جوارب للقدمين' },
  { key: 'perfume', form: 'msa', q: 'رائحة زكية للجسم' },
  { key: 'lipstick', form: 'msa', q: 'طلاء للشفاه' },
  { key: 'shampoo', form: 'msa', q: 'غسول للرأس' },
  { key: 'moisturizer', form: 'msa', q: 'مستحضر للبشرة الجافة' },
  { key: 'honey', form: 'msa', q: 'شهد من الخلية' },
  { key: 'coffee', form: 'msa', q: 'مشروب الصباح المحمص' },
  { key: 'phonecase', form: 'msa', q: 'حماية للهاتف المحمول' },
  { key: 'charger', form: 'msa', q: 'جهاز لشحن الهاتف' },
  { key: 'watch', form: 'msa', q: 'أداة لمعرفة الوقت على المعصم' },
  { key: 'kettle', form: 'msa', q: 'إبريق لتسخين الماء' },
  { key: 'blanket', form: 'msa', q: 'غطاء دافئ للشتاء' },
  { key: 'stroller', form: 'msa', q: 'عربة لنقل الرضيع' },
  { key: 'notebook', form: 'msa', q: 'دفتر ملاحظات للمدرسة' },
  // dialect
  { key: 'sneakers', form: 'dialect', q: 'جزمه رياضه' },
  { key: 'abaya', form: 'dialect', q: 'لبس واسع للمحجبات' },
  { key: 'handbag', form: 'dialect', q: 'حاجه اشيل فيها حاجتي' },
  { key: 'tshirt', form: 'dialect', q: 'فانله نص كم' },
  { key: 'pot', form: 'dialect', q: 'طاسه كبيره للطبيخ' },
  { key: 'pajama', form: 'dialect', q: 'لبس بيت للنوم' },
  { key: 'slippers', form: 'dialect', q: 'حاجه البسها في رجلي في البيت' },
  { key: 'hijab', form: 'dialect', q: 'حاجه اغطي بيها شعري' },
  { key: 'perfume', form: 'dialect', q: 'ريحه حلوه' },
  { key: 'shampoo', form: 'dialect', q: 'حاجه اغسل بيها شعري' },
  { key: 'koshari', form: 'dialect', q: 'اكله مصريه بالعدس' },
  { key: 'tea', form: 'dialect', q: 'مشروب العصاريه' },
  { key: 'honey', form: 'dialect', q: 'شهد' },
  { key: 'earbuds', form: 'dialect', q: 'سماعات ودان' },
  { key: 'charger', form: 'dialect', q: 'حاجه اشحن بيها التليفون' },
  { key: 'watch', form: 'dialect', q: 'حاجه البسها في ايدي اعرف بيها الوقت' },
  { key: 'blender', form: 'dialect', q: 'ماكينه عصير' },
  { key: 'kettle', form: 'dialect', q: 'حاجه اغلي فيها المايه' },
  { key: 'toycar', form: 'dialect', q: 'لعبه للولاد بتمشي' },
  { key: 'notebook', form: 'dialect', q: 'دفتر للمدرسه' },
  // franco
  { key: 'sneakers', form: 'franco', q: 'gazma riyada' },
  { key: 'abaya', form: 'franco', q: 'lebs wase3 lel mo7agabat' },
  { key: 'handbag', form: 'franco', q: '7aga ashil feha 7agty' },
  { key: 'tshirt', form: 'franco', q: 'fanela nos kom' },
  { key: 'pajama', form: 'franco', q: 'lebs beit lel nom' },
  { key: 'slippers', form: 'franco', q: 'zanoba' },
  { key: 'hijab', form: 'franco', q: '7aga aghaty beha sha3ry' },
  { key: 'perfume', form: 'franco', q: 'ri7a 7elwa' },
  { key: 'shampoo', form: 'franco', q: '7aga aghsel beha sha3ry' },
  { key: 'koshari', form: 'franco', q: 'akla masreya bel 3ads' },
  { key: 'tea', form: 'franco', q: 'mashroob el 3asreya' },
  { key: 'honey', form: 'franco', q: 'shahd' },
  { key: 'earbuds', form: 'franco', q: 'sama3at wedan' },
  { key: 'charger', form: 'franco', q: '7aga ash7en beha el telephone' },
  { key: 'watch', form: 'franco', q: '7aga albesha f eidy a3raf el wa2t' },
  { key: 'blender', form: 'franco', q: 'makanet 3aseer' },
  { key: 'kettle', form: 'franco', q: '7aga aghly feha el maya' },
  { key: 'toycar', form: 'franco', q: 'le3ba lel welad btemshy' },
  { key: 'notebook', form: 'franco', q: 'daftar lel madrasa' },
  { key: 'pot', form: 'franco', q: 'tasa kbira lel tabee5' },
  // en
  { key: 'sneakers', form: 'en', q: 'gym footwear' },
  { key: 'abaya', form: 'en', q: 'loose modest robe' },
  { key: 'handbag', form: 'en', q: 'ladies purse' },
  { key: 'tshirt', form: 'en', q: 'casual top' },
  { key: 'jeans', form: 'en', q: 'denim trousers' },
  { key: 'pajama', form: 'en', q: 'sleepwear' },
  { key: 'socks', form: 'en', q: 'ankle hosiery' },
  { key: 'perfume', form: 'en', q: 'fragrance' },
  { key: 'lipstick', form: 'en', q: 'mouth makeup' },
  { key: 'kohl', form: 'en', q: 'kajal' },
  { key: 'shampoo', form: 'en', q: 'scalp cleanser' },
  { key: 'moisturizer', form: 'en', q: 'skin hydration' },
  { key: 'honey', form: 'en', q: 'golden syrup from hives' },
  { key: 'coffee', form: 'en', q: 'morning brew' },
  { key: 'phonecase', form: 'en', q: 'mobile cover' },
  { key: 'earbuds', form: 'en', q: 'in-ear audio' },
  { key: 'watch', form: 'en', q: 'timepiece' },
  { key: 'kettle', form: 'en', q: 'water boiler' },
  { key: 'stroller', form: 'en', q: 'pram' },
  { key: 'notebook', form: 'en', q: 'jotter' },
];

export interface EvalRow {
  /** Unique per product (the slug stem). */
  id: string;
  /** Relevance type: a target key, or the negative's own key (relevant to nothing). */
  type: string;
  nameAr: string;
  name: string;
}

/** Every product of the synthetic store, flattened: targets, their siblings, then negatives. */
export function catalogueRows(): EvalRow[] {
  const rows: EvalRow[] = [];
  for (const p of EVAL_PRODUCTS) {
    rows.push({ id: p.key, type: p.key, nameAr: p.nameAr, name: p.name });
    (p.siblings ?? []).forEach(([nameAr, name], i) =>
      rows.push({ id: `${p.key}-${i + 1}`, type: p.key, nameAr, name })
    );
  }
  for (const n of EVAL_NEGATIVES)
    rows.push({ id: n.key, type: n.key, nameAr: n.nameAr, name: n.name });
  return rows;
}

export interface EvalQuery {
  /** `msa` / `dialect` / `franco` / `en` (core, in the bar) or an EVAL_EXTRA class. */
  cls: EvalForm | EvalExtraClass | EvalHardClass;
  core: boolean;
  /** Target type key. */
  key: string;
  q: string;
}

/** The 200 core queries, then the supplementary ones, then the hard set. */
export function evalQueries(): EvalQuery[] {
  const out: EvalQuery[] = [];
  for (const p of EVAL_PRODUCTS)
    for (const f of EVAL_FORMS) out.push({ cls: f, core: true, key: p.key, q: p.q[f] });
  for (const e of EVAL_EXTRA) out.push({ cls: e.cls, core: false, key: e.key, q: e.q });
  for (const h of EVAL_HARD) out.push({ cls: `hard-${h.form}`, core: false, key: h.key, q: h.q });
  return out;
}

// ---- Arabic stemming eval (Ruling SEARCH-STEM-1) --------------------------------------------------------------------
// A small commerce set on top of the base catalogue (distractors): the keyword arm must find an item by ANY inflection of
// its word. Not part of the SEARCH-10 bar and not in `catalogueRows()` (those stay byte-identical for the PG harness).

export const EVAL_STEM_ROWS: readonly EvalRow[] = [
  { id: 'stem-bag-1', type: 'stem-bag', nameAr: 'شنطة جلد حريمي', name: '' },
  { id: 'stem-bag-2', type: 'stem-bag', nameAr: 'شنط سفر كبيرة', name: '' },
  { id: 'stem-bag-3', type: 'stem-bag', nameAr: 'الشنطة المدرسية', name: '' },
  { id: 'stem-watch-1', type: 'stem-watch', nameAr: 'ساعة يد رجالي', name: '' },
  { id: 'stem-watch-2', type: 'stem-watch', nameAr: 'ساعات حائط ديكور', name: '' },
  { id: 'stem-book-1', type: 'stem-book', nameAr: 'كتب أطفال ملونة', name: '' },
  { id: 'stem-book-2', type: 'stem-book', nameAr: 'الكتاب المدرسي', name: '' },
  { id: 'stem-book-3', type: 'stem-book', nameAr: 'مكتبة خشب للكتب', name: '' },
  { id: 'stem-shoe-1', type: 'stem-shoe', nameAr: 'جزمة جلد رجالي', name: '' },
  { id: 'stem-shoe-2', type: 'stem-shoe', nameAr: 'جزم شتوي', name: '' },
  { id: 'stem-shoe-3', type: 'stem-shoe', nameAr: 'الجزمة السوداء', name: '' },
  { id: 'stem-cup-1', type: 'stem-cup', nameAr: 'كوبايات زجاج', name: '' },
  { id: 'stem-cup-2', type: 'stem-cup', nameAr: 'كوباية قهوة', name: '' },
];

export interface EvalStemCase {
  q: string;
  /** Every one of these ids must be in the results. */
  relevant: readonly string[];
  /** None of these may be (precision guard: a stem must not merge unrelated words). */
  absent?: readonly string[];
}
const BAGS = ['stem-bag-1', 'stem-bag-2', 'stem-bag-3'];
const WATCHES = ['stem-watch-1', 'stem-watch-2'];
const BOOKS = ['stem-book-1', 'stem-book-2', 'stem-book-3'];
const SHOES = ['stem-shoe-1', 'stem-shoe-2', 'stem-shoe-3'];
const CUPS = ['stem-cup-1', 'stem-cup-2'];
const only = (keep: readonly string[]) =>
  EVAL_STEM_ROWS.map(r => r.id).filter(id => !keep.includes(id));

export const EVAL_STEM: readonly EvalStemCase[] = [
  ...['كتب', 'الكتب', 'كتابين', 'مكتبة', 'الكتاب'].map(q => ({
    q,
    relevant: BOOKS,
    absent: only(BOOKS),
  })),
  ...['شنط', 'شنطة', 'الشنط', 'شنطتين', 'بالشنطة'].map(q => ({
    q,
    relevant: BAGS,
    absent: only(BAGS),
  })),
  ...['ساعة', 'ساعات', 'الساعات', 'ساعتين', 'للساعه'].map(q => ({
    q,
    relevant: WATCHES,
    absent: only(WATCHES),
  })),
  ...['جزمة', 'جزم', 'الجزم', 'جزمتين'].map(q => ({
    q,
    relevant: SHOES,
    absent: only(SHOES),
  })),
  ...['كوباية', 'كوبايات', 'الكوبايات'].map(q => ({ q, relevant: CUPS, absent: only(CUPS) })),
];
