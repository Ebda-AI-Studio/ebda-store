/**
 * accounts.ebda.app/login: the Ebda AI Studio sign-in page (Ruling ACCOUNTS-PAGE-1).
 *
 * A thin page over the SAME endpoints the Store sign-in (store.ebda.app/login) calls: `POST /login` with
 * `{ email, password, aud: 'store' }`, then `POST /login/mfa` when a code is required. No auth logic lives here; the
 * limiters, CSRF and cookie are the service's own. The page's script and CSS are served by this Worker so the CSP
 * allows no inline script and no inline style.
 *
 * `return` (Ebda Chat's existing parameter) or `return_to` is validated HERE, server-side, by the Store's own
 * allowlist function (Ruling SIGNIN-RETURN-1, imported, not copied), and only the validated URL reaches the page.
 */
import { BRAND, brandMarkSvg } from '../../../packages/shared/src/brand/index';
import { safeSignInReturn } from '../../admin/src/lib/sign-in-return';

export type SignInLang = 'ar' | 'en';
/** Which product the person is opening. `studio` = none or unknown: the generic Ebda AI Studio sign-in. */
export type SignInProduct = 'store' | 'chat' | 'studio';

/**
 * `?product=` is an allowlist of product ids; the raw value is never rendered. Ebda Chat may name itself `chat` or by
 * its audience id `whatsapp`; the Store as `store`. Anything else is the generic studio sign-in.
 */
export function signInProduct(raw: string | null | undefined): SignInProduct {
  if (raw === 'chat' || raw === 'whatsapp') return 'chat';
  if (raw === 'store') return 'store';
  return 'studio';
}

/** Where a person goes after signing in when no allowlisted `return` came with them. */
export const DEFAULT_RETURN = `https://${BRAND.domains.storeApp}/`;
const STORE = `https://${BRAND.domains.storeApp}`;

/** The validated destination: an allowlisted absolute https URL, else the Store. */
export function signInReturn(raw: string | null | undefined): string {
  return safeSignInReturn(raw) ?? DEFAULT_RETURN;
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
  );

const COPY = {
  ar: {
    title: {
      studio: 'تسجيل الدخول',
      store: 'تسجيل الدخول لابدأ ستور',
      chat: 'تسجيل الدخول لابدأ شات',
    },
    subtitle: {
      studio: 'حساب واحد بيدخلك على كل منتجات ابدأ ستوديو للذكاء الاصطناعي.',
      store: 'سجّل دخولك وكمّل شغلك على متجرك.',
      chat: 'سجّل دخولك وكمّل على ابدأ شات.',
    },
    email: 'البريد الإلكتروني',
    password: 'كلمة السر',
    signIn: 'سجّل الدخول',
    forgot: 'نسيت كلمة السر؟',
    passkey: 'معاك مفتاح مرور؟ ادخل بيه من صفحة ابدأ ستور.',
    noAccount: 'جديد على ابدأ ستور؟ اعمل حساب.',
    chatNoAccount: 'معاك دعوة؟ اعمل حسابك.',
    mfaTitle: 'اكتب كود التحقق',
    mfaSubtitle: 'اكتب الكود اللي فيه 6 أرقام من تطبيق المصادقة.',
    mfaBackupSubtitle: 'اكتب واحد من أكواد الاحتياط اللي حفظتها.',
    mfaCode: 'كود التحقق',
    mfaVerify: 'تحقّق',
    mfaBackupLink: 'استخدم كود احتياطي بدل كده',
    mfaTotpLink: 'استخدم تطبيق المصادقة بدل كده',
    back: 'ارجع لتسجيل الدخول',
    noscript: 'الصفحة دي محتاجة JavaScript عشان تسجّل دخولك. شغّله وجرّب تاني.',
    switchTo: 'English',
    skip: 'تخطَّ إلى المحتوى',
  },
  en: {
    title: {
      studio: 'Sign in',
      store: 'Sign in to Ebda Store',
      chat: 'Sign in to Ebda Chat',
    },
    subtitle: {
      studio: 'One account for every Ebda AI Studio product.',
      store: 'Sign in and carry on with your store.',
      chat: 'Sign in and carry on with Ebda Chat.',
    },
    email: 'Email address',
    password: 'Password',
    signIn: 'Sign in',
    forgot: 'Forgot your password?',
    passkey: 'Have a passkey? Use it on the Ebda Store sign-in page.',
    noAccount: 'New to Ebda Store? Create an account.',
    chatNoAccount: 'Have an invitation? Create your account.',
    mfaTitle: 'Enter your verification code',
    mfaSubtitle: 'Enter the 6-digit code from your authenticator app.',
    mfaBackupSubtitle: 'Enter one of the backup codes you saved.',
    mfaCode: 'Verification code',
    mfaVerify: 'Verify',
    mfaBackupLink: 'Use a backup code instead',
    mfaTotpLink: 'Use your authenticator app instead',
    back: 'Back to sign in',
    noscript: 'This page needs JavaScript to sign you in. Turn it on and try again.',
    switchTo: 'العربية',
    skip: 'Skip to content',
  },
} as const;

