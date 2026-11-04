import { escapeHtml } from './_util';

export interface ContactEnquiryData {
  requestId: string;
  name: string;
  company?: string;
  /** E.164 as normalised by the API. */
  phone: string;
  /** The site's display form of the phone. */
  phoneDisplay: string;
  email: string;
  topicLabel: string;
  message: string;
  lang: 'ar' | 'en';
}

/** To the studio inbox (English, internal). Every visitor-typed value goes through escapeHtml. */
export function contactEnquiryHtml(d: ContactEnquiryData): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">${k}</td><td style="padding:4px 0" dir="auto">${escapeHtml(v)}</td></tr>`;
  return `
    <h2>New studio enquiry</h2>
    <table role="presentation" style="border-collapse:collapse">
      ${row('Name', d.name)}
      ${d.company ? row('Company / store', d.company) : ''}
      ${row('Phone', d.phoneDisplay)}
      ${row('Email', d.email)}
      ${row('Needs', d.topicLabel)}
      ${row('Page language', d.lang === 'ar' ? 'Arabic' : 'English')}
      ${row('Reference', d.requestId)}
    </table>
    <div dir="auto" style="background:#f9f9f9;padding:16px;border-radius:4px;margin:16px 0;white-space:pre-wrap">${escapeHtml(d.message)}</div>
    <p style="font-size:14px;color:#666">Reply to this email to answer the visitor directly.</p>`;
}

export function contactEnquiryText(d: ContactEnquiryData): string {
  return [
    'New studio enquiry',
    `Name: ${d.name}`,
    ...(d.company ? [`Company / store: ${d.company}`] : []),
    `Phone: ${d.phoneDisplay}`,
    `Email: ${d.email}`,
    `Needs: ${d.topicLabel}`,
    `Reference: ${d.requestId}`,
    '',
    d.message,
  ].join('\n');
}

/** To the visitor: short, in the language of the page they used. Does not repeat their message. */
export const contactEnquiryReceipt = {
  subject: {
    en: 'We got your message',
    ar: 'وصلتنا رسالتك',
  },
  en: (d: Pick<ContactEnquiryData, 'name' | 'requestId'>) => `
    <h2>We got your message</h2>
    <p>Hi ${escapeHtml(d.name)}, your message reached us and we will reply within one working day.</p>
    <p style="font-size:14px;color:#666">Reference: ${escapeHtml(d.requestId)}. If you did not send this, you can ignore this email.</p>`,
  ar: (d: Pick<ContactEnquiryData, 'name' | 'requestId'>) => `
    <h2 dir="rtl">وصلتنا رسالتك</h2>
    <p dir="rtl">أهلاً ${escapeHtml(d.name)}، وصلتنا رسالتك، هنرد عليك خلال يوم عمل.</p>
    <p dir="rtl" style="font-size:14px;color:#666">الرقم المرجعي: ${escapeHtml(d.requestId)}. لو مش إنت اللي بعتها، تجاهل الرسالة دي.</p>`,
};
