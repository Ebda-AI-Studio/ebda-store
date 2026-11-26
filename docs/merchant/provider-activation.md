# Connecting a payment or shipping service / ربط خدمة دفع أو شحن

## English

Every payment and shipping company on Ebda Store is a real integration, and you connect it with your own account. There is nothing to request and nobody to wait for: you turn it on yourself.

1. Open Payment settings or Shipping settings and pick the company.
2. Enter your own account keys (Sandbox first if the company has a test mode) and press **Save**.
3. Ebda Store checks the keys immediately with one read-only call (never a charge, never a shipment) and tells you the result in Arabic and English: **Connected**, **Credentials wrong** (check and save again), or **Provider not reachable** (your keys are saved; press **Test connection** again in a few minutes). A company with no safe test call is marked **unverified** with a warning, and still connects.
4. Press the **on** switch. Ebda Store tests the saved keys again on the server (nothing you type on the page can make the test pass). If it passes, you are asked to confirm, because from that moment customers can pay or ship with this company at checkout: press **Test and turn on**. If it fails you get one plain sentence about what to check, and nothing is turned on.
5. Changing a key turns the service off again until it is re-checked.

Every activation is recorded. Some companies are marked **New connection**: nobody has run them against a live account yet. The Ebda Store team is told when such a company is turned on for the first time and watches the first real payment or parcel, so if anything is off we see it immediately and fix it. Once several different stores have completed real live orders on it, the Ebda Store team confirms it as verified. Platform staff can still turn a company off for one store (with a note you see by email) if something is wrong.

## بالعربي

كل شركات الدفع والشحن على Ebda Store مربوطة فعلًا، وإنت بتربطها بحسابك إنت. مفيش حاجة تطلبها ومفيش حد تستناه: إنت اللي بتشغّلها بنفسك.

1. افتح إعدادات الدفع أو إعدادات الشحن واختار الشركة.
2. اكتب مفاتيح حسابك (التجربة الأول لو الشركة عندها وضع تجربة) واضغط **حفظ**.
3. Ebda Store بيتأكد من المفاتيح فورًا بطلب قراءة واحد بس (مفيش خصم ومفيش شحنة) وبيعرّفك النتيجة بالعربي والإنجليزي: **اتوصلنا** أو **البيانات غلط** (راجعها واحفظ تاني) أو **الشركة مش بترد** (المفاتيح اتحفظت، دوس **اختبار الاتصال** تاني بعد شوية). الشركة اللي مفيهاش اختبار آمن بتتعلّم **غير متأكد منها** مع تحذير، وبتتربط برضه.
4. دوس على مفتاح **التشغيل**. Ebda Store بيختبر المفاتيح المحفوظة تاني على السيرفر (مفيش حاجة تكتبها في الصفحة تقدر تخلّي الاختبار ينجح). لو نجح، هيطلب منك تأكيد، لأن من اللحظة دي عملاءك يقدروا يدفعوا أو يشحنوا بالشركة دي في الدفع: دوس **اختبر وشغّل**. ولو فشل هتلاقي جملة واحدة واضحة بتقولك تراجع إيه، ومفيش حاجة بتتشغّل.
5. لو غيّرت أي مفتاح الخدمة بتتقفل لحد ما تتفحص تاني.

كل تشغيل بيتسجّل. بعض الشركات عليها **ربط جديد**: لسه محدش جرّبها على حساب فعلي. فريق Ebda Store بيتبلّغ لما شركة زي دي تتشغّل لأول مرة وبيتابع أول عملية دفع أو شحنة حقيقية عليها، فلو فيه أي مشكلة بنشوفها في نفس اللحظة ونصلّحها. ولما كذا متجر مختلف يخلّصوا طلبات حقيقية فعلية عليها، الفريق بيأكّد توثيقها. وفريق المنصة يقدر يقفل شركة على متجر واحد (مع ملاحظة بتوصلك بالإيميل) لو فيه مشكلة.
