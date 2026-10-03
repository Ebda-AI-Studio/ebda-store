import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, localeCookieName } from './config';
import { intlFormats } from './formats';

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const stored = cookieStore.get(localeCookieName)?.value;
  const locale = isLocale(stored) ? stored : defaultLocale;

  const messages = (await import(`./messages/${locale}.json`)).default;

  return {
    locale,
    messages,
    timeZone: 'Africa/Cairo',
    formats: intlFormats,
  };
});
