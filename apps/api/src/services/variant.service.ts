import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

interface CreateOptionInput {
  name: string;
  nameAr?: string;
  values: Array<{ value: string; valueAr?: string }>;
}

interface CreateVariantInput {
  sku?: string;
  barcode?: string;
  price?: number;
  compareAtPrice?: number;
  costPrice?: number;
  inventory?: number;
  weight?: number;
  imageUrl?: string;
  optionValueIds: string[];
}

interface UpdateVariantInput {
  sku?: string | null;
  barcode?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  inventory?: number;
  weight?: number | null;
  imageUrl?: string | null;
  isActive?: boolean;
}

export class VariantService {
  /**
   * Get product with options and variants
   */
  static async getProductVariants(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: {
        options: {
          orderBy: { position: 'asc' },
          include: {
            values: {
              orderBy: { position: 'asc' },
            },
          },
        },
        variants: {
          orderBy: { position: 'asc' },
          include: {
            options: {
              include: {
                value: {
                  include: {
                    option: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    return {
      product: {
        id: product.id,
        name: product.name,
        nameAr: product.nameAr,
        price: product.price,
        hasVariants: product.hasVariants,
        inventory: product.inventory,
      },
      options: product.options,
      variants: product.variants.map(v => ({
        ...v,
        optionValues: v.options.map(o => ({
          optionId: o.value.option.id,
          optionName: o.value.option.name,
          optionNameAr: o.value.option.nameAr,
          valueId: o.value.id,
          value: o.value.value,
          valueAr: o.value.valueAr,
        })),
      })),
    };
  }

  /**
   * Add option to a product
   */
  static async addOption(storeId: string, productId: string, input: CreateOptionInput) {
    // Verify product exists
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { options: true },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Check max options (typically 3)
    if (product.options.length >= 3) {
      throw new AppError(400, 'MAX_OPTIONS_REACHED', 'Products can have a maximum of 3 options');
    }

    // Check for duplicate option name
    const existingOption = await prisma.productOption.findFirst({
      where: { productId, name: input.name },
    });

    if (existingOption) {
      throw new AppError(400, 'DUPLICATE_OPTION', `Option "${input.name}" already exists`);
    }

    // Create option with values
    const option = await prisma.productOption.create({
      data: {
        productId,
        name: input.name,
        nameAr: input.nameAr,
        position: product.options.length,
        values: {
          create: input.values.map((v, index) => ({
            value: v.value,
            valueAr: v.valueAr,
            position: index,
          })),
        },
      },
      include: {
        values: { orderBy: { position: 'asc' } },
      },
    });

    // Mark product as having variants if it's the first option
    if (!product.hasVariants) {
      await prisma.product.update({
        where: { id: productId },
        data: { hasVariants: true },
      });
    }

    return option;
  }

  /**
   * Update option
   */
  static async updateOption(
    storeId: string,
    productId: string,
    optionId: string,
    input: { name?: string; nameAr?: string }
  ) {
    const option = await prisma.productOption.findFirst({
      where: {
        id: optionId,
        product: { id: productId, storeId, deletedAt: null },
      },
    });

    if (!option) {
      throw new AppError(404, 'NOT_FOUND', 'Option not found');
    }

    return prisma.productOption.update({
      where: { id: optionId },
      data: {
        name: input.name,
        nameAr: input.nameAr,
      },
      include: {
        values: { orderBy: { position: 'asc' } },
      },
    });
  }

  /**
   * Delete option (and all associated variants)
   */
  static async deleteOption(storeId: string, productId: string, optionId: string) {
    const option = await prisma.productOption.findFirst({
      where: {
        id: optionId,
        product: { id: productId, storeId, deletedAt: null },
      },
      include: { product: { include: { options: true } } },
    });

    if (!option) {
      throw new AppError(404, 'NOT_FOUND', 'Option not found');
    }

    // Delete option (cascade will delete values and variant options)
    await prisma.productOption.delete({ where: { id: optionId } });

    // Delete all variants since they depend on options
    await prisma.productVariant.deleteMany({ where: { productId } });

    // If no more options, mark product as not having variants
    if (option.product.options.length <= 1) {
      await prisma.product.update({
        where: { id: productId },
        data: { hasVariants: false },
      });
    }
  }

  /**
   * Add value to an option
   */
  static async addOptionValue(
    storeId: string,
    productId: string,
    optionId: string,
    input: { value: string; valueAr?: string }
  ) {
    const option = await prisma.productOption.findFirst({
      where: {
        id: optionId,
        product: { id: productId, storeId, deletedAt: null },
      },
      include: { values: true },
    });

    if (!option) {
      throw new AppError(404, 'NOT_FOUND', 'Option not found');
    }

    // Check for duplicate value
    const existingValue = option.values.find(v => v.value === input.value);
    if (existingValue) {
      throw new AppError(400, 'DUPLICATE_VALUE', `Value "${input.value}" already exists`);
    }

    return prisma.productOptionValue.create({
      data: {
        optionId,
        value: input.value,
        valueAr: input.valueAr,
        position: option.values.length,
      },
    });
  }

  /**
   * Update option value
   */
  static async updateOptionValue(
    storeId: string,
    productId: string,
    valueId: string,
    input: { value?: string; valueAr?: string }
  ) {
    const optionValue = await prisma.productOptionValue.findFirst({
      where: {
        id: valueId,
        option: {
          product: { id: productId, storeId, deletedAt: null },
        },
      },
    });

    if (!optionValue) {
      throw new AppError(404, 'NOT_FOUND', 'Option value not found');
    }

    return prisma.productOptionValue.update({
      where: { id: valueId },
      data: {
        value: input.value,
        valueAr: input.valueAr,
      },
    });
  }

  /**
   * Delete option value
   */
  static async deleteOptionValue(storeId: string, productId: string, valueId: string) {
    const optionValue = await prisma.productOptionValue.findFirst({
      where: {
        id: valueId,
        option: {
          product: { id: productId, storeId, deletedAt: null },
        },
      },
      include: { option: { include: { values: true } } },
    });

    if (!optionValue) {
      throw new AppError(404, 'NOT_FOUND', 'Option value not found');
    }

    // Prevent deleting last value
    if (optionValue.option.values.length <= 1) {
      throw new AppError(
        400,
        'LAST_VALUE',
        'Cannot delete the last value. Delete the option instead.'
      );
    }

    // Delete any variants using this value
    const variantsWithValue = await prisma.productVariant.findMany({
      where: {
        options: { some: { valueId } },
      },
    });

    if (variantsWithValue.length > 0) {
      await prisma.productVariant.deleteMany({
        where: { id: { in: variantsWithValue.map(v => v.id) } },
      });
    }

    await prisma.productOptionValue.delete({ where: { id: valueId } });
  }

  /**
   * Create a new variant
   */
  static async createVariant(storeId: string, productId: string, input: CreateVariantInput) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { options: { include: { values: true } } },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Validate option values
    const allValueIds = product.options.flatMap(o => o.values.map(v => v.id));
    for (const valueId of input.optionValueIds) {
      if (!allValueIds.includes(valueId)) {
        throw new AppError(400, 'INVALID_OPTION_VALUE', `Invalid option value ID: ${valueId}`);
      }
    }

    // Check if each option has exactly one value
    for (const option of product.options) {
      const matchingValues = input.optionValueIds.filter(id =>
        option.values.some(v => v.id === id)
      );
      if (matchingValues.length !== 1) {
        throw new AppError(400, 'INVALID_VARIANT', `Each option must have exactly one value`);
      }
    }

    // Check for duplicate variant
    const existingVariants = await prisma.productVariant.findMany({
      where: { productId },
      include: { options: true },
    });

    for (const existing of existingVariants) {
      const existingValueIds = existing.options.map(o => o.valueId).sort();
      const newValueIds = input.optionValueIds.sort();
      if (JSON.stringify(existingValueIds) === JSON.stringify(newValueIds)) {
        throw new AppError(400, 'DUPLICATE_VARIANT', 'This variant combination already exists');
      }
    }

    // Generate title from option values
    const optionValues = await prisma.productOptionValue.findMany({
      where: { id: { in: input.optionValueIds } },
      include: { option: true },
      orderBy: { option: { position: 'asc' } },
    });

    const title = optionValues.map(v => v.value).join(' / ');
    const titleAr =
      optionValues
        .filter(v => v.valueAr)
        .map(v => v.valueAr)
        .join(' / ') || null;

    // Create variant
    const variant = await prisma.productVariant.create({
      data: {
        productId,
        title,
        titleAr,
        sku: input.sku,
        barcode: input.barcode,
        price: input.price,
        compareAtPrice: input.compareAtPrice,
        costPrice: input.costPrice,
        inventory: input.inventory || 0,
        weight: input.weight,
        imageUrl: input.imageUrl,
        position: existingVariants.length,
        options: {
          create: input.optionValueIds.map(valueId => ({ valueId })),
        },
      },
      include: {
        options: {
          include: {
            value: {
              include: { option: true },
            },
          },
        },
      },
    });

    return {
      ...variant,
      optionValues: variant.options.map(o => ({
        optionId: o.value.option.id,
        optionName: o.value.option.name,
        optionNameAr: o.value.option.nameAr,
        valueId: o.value.id,
        value: o.value.value,
        valueAr: o.value.valueAr,
      })),
    };
  }

  /**
   * Update a variant
   */
  static async updateVariant(
    storeId: string,
    productId: string,
    variantId: string,
    input: UpdateVariantInput
  ) {
    const variant = await prisma.productVariant.findFirst({
      where: {
        id: variantId,
        product: { id: productId, storeId, deletedAt: null },
      },
    });

    if (!variant) {
      throw new AppError(404, 'NOT_FOUND', 'Variant not found');
    }

    return prisma.productVariant.update({
      where: { id: variantId },
      data: input,
      include: {
        options: {
          include: {
            value: {
              include: { option: true },
            },
          },
        },
      },
    });
  }

  /**
   * Delete a variant
   */
  static async deleteVariant(storeId: string, productId: string, variantId: string) {
    const variant = await prisma.productVariant.findFirst({
      where: {
        id: variantId,
        product: { id: productId, storeId, deletedAt: null },
      },
    });

    if (!variant) {
      throw new AppError(404, 'NOT_FOUND', 'Variant not found');
    }

    await prisma.productVariant.delete({ where: { id: variantId } });
  }

  /**
   * Generate all possible variants from current options
   */
  static async generateVariants(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: {
        options: {
          orderBy: { position: 'asc' },
          include: {
            values: { orderBy: { position: 'asc' } },
          },
        },
        variants: { include: { options: true } },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    if (product.options.length === 0) {
      throw new AppError(400, 'NO_OPTIONS', 'Product has no options defined');
    }

    // Generate all combinations
    const combinations = this.generateCombinations(product.options.map(o => o.values));

    // Filter out existing variants
    const existingCombinations = new Set(
      product.variants.map(v =>
        v.options
          .map(o => o.valueId)
          .sort()
          .join(',')
      )
    );

    const newCombinations = combinations.filter(
      combo =>
        !existingCombinations.has(
          combo
            .map(v => v.id)
            .sort()
            .join(',')
        )
    );

    // Create new variants
    const created: string[] = [];
    for (const combo of newCombinations) {
      const title = combo.map(v => v.value).join(' / ');
      const titleAr =
        combo
          .filter(v => v.valueAr)
          .map(v => v.valueAr)
          .join(' / ') || null;

      const variant = await prisma.productVariant.create({
        data: {
          productId,
          title,
          titleAr,
          inventory: 0,
          position: product.variants.length + created.length,
          options: {
            create: combo.map(value => ({ valueId: value.id })),
          },
        },
      });

      created.push(variant.id);
    }

    return {
      created: created.length,
      existing: product.variants.length,
      total: product.variants.length + created.length,
    };
  }

  /**
   * Bulk update variant inventory
   */
  static async bulkUpdateInventory(
    storeId: string,
    productId: string,
    updates: Array<{ variantId: string; inventory: number }>
  ) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const results = await Promise.all(
      updates.map(async update => {
        try {
          await prisma.productVariant.update({
            where: { id: update.variantId },
            data: { inventory: update.inventory },
          });
          return { variantId: update.variantId, success: true };
        } catch {
          return { variantId: update.variantId, success: false };
        }
      })
    );

    return {
      updated: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    };
  }

  /**
   * Reorder options
   */
  static async reorderOptions(storeId: string, productId: string, optionIds: string[]) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { options: true },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    await Promise.all(
      optionIds.map((optionId, index) =>
        prisma.productOption.update({
          where: { id: optionId },
          data: { position: index },
        })
      )
    );
  }

  /**
   * Reorder variants
   */
  static async reorderVariants(storeId: string, productId: string, variantIds: string[]) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    await Promise.all(
      variantIds.map((variantId, index) =>
        prisma.productVariant.update({
          where: { id: variantId },
          data: { position: index },
        })
      )
    );
  }

  // Helper to generate all combinations
  private static generateCombinations<T>(arrays: T[][]): T[][] {
    if (arrays.length === 0) return [[]];
    if (arrays.length === 1) return arrays[0].map(item => [item]);

    const result: T[][] = [];
    const restCombinations = this.generateCombinations(arrays.slice(1));

    for (const item of arrays[0]) {
      for (const rest of restCombinations) {
        result.push([item, ...rest]);
      }
    }

    return result;
  }
}
