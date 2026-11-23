/**
 * accounts.ebda.app/signup?product=chat: the Ebda Chat sign-up page (Ruling CHAT-SA-1).
 *
 * A thin page over the SAME endpoints the Store sign-up uses: `POST /signup` (creates an UNVERIFIED identity with no
 * store and mails a code), then `POST /otp/verify`. No auth logic lives here; limiters, CSRF and the verification rules
 * are the service's own. Same shell, CSS and CSP as the sign-in page (no inline script, no inline style). After the code
 * is verified the person goes to `/login?product=chat&return=<chat>` and lands in Ebda Chat, never in the Store.
 */
import { BRAND, brandMarkSvg } from '../../../packages/shared/src/brand/index';
import { safeSignInReturn } from '../../admin/src/lib/sign-in-return';
import type { SignInLang } from './sign-in-page';

export {
  SIGN_IN_CSS as SIGNUP_CSS,
  SIGN_IN_PAGE_HEADERS as SIGNUP_PAGE_HEADERS,
} from './sign-in-page';

/** Ebda Chat's own origin: the only default destination of this page. */
export const CHAT_URL = `https://${BRAND.domains.whatsappApp}/`;

/** The validated Chat destination: an allowlisted absolute https URL, else Ebda Chat itself (never the Store). */
export function signupReturn(raw: string | null | undefined): string {
  return safeSignInReturn(raw) ?? CHAT_URL;
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
  );

const COPY = {
  ar: {
    title: 'اعمل حساب في ابدأ شات',
    subtitle: 'حساب واحد بيدخلك على ابدأ شات. هنبعتلك كود على بريدك عشان نتأكد إنه بريدك.',
    firstName: 'الاسم الأول',
    lastName: 'الاسم الأخير',
    email: 'البريد الإلكتروني',
    password: 'كلمة السر',
    passwordHint: 'ثمانية حروف على الأقل، فيها حرف كبير وحرف صغير ورقم ورمز.',
    submit: 'ابعتلي الكود',
    codeTitle: 'اكتب الكود اللي وصلك',
    codeSubtitle: 'بعتنا كود من 6 أرقام على بريدك. اكتبه هنا عشان نفعّل حسابك.',
    code: 'الكود',
    verify: 'فعّل حسابي',
    resend: 'ابعتلي كود جديد',
    resent: 'لو البريد ده مسجّل عندنا، هيوصلك كود جديد.',
    back: 'غيّر البريد أو البيانات',
    haveAccount: 'عندك حساب؟ سجّل دخولك.',
    noscript: 'الصفحة دي محتاجة JavaScript عشان نعمل حسابك. شغّله وجرّب تاني.',
    switchTo: 'English',
    skip: 'تخطَّ إلى المحتوى',
  },
  en: {
    title: 'Create your Ebda Chat account',
    subtitle:
      'One account gets you into Ebda Chat. We will email you a code to confirm the address is yours.',
    firstName: 'First name',
    lastName: 'Last name',
    email: 'Email address',
    password: 'Password',
    passwordHint:
      'At least 8 characters, with an uppercase letter, a lowercase letter, a number and a symbol.',
    submit: 'Send me the code',
    codeTitle: 'Enter the code we sent you',
    codeSubtitle: 'We emailed a 6-digit code. Enter it here to activate your account.',
    code: 'Code',
    verify: 'Activate my account',
    resend: 'Send me a new code',
    resent: 'If that address is registered with us, a new code is on its way.',
    back: 'Change my email or details',
    haveAccount: 'Already have an account? Sign in.',
    noscript: 'This page needs JavaScript to create your account. Turn it on and try again.',
    switchTo: 'العربية',
    skip: 'Skip to content',
  },
} as const;

