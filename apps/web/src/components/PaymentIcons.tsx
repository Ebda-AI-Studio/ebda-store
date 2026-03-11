'use client';

interface PaymentIconProps {
  className?: string;
}

export function KNETIcon({ className = 'h-5 w-5' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-12 items-center justify-center rounded bg-blue-600">
      <svg
        className={`${className} text-white`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
        />
      </svg>
    </div>
  );
}

export function VisaIcon({ className = 'h-4 w-4' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-10 items-center justify-center rounded bg-gradient-to-br from-blue-800 to-blue-600">
      <svg className={`${className} text-white`} viewBox="0 0 24 24" fill="currentColor">
        <path d="M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102h2.037zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.013 1.08.963 1.683 1.7 2.042.757.367 1.011.603 1.007.931-.005.503-.603.726-1.161.734-.976.015-1.541-.264-1.994-.474l-.352 1.645c.454.208 1.29.39 2.156.398 2.037 0 3.37-1.006 3.378-2.568zm5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488l.233 1.12zm-2.166-2.656l1.02-2.815.588 2.815h-1.608zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496h1.935z" />
      </svg>
    </div>
  );
}

export function MastercardIcon({ className = 'h-5 w-5' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-10 items-center justify-center rounded bg-gradient-to-br from-red-500 to-orange-500">
      <svg
        className={`${className} text-white`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
        />
      </svg>
    </div>
  );
}

export function CreditCardIcons() {
  return (
    <div className="flex gap-1">
      <VisaIcon />
      <MastercardIcon />
    </div>
  );
}

export function ApplePayIcon({ className = 'h-5 w-5' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-12 items-center justify-center rounded bg-black">
      <svg className={`${className} text-white`} viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    </div>
  );
}

export function GooglePayIcon({ className = 'h-5 w-5' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-12 items-center justify-center rounded bg-white border border-border">
      <svg className={`${className}`} viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
          fill="#4285F4"
        />
      </svg>
    </div>
  );
}

export function CashOnDeliveryIcon({ className = 'h-5 w-5' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-12 items-center justify-center rounded bg-green-600">
      <svg
        className={`${className} text-white`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"
        />
      </svg>
    </div>
  );
}

export function BankTransferIcon({ className = 'h-5 w-5' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-12 items-center justify-center rounded bg-purple-600">
      <svg
        className={`${className} text-white`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z"
        />
      </svg>
    </div>
  );
}

export function DefaultPaymentIcon({ className = 'h-5 w-5' }: PaymentIconProps) {
  return (
    <div className="flex h-8 w-12 items-center justify-center rounded bg-gray-500">
      <svg
        className={`${className} text-white`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
        />
      </svg>
    </div>
  );
}

// Payment provider ID to icon mapping
export function getPaymentIcon(providerId: string): React.ReactNode {
  const iconMap: Record<string, React.ReactNode> = {
    knet: <KNETIcon />,
    tap: <CreditCardIcons />,
    credit_card: <CreditCardIcons />,
    card: <CreditCardIcons />,
    visa: <VisaIcon />,
    mastercard: <MastercardIcon />,
    apple_pay: <ApplePayIcon />,
    applepay: <ApplePayIcon />,
    google_pay: <GooglePayIcon />,
    googlepay: <GooglePayIcon />,
    cod: <CashOnDeliveryIcon />,
    cash_on_delivery: <CashOnDeliveryIcon />,
    bank_transfer: <BankTransferIcon />,
    bank: <BankTransferIcon />,
  };

  return iconMap[providerId.toLowerCase()] || <DefaultPaymentIcon />;
}

// Payment provider display info
export interface PaymentProviderInfo {
  id: string;
  name: string;
  nameAr?: string;
  description: string;
  descriptionAr?: string;
  logo?: string;
  icon: React.ReactNode;
}

// Default payment providers with display info
export const DEFAULT_PAYMENT_PROVIDERS: PaymentProviderInfo[] = [
  {
    id: 'knet',
    name: 'KNET',
    description: 'Pay with your local bank card',
    descriptionAr: 'ادفع ببطاقتك البنكية المحلية',
    icon: <KNETIcon />,
  },
  {
    id: 'tap',
    name: 'Credit / Debit Card',
    nameAr: 'بطاقة ائتمان / خصم',
    description: 'Visa, Mastercard, American Express',
    descriptionAr: 'فيزا، ماستركارد، أمريكان إكسبريس',
    icon: <CreditCardIcons />,
  },
  {
    id: 'apple_pay',
    name: 'Apple Pay',
    description: 'Fast and secure payment',
    descriptionAr: 'دفع سريع وآمن',
    icon: <ApplePayIcon />,
  },
  {
    id: 'cod',
    name: 'Cash on Delivery',
    nameAr: 'الدفع عند الاستلام',
    description: 'Pay when you receive your order',
    descriptionAr: 'ادفع عند استلام طلبك',
    icon: <CashOnDeliveryIcon />,
  },
];
