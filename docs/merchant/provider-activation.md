# Connecting a payment or shipping service / ربط خدمة دفع أو شحن

## English

Every payment and shipping company on Ebda is a real integration, and you connect it with your own account. There is nothing to request and nobody to wait for.

1. Open Payment settings or Shipping settings and pick the company.
2. Enter your own account keys (Sandbox first if the company has a test mode) and press **Save**.
3. Ebda checks the keys immediately with one read-only call (never a charge, never a shipment) and tells you the result in Arabic and English: **Connected**, **Credentials wrong** (check and save again), or **Provider not reachable** (your keys are saved; press **Test connection** again in a few minutes). A company with no safe test call is marked **unverified** with a warning, and still connects.
4. After a passing check, turn the service on. Changing a key turns it off again until it is re-checked.

Some companies are marked **New connection**: nobody has run them against a live account yet. The Ebda Store team watches the first real payment or parcel on such a service, so if anything is off we see it immediately and fix it. After a few successful real operations Ebda marks the service verified automatically.

## بالعربي

كل شركات الدفع والشحن على إبدأ مربوطة فعلًا، وإنت بتربطها بحسابك إنت. مفيش حاجة تطلبها ومفيش حد تستناه.

1. افتح إعدادات الدفع أو إعدادات الشحن واختار الشركة.
2. اكتب مفاتيح حسابك (التجربة الأول لو الشركة عندها وضع تجربة) واضغط **حفظ**.
3. إبدأ بتتأكد من المفاتيح فورًا بطلب قراءة واحد بس (مفيش خصم ومفيش شحنة) وبتعرفك النتيجة بالعربي والإنجليزي: **اتوصلنا** أو **البيانات غلط** (راجعها واحفظ تاني) أو **الشركة مش بترد** (المفاتيح اتحفظت، دوس **اختبار الاتصال** تاني بعد شوية). الشركة اللي مفيهاش اختبار آمن بتتعلّم **غير متأكد منها** مع تحذير، وبتتربط برضه.
4. بعد فحص ناجح شغّل الخدمة. لو غيّرت أي مفتاح بتقفل لحد ما يتفحص تاني.

بعض الشركات عليها **ربط جديد**: لسه محدش جرّبها على حساب فعلي. فريق إبدأ بيتابع أول عملية دفع أو شحنة حقيقية عليها، فلو فيه أي مشكلة بنشوفها في نفس اللحظة ونصلّحها. وبعد كام عملية حقيقية ناجحة إبدأ بتوثّق الخدمة تلقائيًا.
