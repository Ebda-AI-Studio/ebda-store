import { escapeHtml } from './_util';

export interface WelcomeData {
  email: string;
  name: string;
}

export const welcomeTemplate = {
  subject: {
    en: (_d: WelcomeData, storeName: string) => `Welcome to ${storeName}`,
    ar: (_d: WelcomeData, storeName: string) => `أهلاً بيك في ${storeName}`,
  },

  en: (d: WelcomeData, _storeName: string, webUrl: string) => `
    <h2>Welcome${d.name ? ', ' + escapeHtml(d.name) : ''}!</h2>
    <p>Thank you for creating an account with us. We're excited to have you!</p>
    <p>You can now:</p>
    <ul>
      <li>Browse our catalog of products</li>
      <li>Save items to your wishlist</li>
      <li>Track your orders</li>
      <li>Get exclusive offers</li>
    </ul>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(webUrl)}/products" class="button">Start Shopping</a>
    </p>
  `,

  ar: (d: WelcomeData, _storeName: string, webUrl: string) => `
    <h2>أهلاً${d.name ? '، ' + escapeHtml(d.name) : ''}!</h2>
    <p>شكراً إنك عملت حساب عندنا. فرحانين بيك!</p>
    <p>دلوقتي تقدر:</p>
    <ul>
      <li>تتصفح المنتجات</li>
      <li>تحفظ المنتجات في المفضلة</li>
      <li>تتابع طلباتك</li>
      <li>تستمتع بالعروض الحصرية</li>
    </ul>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(webUrl)}/products" class="button">ابدأ التسوق</a>
    </p>
  `,
};
