/**
 * Ruling PROVIDERS-3: the merchant-facing outcome of the automatic check that runs when provider
 * credentials are saved. One pure mapper shared by the API (response) and the admin (copy), so the
 * Egyptian-Arabic and English wording lives in one place. It never echoes a provider message:
 * only the code decides the text, so no secret or raw provider body can reach a browser.
 */
export type ConnectionCheckStatus =
  | 'connected'
  | 'credentials_wrong'
  | 'unreachable'
  | 'unrecognized'
  | 'unverified';

export interface ConnectionCheckInput {
  ok: boolean;
  /** The adapter's test code (`ok`, `bad_credentials`, `wrong_mode`, `incomplete`, `unreachable`, `unknown`, `no_check`). */
  code: string;
  message?: string;
}

export interface ConnectionCheckView {
  status: ConnectionCheckStatus;
  ok: boolean;
  /** True when the connection is usable but NOT proven (show a warning). */
  warning: boolean;
  code: string;
  messageEn: string;
  messageAr: string;
}

/** Successful real operations after which a provider is flagged verified (env override in the API). */
export const AUTO_VERIFY_AFTER_DEFAULT = 3;

export function describeConnectionCheck(input: ConnectionCheckInput): ConnectionCheckView {
  const base = { code: input.code };
  if (input.ok && input.code === 'no_check') {
    return {
      ...base,
      status: 'unverified',
      ok: true,
      warning: true,
      messageEn:
        'Saved, but this provider has no safe test call, so the connection is unverified. Your first real order will confirm it.',
      messageAr:
        'اتحفظت البيانات، بس الشركة دي مفيهاش اختبار آمن، فالربط لسه مش متأكد منه. أول طلب حقيقي هيأكده.',
    };
  }
  if (input.ok) {
    return {
      ...base,
      status: 'connected',
      ok: true,
      warning: false,
      messageEn: 'Connected. The provider accepted your credentials.',
      messageAr: 'اتوصلنا بنجاح. الشركة قبلت بياناتك.',
    };
  }
  switch (input.code) {
    case 'bad_credentials':
    case 'wrong_mode':
    case 'incomplete':
      return {
        ...base,
        status: 'credentials_wrong',
        ok: false,
        warning: false,
        messageEn:
          input.code === 'wrong_mode'
            ? 'These credentials belong to the other mode (sandbox vs live). Check the mode and the keys.'
            : input.code === 'incomplete'
              ? 'Some required fields are missing or malformed. Nothing was sent to the provider.'
              : 'The provider rejected these credentials. Check them and save again.',
        messageAr:
          input.code === 'wrong_mode'
            ? 'البيانات دي تبع الوضع التاني (تجريبي أو فعلي). راجع الوضع والمفاتيح.'
            : input.code === 'incomplete'
              ? 'فيه خانات ناقصة أو مكتوبة غلط. مفيش حاجة اتبعتت للشركة.'
              : 'الشركة رفضت البيانات دي. راجعها واحفظ تاني.',
      };
    case 'unreachable':
      return {
        ...base,
        status: 'unreachable',
        ok: false,
        warning: false,
        messageEn:
          'We could not reach the provider right now. Your credentials were saved; try the check again in a few minutes.',
        messageAr: 'مقدرناش نوصل للشركة دلوقتي. البيانات اتحفظت، جرّب الاختبار تاني بعد شوية.',
      };
    default:
      return {
        ...base,
        status: 'unrecognized',
        ok: false,
        warning: false,
        messageEn:
          'The provider answered in a way we do not recognise. Your credentials were saved; the Ebda Store team has been told.',
        messageAr: 'الشركة ردت برد مش مفهوم عندنا. البيانات اتحفظت، وفريق ابدأ ستور اتبلغ.',
      };
  }
}