/**
 * The fixed sentences the script shows. Keys and wording follow the Store sign-in (`signInMessageKey` in
 * apps/admin/src/lib/sign-in-error.ts and the `auth.login` messages): the service's own text never reaches the page.
 */
const MESSAGES = {
  ar: {
    invalidCredentials: 'البريد الإلكتروني أو كلمة السر مش مظبوطين. راجعهم وجرّب تاني.',
    emailNotVerified: 'لازم تأكد بريدك الإلكتروني الأول. بعتنالك كود.',
    tooManyAttempts: 'محاولات كتير. استنى كام دقيقة وجرّب تاني.',
    invalidCode: 'الكود غلط أو خلص وقته. جرّب تاني.',
    serverError: 'حصلت مشكلة من عندنا. جرّب تاني بعد شوية.',
    loginFailed: 'معرفناش نسجّل دخولك. جرّب تاني.',
    mfaVerifyFailed: 'معرفناش نتحقق من الكود. جرّب تاني.',
    adminNeedsSecondFactor:
      'مسؤولو المنصة بيدخلوا بمفتاح مرور أو كود من تطبيق المصادقة. استخدم مفتاح المرور عشان تكمّل.',
    signingIn: 'بنسجّل دخولك…',
    verifying: 'بنتحقق من الكود…',
  },
  en: {
    invalidCredentials: 'The email or password is not right. Check them and try again.',
    emailNotVerified: 'Please verify your email first. We sent you a code.',
    tooManyAttempts: 'Too many attempts. Please wait a few minutes and try again.',
    invalidCode: 'That code is wrong or has expired. Try again.',
    serverError: 'Something went wrong on our side. Try again in a moment.',
    loginFailed: 'We could not sign you in. Try again.',
    mfaVerifyFailed: 'We could not verify the code. Try again.',
    adminNeedsSecondFactor:
      'Platform admins sign in with a passkey or an authenticator code. Use your passkey to continue.',
    signingIn: 'Signing you in…',
    verifying: 'Checking the code…',
  },
} as const;

export interface SignInPageInput {
  lang: SignInLang;
  /** Show the Chat sign-up link (the flag lives in Chat; accounts learns it from `CHAT_SIGNUP_LINK`). Default hidden. */
  showChatSignup?: boolean;
  product: SignInProduct;
  /** Already validated by `signInReturn`. */
  returnTo: string;
}