/** Fixed sentences the script shows: the service's own text never reaches the page. */
const MESSAGES = {
  ar: {
    invalidInput:
      'راجع البيانات: كلمة السر لازم تكون ثمانية حروف على الأقل وفيها حرف كبير وصغير ورقم ورمز.',
    tooManyAttempts: 'محاولات كتير. استنى كام دقيقة وجرّب تاني.',
    invalidCode: 'الكود غلط أو خلص وقته. جرّب تاني.',
    serverError: 'حصلت مشكلة من عندنا. جرّب تاني بعد شوية.',
    sending: 'بنبعت الكود…',
    verifying: 'بنتحقق من الكود…',
    resent: COPY.ar.resent,
  },
  en: {
    invalidInput:
      'Check your details: the password needs 8+ characters with an uppercase letter, a lowercase letter, a number and a symbol.',
    tooManyAttempts: 'Too many attempts. Please wait a few minutes and try again.',
    invalidCode: 'That code is wrong or has expired. Try again.',
    serverError: 'Something went wrong on our side. Try again in a moment.',
    sending: 'Sending the code…',
    verifying: 'Checking the code…',
    resent: COPY.en.resent,
  },
} as const;

export interface SignupPageInput {
  lang: SignInLang;
  /** Already validated by `signupReturn`. */
  returnTo: string;
}

/** The query that carries the person's context to another page. */
function carry(returnTo: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  q.set('product', 'chat');
  if (returnTo !== CHAT_URL) q.set('return', returnTo);
  return `?${q.toString()}`;
}

