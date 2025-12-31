/**
 * Template Validation System
 *
 * Ensures templates meet production requirements:
 * - All required slots are present
 * - All CSS theme variables are used
 * - No broken renders with missing data
 * - RTL support
 * - Accessibility baseline
 */

import type { TemplateId } from '@force/shared';
import type {
  TemplateProduct,
  TemplateCategory,
  StoreBranding,
  StoreContact,
  StoreSocials,
  NavItem,
} from './types';

/**
 * Required CSS variables that templates MUST use
 */
export const REQUIRED_CSS_VARIABLES = [
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius',
  '--destructive',
  '--destructive-foreground',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
] as const;

/**
 * Required template slots
 */
export const REQUIRED_SLOTS = [
  'Header',
  'Footer',
  'Hero',
  'ProductCard',
  'ProductGrid',
  'CategoryCard',
  'CategoryGrid',
  'AnnouncementBar',
] as const;

export type TemplateSlot = (typeof REQUIRED_SLOTS)[number];

/**
 * Template validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  slot: TemplateSlot;
  message: string;
  code: string;
}

export interface ValidationWarning {
  slot: TemplateSlot;
  message: string;
  code: string;
}

/**
 * Mock data for testing templates with missing data
 */
export const MOCK_DATA = {
  product: {
    id: 'test-product-1',
    name: 'Test Product',
    nameAr: 'منتج تجريبي',
    slug: 'test-product',
    price: 15000, // 15 KWD in fils
    compareAtPrice: 20000,
    images: [],
    rating: 4.5,
    reviewCount: 12,
    isNew: true,
    isFeatured: true,
    inStock: true,
  } satisfies TemplateProduct,

  productWithNoImage: {
    id: 'test-product-2',
    name: 'Product Without Image',
    nameAr: 'منتج بدون صورة',
    slug: 'product-no-image',
    price: 10000,
    images: [],
    inStock: true,
  } satisfies TemplateProduct,

  productOutOfStock: {
    id: 'test-product-3',
    name: 'Out of Stock Product',
    nameAr: 'منتج نفذ',
    slug: 'out-of-stock-product',
    price: 5000,
    images: [],
    inStock: false,
  } satisfies TemplateProduct,

  category: {
    id: 'test-category-1',
    name: 'Test Category',
    nameAr: 'فئة تجريبية',
    slug: 'test-category',
    productCount: 10,
  } satisfies TemplateCategory,

  categoryWithNoImage: {
    id: 'test-category-2',
    name: 'Category Without Image',
    nameAr: 'فئة بدون صورة',
    slug: 'category-no-image',
  } satisfies TemplateCategory,

  branding: {
    name: 'Test Store',
    nameAr: 'متجر تجريبي',
    description: 'A test store description',
    descriptionAr: 'وصف متجر تجريبي',
  } satisfies StoreBranding,

  brandingMinimal: {
    name: 'Test Store',
  } satisfies StoreBranding,

  contact: {
    email: 'test@example.com',
    phone: '+965 1234 5678',
    phoneAr: '+٩٦٥ ١٢٣٤ ٥٦٧٨',
    whatsapp: '+96512345678',
    address: 'Kuwait City, Kuwait',
    addressAr: 'مدينة الكويت، الكويت',
  } satisfies StoreContact,

  contactEmpty: {} satisfies StoreContact,

  socials: {
    instagram: 'https://instagram.com/test',
    twitter: 'https://twitter.com/test',
    facebook: 'https://facebook.com/test',
  } satisfies StoreSocials,

  socialsEmpty: {} satisfies StoreSocials,

  navigation: [
    { label: 'Home', labelAr: 'الرئيسية', href: '/' },
    { label: 'Products', labelAr: 'المنتجات', href: '/products' },
    {
      label: 'Categories',
      labelAr: 'الفئات',
      href: '/categories',
      children: [
        { label: 'Sub Category', labelAr: 'فئة فرعية', href: '/categories/sub' },
      ],
    },
    { label: 'About', labelAr: 'عنا', href: '/about' },
    { label: 'Contact', labelAr: 'اتصل بنا', href: '/contact' },
  ] satisfies NavItem[],

  navigationEmpty: [] satisfies NavItem[],
};

/**
 * Test scenarios for template validation
 */
export interface TestScenario {
  name: string;
  description: string;
  props: Record<string, unknown>;
}

/**
 * Generate test scenarios for each slot
 */