/** The query that carries the person's context to another page (language switch, the Store's passkey sign-in). */
function carry(
  product: SignInProduct,
  returnTo: string,
  extra: Record<string, string> = {}
): string {
  const q = new URLSearchParams(extra);
  if (product !== 'studio') q.set('product', product);
  if (returnTo !== DEFAULT_RETURN) q.set('return', returnTo);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The sign-up link under the form: Store -> Store sign-up; Chat -> accounts' Chat sign-up, only when the flag allows. */
function signupLinkHtml(
  c: (typeof COPY)[SignInLang],
  product: SignInProduct,
  returnTo: string,
  showChatSignup: boolean
): string {
  if (product !== 'chat')
    return `<p class="aside"><a href="${STORE}/signup">${esc(c.noAccount)}</a></p>`;
  if (!showChatSignup) return '';
  const q = new URLSearchParams({ product: 'chat' });
  if (returnTo !== DEFAULT_RETURN) q.set('return', returnTo);
  return `<p class="aside"><a href="${esc(`/signup?${q}`)}">${esc(c.chatNoAccount)}</a></p>`;
}

export function renderSignInPage({
  lang,
  product,
  returnTo,
  showChatSignup = false,
}: SignInPageInput): string {
  const c = COPY[lang];
  const other: SignInLang = lang === 'ar' ? 'en' : 'ar';
  const company = lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn;
  // `<` is escaped inside the JSON data block so no sentence can ever close the script element.
  const msgs = JSON.stringify(MESSAGES[lang]).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${c.title[product]} · ${company}`)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="${BRAND.colors.night}">
<link rel="icon" href="https://${BRAND.domains.marketing}/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/sign-in.css">
<script src="/sign-in.js" defer></script>
</head>
<body>
<a class="skip" href="#main">${esc(c.skip)}</a>
<header><a class="brand" href="https://${BRAND.domains.marketing}/">${brandMarkSvg({ size: 28 })}<span>${esc(company)}</span></a></header>
<main id="main" data-return="${esc(returnTo)}" data-store="${esc(STORE)}">
<section id="step-password">
<h1>${esc(c.title[product])}</h1>
<p class="hint">${esc(c.subtitle[product])}</p>
<noscript><p class="alert">${esc(c.noscript)}</p></noscript>
<p class="alert" id="error" role="alert" tabindex="-1" hidden></p>
<form id="password-form" method="post" novalidate>
<label for="email">${esc(c.email)}</label>
<input id="email" name="email" type="email" autocomplete="username" inputmode="email" dir="ltr" required maxlength="254">
<label for="password">${esc(c.password)}</label>
<input id="password" name="password" type="password" autocomplete="current-password" dir="ltr" required maxlength="200">
<p class="row"><a href="${STORE}/forgot-password">${esc(c.forgot)}</a></p>
<button type="submit" data-label="${esc(c.signIn)}">${esc(c.signIn)}</button>
</form>
<p class="aside"><a href="${esc(`${STORE}/login${carry(product, returnTo)}`)}">${esc(c.passkey)}</a></p>
${signupLinkHtml(c, product, returnTo, showChatSignup)}
</section>
<section id="step-mfa" hidden>
<h1>${esc(c.mfaTitle)}</h1>
<p class="hint" id="mfa-hint" data-totp="${esc(c.mfaSubtitle)}" data-backup="${esc(c.mfaBackupSubtitle)}">${esc(c.mfaSubtitle)}</p>
<p class="alert" id="mfa-error" role="alert" tabindex="-1" hidden></p>
<form id="mfa-form" method="post" novalidate>
<label for="mfa-code">${esc(c.mfaCode)}</label>
<input id="mfa-code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" dir="ltr" required maxlength="6">
<button type="submit" data-label="${esc(c.mfaVerify)}">${esc(c.mfaVerify)}</button>
</form>
<p class="aside"><button type="button" class="link" id="mfa-toggle" data-totp="${esc(c.mfaBackupLink)}" data-backup="${esc(c.mfaTotpLink)}">${esc(c.mfaBackupLink)}</button></p>
<p class="aside"><button type="button" class="link" id="mfa-back">${esc(c.back)}</button></p>
</section>
</main>
<footer>
<span>© ${new Date().getUTCFullYear()} ${esc(company)}</span>
<a href="${esc(`/login${carry(product, returnTo, { lang: other })}`)}" hreflang="${other}" lang="${other}">${esc(c.switchTo)}</a>
</footer>
<script type="application/json" id="messages">${msgs}</script>
</body>
</html>`;
}

/** CSP for the page: only this Worker's own script, style and endpoints; no form ever submits without the script. */
export const SIGN_IN_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  `img-src https://${BRAND.domains.marketing}`,
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SIGN_IN_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  Vary: 'Accept-Language',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': SIGN_IN_PAGE_CSP,
};

export const SIGN_IN_CSS = `
:root{color-scheme:dark;--night:${BRAND.colors.night};--gold:${BRAND.colors.gold};--lift:${BRAND.colors.lift};--fg:#f3f1ec;--muted:#a9a49b;--line:#2b2d2f;--field-line:#6f6a60;--panel:#121415;--bad:#f2b8b5}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-block-size:100dvh;background:var(--night);color:var(--fg);font:400 1rem/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI","IBM Plex Sans Arabic","Noto Sans Arabic",Tahoma,sans-serif;display:flex;flex-direction:column}
a{color:var(--lift);text-underline-offset:.22em;text-decoration-thickness:1px}
:focus-visible{outline:2px solid var(--lift);outline-offset:3px;border-radius:6px}
.skip{position:absolute;inset-inline-start:-9999px}
.skip:focus{inset-inline-start:16px;top:12px;background:var(--panel);padding:8px 12px;border-radius:8px;z-index:2}
header,footer{padding:20px 16px;max-inline-size:440px;inline-size:100%;margin-inline:auto}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--fg);text-decoration:none;font-weight:600}
main{flex:1;inline-size:100%;max-inline-size:440px;margin-inline:auto;padding:24px 16px 40px}
h1{margin:0 0 8px;font-size:clamp(1.6rem,6vw,2.1rem);line-height:1.25;font-weight:600;letter-spacing:-.01em}
.hint{margin:0 0 24px;color:var(--muted)}
form{display:flex;flex-direction:column;gap:6px}
label{font-size:.9rem;font-weight:500;margin-block-start:10px}
input{inline-size:100%;block-size:48px;padding-inline:14px;background:var(--panel);color:var(--fg);border:1px solid var(--field-line);border-radius:12px;font:inherit;font-size:1rem}
input:focus{border-color:var(--gold);outline:2px solid var(--gold);outline-offset:0}
.row{margin:6px 0 10px;font-size:.9rem}
button[type=submit]{block-size:48px;margin-block-start:8px;background:var(--gold);color:var(--night);border:0;border-radius:12px;font:inherit;font-weight:600;cursor:pointer}
button[type=submit]:hover{background:var(--lift)}
button[disabled]{opacity:.7;cursor:progress}
.link{background:none;border:0;padding:0;color:var(--lift);font:inherit;text-decoration:underline;text-underline-offset:.22em;cursor:pointer;min-block-size:44px}
.aside{margin:16px 0 0;font-size:.95rem}
.alert{margin:0 0 16px;padding:12px 14px;border:1px solid #5c2b2b;background:#1f1213;color:var(--bad);border-radius:12px}
footer{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:.875rem;border-top:1px solid var(--line)}
[hidden]{display:none!important}
.hp{position:absolute;inset-inline-start:-9999px;inline-size:1px;block-size:1px;overflow:hidden}
`;

