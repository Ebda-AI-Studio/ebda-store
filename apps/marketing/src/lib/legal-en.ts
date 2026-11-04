import { BRAND } from '@ebda/shared/brand';
import { PRIVACY_STACK } from '@ebda/shared/legal';
import { POST_CUTOVER } from './legal-privacy-stack';
import { DELETION_EN } from './legal-deletion';
import { REFUND_EN } from './legal-refund';
import { LEGAL_WA_EN } from './legal-wa-en';
import type { LegalPages } from './legal-types';

const OP = BRAND.company.shortNameEn;

/**
 * English legal text. Version, publish date and effective date of each document live in
 * LEGAL_POLICIES (packages/shared/src/legal); bump it in the same PR as any text change
 * (docs/runbooks/legal-policy-change.md). Original wording written from the common protective
 * structure of SaaS store-builder terms; not reviewed by counsel.
 */
export const LEGAL_EN: LegalPages = {
  updated: { label: 'Last updated', versionLabel: 'Version' },
  toc: 'On this page',
  notice:
    'We may update this document as described in its "Changes" section. The Arabic text is the primary text.',
  back: 'Back to home',
  legal: {
    title: 'Legal notice',
    sections: [
      {
        h: 'Who we are',
        p: [
          '"Ebda Store" («ابدأ ستور»), available at ebda.app, is an online store builder for merchants in Egypt (the "Service"). The Service is a technology platform owned and operated by ' +
            OP +
            ' ("we", "us"). The operating legal entity is ' +
            BRAND.company.legalNameEn +
            '. Ebda AI Studio is our company brand.',
        ],
      },
      {
        h: 'What Ebda Store is, and is not',
        p: [
          "Ebda Store provides software tools that let merchants build and run their own online stores. Ebda Store is not the seller of the goods or services sold through a store, is not a party to any sale between a merchant and the merchant's customer, does not hold or transfer merchants' sales proceeds, does not ship goods, and does not inspect or verify products.",
        ],
      },
      {
        h: 'Contact',
        p: [
          'General and legal requests: ahlan@ebda.app. Privacy, data-protection and erasure requests, and our data protection officer: privacy@ebda.app. Security reports: security@ebda.app.',
        ],
      },
      {
        h: 'Governing law and courts',
        p: [
          'The laws of the Arab Republic of Egypt apply, and the courts of Cairo have jurisdiction, as set out in the Terms of Service.',
        ],
      },
      {
        h: 'Intellectual property',
        p: [
          'The Ebda AI Studio and Ebda Store names, logos, website and software belong to us or our licensors. Content in a store belongs to the merchant who published it. If you believe content in a store infringes your rights, write to ahlan@ebda.app with the store address, the content concerned, and proof of your rights; we will review it and may remove or disable the content.',
        ],
      },
      {
        h: 'Related documents',
        p: [
          'Terms of Service, Merchant Agreement, Acceptable Use Policy, Privacy Policy and the data deletion page for Ebda Store, and the Terms of Service, Privacy Policy and Data Processing Agreement for Ebda Chat, all published on this website.',
        ],
      },
    ],
  },
  terms: {
    title: 'Terms of service',
    sections: [
      {
        h: '1. Acceptance',
        p: [
          'These terms are an agreement between you and ' +
            OP +
            ', which owns and operates Ebda Store (the "Service"). By creating an account, opening a store or using the website or the Service, you accept these terms, the Merchant Agreement, the Acceptable Use Policy and the Privacy Policy. If you do not accept them, do not use the Service. If you accept on behalf of a business, you confirm that you have authority to do so.',
        ],
      },
      {
        h: '2. Eligibility and your account',
        p: [
          'You must be at least 18 and legally able to enter a contract. You must give accurate information and keep it current. You are responsible for your password, for everything done through your account, and for the people you give access to. Tell us promptly at ahlan@ebda.app if you suspect unauthorised access.',
        ],
      },
      {
        h: '3. The Service, and our role',
        p: [
          "Ebda Store is a software platform. We provide tools only. We are not the seller, agent, marketplace operator, payment institution, carrier or insurer for any sale made through a store. Every sale is solely between the merchant and the merchant's customer, and the merchant is solely responsible for it. We do not hold merchants' funds: customers pay the merchant directly (for example cash on delivery, or the merchant's own InstaPay account or payment gateway).",
          'We do not verify, endorse or guarantee any store, product, price, description, review or merchant, and we are not responsible for disputes between merchants and their customers.',
        ],
      },
      {
        h: '4. Plans, fees and payment',
        p: [
          'Paid plans, prices and billing rules are in the Merchant Agreement and the Pricing section of the website. Fees are charged in advance, in Egyptian pounds, and are non-refundable except where mandatory law says otherwise. Prices and VAT. All prices are final amounts in Egyptian pounds. We are not registered for value-added tax (VAT) and therefore charge none. If we become registered, VAT will be introduced only after at least 30 days of written notice, as a change to fees, will be shown as a separate line, and will never apply retroactively to any amount already paid or invoiced.',
          'Ebda Chat is a separate service with its own terms (https://ebda.app/legal/whatsapp-terms/). If you use it, those terms apply to it in addition to these.',
        ],
      },
      {
        h: '5. Your content',
        p: [
          'You keep ownership of what you upload or publish ("Content"). You give us a worldwide, non-exclusive licence to host, store, copy, resize, display and transmit it as needed to run, secure and improve the Service and to show your store to its visitors. You confirm that you have all rights needed for your Content and that it complies with the Acceptable Use Policy and applicable law.',
        ],
      },
      {
        h: '6. Our intellectual property',
        p: [
          'The Service, its software, design and brand belong to us or our licensors. We grant you a limited, revocable, non-transferable right to use the Service while your account is in good standing. You may not copy, resell, reverse-engineer or attempt to extract the source code of the Service, except where the law allows.',
        ],
      },
      {
        h: '7. Third-party services',
        p: [
          'The Service works with services run by others, such as hosting, email, analytics, AI, payment, shipping and messaging providers, and links to external sites. We do not control them and are not responsible for their availability, accuracy, conduct, security or terms. Your use of them is at your own risk and under their own terms. A third party stopping or changing its service is not a breach by us.',
        ],
      },
      {
        h: '8. AI features',
        p: [
          'Some features use artificial intelligence to suggest text or other content. Output can be wrong, incomplete or similar to other output. You must review it before use and are responsible for what you publish. Do not enter information you are not allowed to share with our AI provider.',
        ],
      },
      {
        h: '9. Availability and changes to the Service',
        p: [
          'We aim for a reliable Service but do not promise that it will be uninterrupted, error-free or free of data loss. We may change, limit or discontinue features at any time, and perform maintenance. You are responsible for keeping your own copies of important data; export tools are provided as they become available.',
        ],
      },
      {
        h: '10. Disclaimer of warranties',
        p: [
          'To the fullest extent permitted by law, the Service is provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose, merchantability, non-infringement, accuracy, sales results or uninterrupted operation. We give no assurance about the revenue, traffic or customers you may obtain.',
        ],
      },
      {
        h: '11. Limitation of liability',
        p: [
          'To the fullest extent permitted by law, we are not liable for indirect, incidental, special or consequential loss, or for lost profits, revenue, sales, goodwill, customers or data, however caused, even if we were told it could happen.',
          'Our total liability to you for all claims arising out of or relating to the Service is limited to the fees you paid to Ebda Store in the 3 months before the event that gave rise to the claim.',
          'Nothing in these terms excludes or limits liability that cannot be excluded or limited under mandatory Egyptian law, including liability for fraud or gross fault.',
        ],
      },
      {
        h: '12. Indemnity',
        p: [
          'You will defend, compensate and hold harmless Ebda Store, ' +
            OP +
            ' and its owner, personnel and service providers against claims, losses, penalties and costs (including reasonable legal fees) brought by any third party, customer or authority arising from your store, products, Content, taxes, customer data, breach of these terms or the Acceptable Use Policy, or violation of law or third-party rights.',
        ],
      },
      {
        h: '13. Suspension and termination',
        p: [
          'You may stop using the Service at any time. To close your account and have your store and its data deleted, write to privacy@ebda.app from the email address on the account; we delete or anonymise them within 90 days of your request (Privacy Policy, section 7). Fees already paid are not refunded.',
          'We may suspend, restrict or terminate an account, a store or any feature, with or without notice, if we reasonably believe you breached these terms, the Merchant Agreement or the Acceptable Use Policy; if a store is, or appears to be, unlawful, fraudulent or harmful; if required by law or an authority; if fees are unpaid; or to protect the Service, our users or third parties. We will try to give notice where it is practical and lawful. Where fees are unpaid, the process in the Merchant Agreement applies.',
          'On termination your right to use the Service ends, unpaid fees become due, and your store and data are then deleted as described in the Merchant Agreement and the Privacy Policy. Sections that by their nature should survive (including 5, 10, 11, 12, 14 and 16) survive.',
        ],
      },
      {
        h: '14. Events beyond our control',
        p: [
          'We are not liable for delay or failure caused by events beyond our reasonable control, including natural events, war, terrorism, strikes, government action, power, internet, telecom or cloud-provider outages, banking or payment-network disruption, and attacks on our systems.',
        ],
      },
      {
        h: '15. Changes to these terms',
        p: [
          "We may update these terms. We will post the new version here with a new version number and date, and for material changes that affect fees we will give at least 30 days' notice by email or in the dashboard. Continuing to use the Service after a change takes effect means you accept it; if you do not, close your account before then.",
        ],
      },
      {
        h: '16. Governing law and disputes',
        p: [
          'These terms are governed by the laws of the Arab Republic of Egypt. Before starting any proceeding, both sides will try in good faith to settle the dispute by writing to the other (to us: ahlan@ebda.app) and allowing 30 days. Failing that, the courts of Cairo have exclusive jurisdiction. This does not take away any right that a consumer has under Consumer Protection Law No. 181 of 2018 where it applies mandatorily.',
        ],
      },
      {
        h: '17. General',
        p: [
          'These documents are the entire agreement on their subject. If a provision is invalid, the rest remains valid. Our not enforcing a right is not a waiver. You may not transfer your rights without our written consent; we may transfer ours with the business. If the Arabic and English texts differ, the Arabic text prevails. Contact: ahlan@ebda.app.',
        ],
      },
    ],
  },
  merchant: {
    title: 'Merchant agreement',
    sections: [
      {
        h: '1. Scope',
        p: [
          'This agreement applies to anyone who opens a store on Ebda Store ("Merchant") and supplements the Terms of Service. If they conflict on a merchant matter, this agreement prevails. Ebda Store is owned and operated by ' +
            OP +
            '.',
        ],
      },
      {
        h: '2. You are the seller',
        p: [
          "The Merchant is the seller and supplier for every order placed in the Merchant's store. Ebda Store is not the seller of record, is not a party to the sale, and does not set, guarantee or collect the Merchant's prices, orders or proceeds. The Merchant is responsible for the products, descriptions, prices, availability, quality, safety, packaging, delivery, returns, refunds, warranties, invoices and customer service.",
        ],
      },
      {
        h: '3. Legal compliance and consumer protection',
        p: [
          "The Merchant must comply with all laws that apply to the Merchant's business and products, including Egypt's Consumer Protection Law No. 181 of 2018 and e-commerce rules: clear and truthful information about the business, products, total price and delivery; honest advertising; honouring return, exchange and warranty rights owed to consumers; and handling complaints. The Merchant must hold every licence, registration and permit that its business or products require, and must publish its own policies (delivery, returns, refunds, privacy) in its store.",
        ],
      },
      {
        h: '4. Taxes and VAT',
        p: [
          'The Merchant alone is responsible for all taxes, duties and filing obligations on its sales and income, including VAT, income tax, e-invoicing and customs. Ebda Store does not give tax advice, does not act as a tax agent and does not collect or remit tax for the Merchant. The VAT feature is available only to Merchants whose VAT registration has been verified by us; it is a tool, and the Merchant remains responsible for the accuracy of the rates, registration details, invoices and returns. Prices and VAT. All prices are final amounts in Egyptian pounds. We are not registered for value-added tax (VAT) and therefore charge none. If we become registered, VAT will be introduced only after at least 30 days of written notice, as a change to fees, will be shown as a separate line, and will never apply retroactively to any amount already paid or invoiced.',
        ],
      },
      {
        h: '5. Payments and funds',
        p: [
          "Ebda Store does not process, hold or settle the Merchant's sales proceeds. Customers pay the Merchant directly by the methods the Merchant enables (such as cash on delivery, the Merchant's own InstaPay account or a gateway the Merchant has contracted with). Installment (buy now, pay later) services are off by default and are financed by the provider, not by Ebda Store; the Merchant who enables one is responsible for telling customers that the provider's own terms and fees apply. For orders that include gold, cash on delivery and installments are off by default and the order is paid in full online, unless the Merchant switches that setting on, in which case the choice is the Merchant's. Any payment provider is bound by its own terms, and the Merchant is responsible for fees, chargebacks, reversals, fraud and reconciliation. Ebda Store is not liable for non-payment, failed or disputed payments, or provider errors.",
        ],
      },
      {
        h: '6. Shipping and fulfilment',
        p: [
          'Ebda Store does not ship, store or handle goods. The Merchant arranges delivery and is responsible for carriers, delays, loss, damage and returns.',
        ],
      },
      {
        h: '7. Prohibited products and conduct',
        p: [
          'The Merchant must not sell or promote anything prohibited by the Acceptable Use Policy or by law, including alcohol, pork products, paid-entry prize draws, mystery boxes sold for chance, fake reviews, and fake scarcity or countdown timers. We may review, remove or block any product, store or Content, but we have no duty to monitor, and not acting is not approval.',
        ],
      },
      {
        h: '8. Customer data: roles and duties',
        p: [
          "For personal data of the Merchant's own customers and visitors that is processed through a store, the Merchant is the controller and Ebda Store acts as a processor on the Merchant's documented instructions (the store settings and use of the Service). For the Merchant's own account, billing and contact data, Ebda Store is a controller. See the Privacy Policy.",
          "The Merchant must have a lawful basis and give its customers the notices and obtain the consents required by Personal Data Protection Law No. 151 of 2020; must use data only for lawful purposes; must answer its customers' rights requests; and must not use Ebda Store tools to send unsolicited marketing. Ebda Store will process that data only to provide the Service, apply appropriate security measures, use the sub-processors listed in the Privacy Policy, and help the Merchant, at reasonable request, to respond to rights requests and to security incidents. The Merchant authorises these sub-processors.",
          "Ebda Store will tell the Merchant of a personal data breach that affects the Merchant's customers' data without undue delay and in any case within 72 hours of becoming aware of it, so that the Merchant can meet its own duty to notify the Personal Data Protection Centre under Law No. 151 of 2020. Where personal data is transferred outside Egypt, it is done only under the safeguards that law requires (appropriate contractual and technical measures with the receiving provider).",
        ],
      },
      {
        h: '9. Plans and fees',
        p: [
          "Ebda Store offers monthly and yearly plans: Basic (EGP 1,490), Growth (EGP 3,490) and Business (EGP 9,990) per month, or the same plans billed yearly at 25% off (EGP 13,410, 31,410 and 89,910 per year), with no commission charged by Ebda Store on orders. New stores may try the Growth plan free for 14 days; nothing is charged during the trial, and when it ends the store moves to a paid plan only once you choose and pay for one. Prices, features and limits are shown on the Pricing section and may change with 30 days' notice; a change takes effect from the next billing period. Plan prices are final amounts in Egyptian pounds; no VAT is charged (see Taxes and VAT above).",
        ],
      },
      {
        h: '10. Billing, reminders and non-payment',
        p: [
          'For now, plans are paid manually by InstaPay. We send payment reminders 7, 3 and 1 days before the due date and on the due date. If payment is not received within 3 days after the due date (the "grace period"), we may suspend the store. A suspended store is not shown to customers and orders cannot be placed until the account is settled; the Merchant stays responsible for orders already placed and for fees due. The dashboard stays accessible so the Merchant can pay. After payment is confirmed we will lift the suspension. Suspension does not delete the store or its data. If the account remains unpaid, we may terminate it after notice by email.',
        ],
      },
      {
        h: '11. No refunds',
        p: [
          'Subscription fees (monthly or yearly) are charged in advance and are non-refundable, including for partial periods, downgrades, unused time (including the rest of a yearly term) and closure of the account, except where mandatory law requires a refund or where we charged you in error, in which case we will correct the error. You can cancel from the subscription page in the dashboard at any time; cancelling stops future charges and does not refund past ones. Fees are never charged during the free trial.',
        ],
      },
      {
        h: '12. Intellectual property and content',
        p: [
          "The Merchant confirms that it owns or is licensed to use all Content, names, images, logos and products in its store, and that the Content does not infringe anyone's rights. The Merchant grants Ebda Store the licence described in the Terms of Service. We may remove Content after a credible complaint.",
        ],
      },
      {
        h: '13. Service level and backups',
        p: [
          'The Service is provided without a guaranteed uptime. We make reasonable efforts to keep backups for our own recovery purposes, but do not promise to restore any particular data. The Merchant should keep its own copy of products, orders and customer records.',
        ],
      },
      {
        h: '14. Suspension, termination and data on exit',
        p: [
          'The suspension and termination rights in the Terms of Service apply. On termination or closure, the Merchant should export what it needs. Ebda Store keeps the store and its data until the Merchant asks for deletion or the account is closed, and then deletes them within 90 days, subject to the records described in the Privacy Policy. We may keep records that the law or our legitimate interests (such as fraud prevention and dispute defence) require, as described in the Privacy Policy.',
        ],
      },
      {
        h: '15. Liability and indemnity',
        p: [
          "The disclaimers, the limit of liability (fees paid in the 3 months before the event) and the Merchant's indemnity in the Terms of Service apply fully to this agreement. In particular, the Merchant indemnifies Ebda Store against every claim by its customers, regulators, tax authorities and third parties arising from its store, products, orders, taxes, data and conduct.",
        ],
      },
      {
        h: '16. Governing law',
        p: [
          'Egyptian law governs this agreement, and the courts of Cairo have exclusive jurisdiction, after the 30-day good-faith negotiation described in the Terms of Service. Contact: ahlan@ebda.app.',
        ],
      },
    ],
  },
  acceptableUse: {
    title: 'Acceptable use policy',
    sections: [
      {
        h: '1. Purpose',
        p: [
          'This policy sets what may not be done on or through Ebda Store. It applies to merchants, their staff, and anyone using the Service. Ebda Store is owned and operated by ' +
            OP +
            '. We may update it as described in the Terms of Service.',
        ],
      },
      {
        h: '2. General rules',
        p: [
          'Do not use the Service to break any law or regulation of Egypt or of the places you sell to; to deceive, defraud or mislead customers; to infringe intellectual property, privacy or other rights; to publish defamatory, hateful, harassing, threatening or sexually explicit material; to send spam or unsolicited messages; to spread malware; or to harm people, especially minors.',
          'Sell honestly and openly. The following are not allowed: charging an entry fee or a purchase for a chance to win a prize (paid-entry prize draws, raffles and lotteries); selling a mystery box or any item whose contents or value are decided by chance; fake, purchased, invented or incentivised-for-rating reviews and testimonials; fake scarcity, such as a countdown timer that restarts, a stock count or "X people are viewing" notice that is not true, or a discount shown against a price that was never charged.',
        ],
      },
      {
        h: '3. Prohibited products and services',
        p: [
          'It is not allowed to sell, offer or promote: illegal drugs, narcotics and psychoactive substances; weapons, ammunition and explosives; counterfeit, pirated or stolen goods; antiquities and cultural property; human organs, trafficked persons or any exploitation of people; adult or pornographic material; gambling and betting; alcoholic drinks and any intoxicating drink or substance; pork and any product made from or containing pork; pyramid, Ponzi or deceptive "get-rich" schemes; unlicensed financial services, deposit-taking, investment offers, and crypto-asset services; stolen, hacked or leaked personal data or accounts; services that facilitate fraud, forgery or cheating on exams; and anything whose sale is prohibited under Egyptian law.',
          'The following may be sold only if the Merchant holds every licence the law requires and shows it on request: medicines, medical devices and supplements; tobacco and vaping products; cosmetics and food products that require registration or approval; and any other regulated or restricted goods. If in doubt, ask us first.',
          'The bans on alcohol and pork apply to everything sold, offered or promoted through any Ebda AI Studio product, including Ebda Store and Ebda Chat, whatever licence the Merchant holds. Listings, images, descriptions, categories and advertising for them are removed.',
          "Through Ebda Chat, Meta's WhatsApp Commerce Policy also applies, and these may not be sold or promoted at all, whatever licence you hold: tobacco and vaping products; prescription drugs; adult products and services; gambling and betting; dating services; and weapons, ammunition and explosives.",
        ],
      },
      {
        h: '4. Prohibited conduct towards the Service',
        p: [
          'Do not attempt to gain unauthorised access to the Service or other accounts, probe or test its security without our written permission, overload or disrupt it, bypass limits or rate limits, scrape it in bulk, resell access, or use it to build a competing service. Do not share your login credentials. Report vulnerabilities to security@ebda.app.',
        ],
      },
      {
        h: '5. Data and messaging',
        p: [
          "Collect and use customers' personal data only lawfully, and only for the purposes you told them. Send marketing messages (email, WhatsApp, SMS, push) only to people who agreed to receive them, with a working way to opt out. Do not use the Service to profile or target people on sensitive grounds.",
        ],
      },
      {
        h: '6. Enforcement',
        p: [
          'If we believe this policy has been breached, we may, without notice and at our discretion, remove content or products, hide or suspend a store, restrict features, terminate the account, withhold refunds of fees, and report to authorities or cooperate with lawful requests. We have no duty to monitor, and our not acting is not permission. Report abuse to ahlan@ebda.app.',
        ],
      },
    ],
  },
  privacy: {
    title: 'Privacy policy',
    sections: [
      {
        h: '1. Who this covers',
        p: [
          'This policy explains how Ebda Store (a product of ' +
            OP +
            ") handles personal data under Egypt's Personal Data Protection Law No. 151 of 2020. It covers: merchants and their staff who use Ebda Store; visitors to ebda.app; and shoppers who buy from a merchant's store. Questions and requests: privacy@ebda.app.",
        ],
      },
      {
        h: '2. Our two roles',
        p: [
          'Controller: for merchant account, billing, support, security and website-visitor data, Ebda Store decides why and how the data is used.',
          "Processor: for the personal data of a merchant's own customers and visitors (orders, addresses, phone numbers, emails, messages), the merchant is the controller and Ebda Store only processes it on the merchant's behalf to run the store. If you are a shopper, the merchant you bought from is responsible for how your data is used; send requests about it to that merchant.",
        ],
      },
      {
        h: '3. Data we process',
        p: [
          'Merchant data: name, email, phone, password (stored only in hashed form), store details, billing and InstaPay payment references, VAT registration details where you provide them, plan and usage, support messages.',
          'Store data processed for merchants: products, orders, customer names, contact details, delivery addresses and order history, and anything else the merchant or its customers enter.',
          'Technical data: IP address, device and browser details, security and audit logs, error reports, and, in the merchant dashboard where analytics are enabled, usage events.',
          'We do not process card numbers: Ebda Store does not take payments for merchants.',
        ],
      },
      {
        h: '4. Why we use it, and on what basis',
        p: [
          'To provide the Service and perform our contract with you; to bill and prevent fraud; to secure the Service and fix errors; to send service notices (we send marketing only with consent); to comply with law; to improve the Service where analytics are enabled (with consent where required); and to respond to requests. Where the law requires consent we ask for it and you can withdraw it at any time.',
        ],
      },
      {
        h: '5. Service providers (sub-processors)',
        p:
          PRIVACY_STACK === 'cloudflare'
            ? POST_CUTOVER.en.providers
            : [
                'We use these providers to run the Service. Each processes data only on our instructions and under its own security and data terms: Cloudflare (website and API hosting, delivery, key-value storage, queues, file/image storage and email delivery: transactional and campaign email); Neon (database hosting, EU region); Sentry (error and performance monitoring, EU region); Inngest (background job processing); Google Gemini (Google; AI features: only the text you submit to an AI feature is sent); PostHog (EU cloud; product analytics in the merchant dashboard and, with your consent, the sign-up funnel); Meta (advertising measurement of our own ads, only with your consent); and OneSignal (United States; push notifications to the merchant dashboard installed as a home-screen app).',
                'When a merchant uses Ebda Chat, Meta Platforms (WhatsApp) also receives the messages and related data needed to send and receive them, as an independent controller under its own terms; see the Ebda Chat Privacy Policy (https://ebda.app/legal/whatsapp-privacy/).',
                'We may add or replace providers; the current list is maintained on this page. We do not sell personal data.',
              ],
      },
      {
        h: '6. Transfers abroad',
        p:
          PRIVACY_STACK === 'cloudflare'
            ? POST_CUTOVER.en.transfers
            : [
                'Some providers process data outside Egypt, including in the EU and the United States. Where the law requires, we rely on appropriate contractual and technical safeguards, and we choose EU regions for the database and monitoring services above. The recipients outside Egypt are the providers listed in section 5 (Cloudflare, Neon, Sentry, Inngest, Google, PostHog, Meta and OneSignal, in the EU, the United States or both) and, for Ebda Chat, Meta.',
              ],
      },
      {
        h: '7. Retention',
        p: [
          'We keep data for as long as the account is active and as needed for the purposes above. We keep a store and its data, including while it is suspended, until the merchant asks us to delete it or the account is closed; we then delete or anonymise them within 90 days, except records we must or reasonably need to keep (for example billing and tax records, audit and security logs, and material needed to prevent fraud or defend claims), which are kept only as long as necessary. Backups age out on their normal cycle.',
        ],
      },
      {
        h: '8. Your rights',
        p: [
          "Under Law No. 151 of 2020 you may ask to access, correct, update or delete your data, to restrict or object to processing, and to withdraw consent. Write to privacy@ebda.app, or follow the steps on the data deletion page (https://ebda.app/legal/data-deletion/); we may need to verify your identity, and will reply within a reasonable time. Requests about a shopper's data in a merchant's store are passed to that merchant. You may also complain to the Personal Data Protection Centre in Egypt.",
        ],
      },
      {
        h: '9. Security',
        p: [
          'We use measures such as encrypted connections, access controls, hashed passwords and monitoring. No system is perfectly secure and we cannot guarantee absolute security. If a breach affects your data we will notify you and the competent authority as the law requires; where we process data for a merchant we tell the merchant within 72 hours of becoming aware of it.',
        ],
      },
      {
        h: '10. Cookies',
        p: [
          'This marketing website and the sign-up pages use optional advertising and analytics cookies (Meta Pixel and PostHog) to measure where visitors come from and whether our ads work. They are loaded only after you accept the cookie banner, they are not loaded if you decline, and you can change your choice at any time from the "Cookie settings" link in the footer. If you accept, we also keep the campaign details of the link you arrived from (UTM parameters and the Meta click id) with your account when you sign up, and our server reports your sign-up, store creation and first payment to Meta using hashed contact details. The merchant dashboard and stores use cookies and similar storage that are necessary to sign in and operate, and optional analytics only where enabled and, where required, with your consent.',
        ],
      },
      {
        h: '11. Children',
        p: [
          'The Service is not directed to people under 18 and we do not knowingly collect their data. Contact us if you think a child has given us data.',
        ],
      },
      {
        h: '12. Changes and contact',
        p: [
          'We may update this policy and will post the new version here with its date; we will notify merchants of material changes. Questions, and our data protection officer: privacy@ebda.app (write "data protection officer" in the subject).',
        ],
      },
    ],
  },
  dataDeletion: DELETION_EN,
  refund: REFUND_EN,
  ...LEGAL_WA_EN,
  more: {
    h: 'More legal documents',
    links: [
      { slug: 'refund', label: 'Refund and cancellation policy' },
      { slug: 'legal/data-deletion', label: 'Data deletion and export' },
      { slug: 'legal/whatsapp-terms', label: 'Ebda Chat Terms of Service' },
      { slug: 'legal/whatsapp-privacy', label: 'Ebda Chat Privacy Policy' },
      { slug: 'legal/whatsapp-dpa', label: 'Ebda Chat Data Processing Agreement' },
    ],
  },
};