export function getTestScenarios(slot: TemplateSlot): TestScenario[] {
  switch (slot) {
    case 'ProductCard':
      return [
        {
          name: 'Full product data',
          description: 'Product with all fields populated',
          props: { product: MOCK_DATA.product, isRtl: false, currency: 'KWD' },
        },
        {
          name: 'RTL mode',
          description: 'Product in RTL/Arabic mode',
          props: { product: MOCK_DATA.product, isRtl: true, currency: 'KWD' },
        },
        {
          name: 'No image',
          description: 'Product without an image',
          props: { product: MOCK_DATA.productWithNoImage, isRtl: false, currency: 'KWD' },
        },
        {
          name: 'Out of stock',
          description: 'Product that is out of stock',
          props: { product: MOCK_DATA.productOutOfStock, isRtl: false, currency: 'KWD' },
        },
      ];

    case 'ProductGrid':
      return [
        {
          name: 'Multiple products',
          description: 'Grid with multiple products',
          props: {
            products: [MOCK_DATA.product, MOCK_DATA.productWithNoImage, MOCK_DATA.productOutOfStock],
            isRtl: false,
            currency: 'KWD',
            columns: 4,
          },
        },
        {
          name: 'Empty products',
          description: 'Grid with no products',
          props: { products: [], isRtl: false, currency: 'KWD', columns: 4 },
        },
        {
          name: 'RTL mode',
          description: 'Grid in RTL/Arabic mode',
          props: { products: [MOCK_DATA.product], isRtl: true, currency: 'KWD', columns: 4 },
        },
      ];

    case 'Header':
      return [
        {
          name: 'Full data',
          description: 'Header with all data populated',
          props: {
            branding: MOCK_DATA.branding,
            navigation: MOCK_DATA.navigation,
            isRtl: false,
            cartItemCount: 3,
            isLoggedIn: true,
          },
        },
        {
          name: 'Minimal branding',
          description: 'Header with minimal store branding',
          props: {
            branding: MOCK_DATA.brandingMinimal,
            navigation: MOCK_DATA.navigationEmpty,
            isRtl: false,
          },
        },
        {
          name: 'RTL mode',
          description: 'Header in RTL/Arabic mode',
          props: {
            branding: MOCK_DATA.branding,
            navigation: MOCK_DATA.navigation,
            isRtl: true,
          },
        },
      ];

    case 'Footer':
      return [
        {
          name: 'Full data',
          description: 'Footer with all data populated',
          props: {
            branding: MOCK_DATA.branding,
            contact: MOCK_DATA.contact,
            socials: MOCK_DATA.socials,
            navigation: MOCK_DATA.navigation,
            isRtl: false,
          },
        },
        {
          name: 'Empty contact and socials',
          description: 'Footer with no contact info or social links',
          props: {
            branding: MOCK_DATA.brandingMinimal,
            contact: MOCK_DATA.contactEmpty,
            socials: MOCK_DATA.socialsEmpty,
            isRtl: false,
          },
        },
        {
          name: 'RTL mode',
          description: 'Footer in RTL/Arabic mode',
          props: {
            branding: MOCK_DATA.branding,
            contact: MOCK_DATA.contact,
            socials: MOCK_DATA.socials,
            isRtl: true,
          },
        },
      ];

    case 'Hero':
      return [
        {
          name: 'Full data',
          description: 'Hero with all data populated',
          props: {
            title: 'Welcome to Our Store',
            titleAr: 'مرحبا بكم في متجرنا',
            subtitle: 'Discover amazing products',
            subtitleAr: 'اكتشف منتجات مذهلة',
            image: 'https://picsum.photos/1200/600',
            ctaText: 'Shop Now',
            ctaTextAr: 'تسوق الآن',
            ctaLink: '/products',
            isRtl: false,
          },
        },
        {
          name: 'Minimal data',
          description: 'Hero with only title',
          props: { title: 'Welcome', isRtl: false },
        },
        {
          name: 'RTL mode',
          description: 'Hero in RTL/Arabic mode',
          props: {
            title: 'Welcome',
            titleAr: 'مرحبا',
            isRtl: true,
          },
        },
      ];

    case 'CategoryCard':
      return [
        {
          name: 'Full data',
          description: 'Category with all data populated',
          props: { category: MOCK_DATA.category, isRtl: false },
        },
        {
          name: 'No image',
          description: 'Category without an image',
          props: { category: MOCK_DATA.categoryWithNoImage, isRtl: false },
        },
        {
          name: 'RTL mode',
          description: 'Category in RTL/Arabic mode',
          props: { category: MOCK_DATA.category, isRtl: true },
        },
      ];

    case 'CategoryGrid':
      return [
        {
          name: 'Multiple categories',
          description: 'Grid with multiple categories',
          props: {
            categories: [MOCK_DATA.category, MOCK_DATA.categoryWithNoImage],
            isRtl: false,
          },
        },
        {
          name: 'Empty categories',
          description: 'Grid with no categories',
          props: { categories: [], isRtl: false },
        },
      ];

    case 'AnnouncementBar':
      return [
        {
          name: 'Full data',
          description: 'Announcement with all data',
          props: {
            text: 'Free shipping on orders over 20 KWD!',
            textAr: 'شحن مجاني للطلبات فوق 20 دينار!',
            link: '/shipping',
            linkText: 'Learn more',
            linkTextAr: 'اعرف المزيد',
            bgColor: 'hsl(var(--primary))',
            textColor: 'hsl(var(--primary-foreground))',
            dismissible: true,
            isRtl: false,
          },
        },
        {
          name: 'Text only',
          description: 'Announcement with just text',
          props: { text: 'Welcome!', isRtl: false },
        },
        {
          name: 'RTL mode',
          description: 'Announcement in RTL/Arabic mode',
          props: {
            text: 'Welcome',
            textAr: 'مرحبا',
            isRtl: true,
          },
        },
      ];

    default:
      return [];
  }
}

/**
 * Check if a template is registered
 */
export function isTemplateRegistered(templateId: string): templateId is TemplateId {
  return ['modern', 'classic', 'minimal', 'bold', 'elegant'].includes(templateId);
}

/**
 * Log template validation results
 */
export function logValidationResult(templateId: TemplateId, result: ValidationResult): void {
  if (process.env.NODE_ENV !== 'development') return;

  console.group(`Template Validation: ${templateId}`);

  if (result.isValid) {
    console.log('✅ Template is valid');
  } else {
    console.error('❌ Template has errors:');
    result.errors.forEach((error) => {
      console.error(`  [${error.slot}] ${error.code}: ${error.message}`);
    });
  }

  if (result.warnings.length > 0) {
    console.warn('⚠️ Warnings:');
    result.warnings.forEach((warning) => {
      console.warn(`  [${warning.slot}] ${warning.code}: ${warning.message}`);
    });
  }

  console.groupEnd();
}