/**
 * The page's behaviour. Plain script (no build step), served as /sign-in.js. It mirrors the Store sign-in: the same
 * request bodies, the same refusal-to-sentence mapping (`signInMessageKey`), the same outcomes.
 */
export const SIGN_IN_JS = `(function () {
  'use strict';
  var main = document.getElementById('main');
  if (!main) return;
  var msgs = JSON.parse(document.getElementById('messages').textContent || '{}');
  var dest = main.getAttribute('data-return') || '';
  var store = main.getAttribute('data-store') || '';
  var challenge = null;
  var backup = false;
  var $ = function (id) { return document.getElementById(id); };

  function go(url) {
    // The server validated the destination; this only refuses anything that is not an absolute https URL.
    if (/^https:\\/\\//i.test(url)) window.location.assign(url);
  }
  function keyFor(status, code) {
    if (code === 'EMAIL_NOT_VERIFIED') return 'emailNotVerified';
    if (status === 429 || code === 'ACCOUNT_LOCKED' || code === 'TOO_MANY_ATTEMPTS') return 'tooManyAttempts';
    if (code === 'INVALID_CODE' || code === 'INVALID_CHALLENGE') return 'invalidCode';
    if (status === 401 || status === 403) return 'invalidCredentials';
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
  function finish(data) {
    // A platform admin without a second factor enrols one first (as on the Store sign-in); the return waits.
    go(data && data.mfaEnrollmentRequired ? store + '/account/security' : dest);
  }
  function showStep(mfa) {
    $('step-password').hidden = mfa;
    $('step-mfa').hidden = !mfa;
    $(mfa ? 'mfa-code' : 'email').focus();
  }
  function setBackup(on) {
    backup = on;
    var input = $('mfa-code');
    input.value = '';
    input.setAttribute('inputmode', on ? 'text' : 'numeric');
    input.maxLength = on ? 10 : 6;
    $('mfa-hint').textContent = $('mfa-hint').getAttribute(on ? 'data-backup' : 'data-totp');
    $('mfa-toggle').textContent = $('mfa-toggle').getAttribute(on ? 'data-backup' : 'data-totp');
  }

  $('password-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var err = $('error');
    var email = $('email').value.trim();
    var password = $('password').value;
    if (!email || !password) return;
    err.hidden = true;
    busy(form, true, 'signingIn');
    post('/login', { email: email, password: password, aud: 'store' }).then(function (res) {
      if (!res.r.ok || !res.j || !res.j.success) return say(err, refusal(res));
      var d = res.j.data || {};
      if (d.mfaRequired) {
        challenge = d.challenge;
        $('password').value = '';
        setBackup(false);
        $('mfa-error').hidden = true;
        return showStep(true);
      }
      if (d.secondFactorRequired) return say(err, 'adminNeedsSecondFactor');
      finish(d);
    }, function () { say(err, 'loginFailed'); }).then(function () { busy(form, false); });
  });

  $('mfa-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var err = $('mfa-error');
    var code = $('mfa-code').value.trim();
    if (!code || !challenge) return;
    err.hidden = true;
    busy(form, true, 'verifying');
    var body = backup ? { challenge: challenge, backupCode: code } : { challenge: challenge, code: code };
    post('/login/mfa', body).then(function (res) {
      if (!res.r.ok || !res.j || !res.j.success) return say(err, refusal(res));
      finish(res.j.data);
    }, function () { say(err, 'mfaVerifyFailed'); }).then(function () { busy(form, false); });
  });

  $('mfa-toggle').addEventListener('click', function () { setBackup(!backup); });
  $('mfa-back').addEventListener('click', function () {
    challenge = null;
    $('error').hidden = true;
    showStep(false);
  });
})();
`;