export function renderSignupPage({ lang, returnTo }: SignupPageInput): string {
  const c = COPY[lang];
  const other: SignInLang = lang === 'ar' ? 'en' : 'ar';
  const company = lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn;
  const msgs = JSON.stringify(MESSAGES[lang]).replace(/</g, '\\u003c');
  // The Chat sign-in page this hands over to, carrying the validated Chat destination.
  const loginUrl = `/login?${new URLSearchParams({ product: 'chat', return: returnTo, lang })}`;
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)} | ${esc(company)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="${BRAND.colors.night}">
<link rel="icon" href="https://${BRAND.domains.marketing}/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/sign-in.css">
<script src="/signup.js" defer></script>
</head>
<body>
<a class="skip" href="#main">${esc(c.skip)}</a>
<header><a class="brand" href="https://${BRAND.domains.marketing}/">${brandMarkSvg({ size: 28 })}<span>${esc(company)}</span></a></header>
<main id="main" data-return="${esc(returnTo)}" data-login="${esc(loginUrl)}" data-lang="${lang}">
<section id="step-details">
<h1>${esc(c.title)}</h1>
<p class="hint">${esc(c.subtitle)}</p>
<noscript><p class="alert">${esc(c.noscript)}</p></noscript>
<p class="alert" id="error" role="alert" tabindex="-1" hidden></p>
<form id="signup-form" method="post" novalidate>
<label for="first-name">${esc(c.firstName)}</label>
<input id="first-name" name="firstName" type="text" autocomplete="given-name" required maxlength="100">
<label for="last-name">${esc(c.lastName)}</label>
<input id="last-name" name="lastName" type="text" autocomplete="family-name" maxlength="100">
<label for="email">${esc(c.email)}</label>
<input id="email" name="email" type="email" autocomplete="username" inputmode="email" dir="ltr" required maxlength="254">
<label for="password">${esc(c.password)}</label>
<input id="password" name="password" type="password" autocomplete="new-password" dir="ltr" required maxlength="200" aria-describedby="password-hint">
<p class="hint" id="password-hint">${esc(c.passwordHint)}</p>
<div class="hp" aria-hidden="true"><label for="website">Website</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<button type="submit" data-label="${esc(c.submit)}">${esc(c.submit)}</button>
</form>
<p class="aside"><a href="${esc(loginUrl)}">${esc(c.haveAccount)}</a></p>
</section>
<section id="step-code" hidden>
<h1>${esc(c.codeTitle)}</h1>
<p class="hint">${esc(c.codeSubtitle)}</p>
<p class="alert" id="code-error" role="alert" tabindex="-1" hidden></p>
<p class="hint" id="code-note" role="status" hidden></p>
<form id="code-form" method="post" novalidate>
<label for="code">${esc(c.code)}</label>
<input id="code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" dir="ltr" required maxlength="6">
<button type="submit" data-label="${esc(c.verify)}">${esc(c.verify)}</button>
</form>
<p class="aside"><button type="button" class="link" id="resend">${esc(c.resend)}</button></p>
<p class="aside"><button type="button" class="link" id="back">${esc(c.back)}</button></p>
</section>
</main>
<footer>
<span>© ${new Date().getUTCFullYear()} ${esc(company)}</span>
<a href="${esc(`/signup${carry(returnTo, { lang: other })}`)}" hreflang="${other}" lang="${other}">${esc(c.switchTo)}</a>
</footer>
<script type="application/json" id="messages">${msgs}</script>
</body>
</html>`;
}

/** Plain script (no build step), served as /signup.js. */
export const SIGNUP_JS = `(function () {
  'use strict';
  var main = document.getElementById('main');
  if (!main) return;
  var msgs = JSON.parse(document.getElementById('messages').textContent || '{}');
  var loginUrl = main.getAttribute('data-login') || '/login?product=chat';
  var lang = main.getAttribute('data-lang') === 'en' ? 'en' : 'ar';
  var $ = function (id) { return document.getElementById(id); };
  var email = '';
  var password = '';

  function keyFor(status, code) {
    if (status === 429 || code === 'TOO_MANY_ATTEMPTS') return 'tooManyAttempts';
    if (code === 'INVALID_CODE') return 'invalidCode';
    if (status === 400) return 'invalidInput';
    return 'serverError';
  }
  function say(box, key) {
    box.textContent = msgs[key] || msgs.serverError;
    box.hidden = false;
    box.focus();
  }
  function busy(form, on, label) {
    var b = form.querySelector('button[type=submit]');
    b.disabled = on;
    b.textContent = on ? msgs[label] : b.getAttribute('data-label');
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) { return { r: r, j: j }; }, function () { return { r: r, j: null }; });
    });
  }
  function refusal(res) {
    return keyFor(res.r.status, res.j && res.j.error ? res.j.error.code : undefined);
  }
  function showStep(code) {
    $('step-details').hidden = code;
    $('step-code').hidden = !code;
    $(code ? 'code' : 'first-name').focus();
  }

  $('signup-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var err = $('error');
    var first = $('first-name').value.trim();
    email = $('email').value.trim();
    password = $('password').value;
    if (!first || !email || !password) return;
    err.hidden = true;
    busy(form, true, 'sending');
    post('/signup', {
      email: email,
      password: password,
      firstName: first,
      lastName: $('last-name').value.trim(),
      language: lang,
      website: $('website').value
    }).then(function (res) {
      if (!res.r.ok) return say(err, refusal(res));
      $('code-error').hidden = true;
      $('code-note').hidden = true;
      showStep(true);
    }, function () { say(err, 'serverError'); }).then(function () { busy(form, false); });
  });

  $('code-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var err = $('code-error');
    var code = $('code').value.trim();
    if (!/^\\d{6}$/.test(code)) return say(err, 'invalidCode');
    err.hidden = true;
    busy(form, true, 'verifying');
    post('/otp/verify', { email: email, code: code, password: password }).then(function (res) {
      if (!res.r.ok || !res.j || !res.j.success) return say(err, refusal(res));
      // Verified: sign in on the Chat-branded sign-in page, which returns the person to Ebda Chat.
      password = '';
      window.location.assign(loginUrl);
    }, function () { say(err, 'serverError'); }).then(function () { busy(form, false); });
  });

  $('resend').addEventListener('click', function () {
    var err = $('code-error');
    err.hidden = true;
    post('/otp/resend', { email: email }).then(function (res) {
      if (!res.r.ok) return say(err, refusal(res));
      var n = $('code-note');
      n.textContent = msgs.resent;
      n.hidden = false;
    }, function () { say(err, 'serverError'); });
  });
  $('back').addEventListener('click', function () {
    $('error').hidden = true;
    showStep(false);
  });
})();
`;
