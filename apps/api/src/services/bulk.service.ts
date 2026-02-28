import { prisma, Prisma, ProductStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';

interface ProductImportRow {
  name: string;
  nameAr?: string;
  slug?: string;
  description?: string;
  descriptionAr?: string;
  price: number; // In fils
  compareAtPrice?: number;
  costPrice?: number;
  sku?: string;
  barcode?: string;
  inventory?: number;
  lowStockThreshold?: number;
  trackInventory?: boolean;
  weight?: number;
  status?: ProductStatus;
  featured?: boolean;
  isNew?: boolean;
  categories?: string; // Comma-separated category names
  tags?: string; // Comma-separated tag names
  images?: string; // Comma-separated image URLs
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
}

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
}

interface ExportOptions {
  status?: ProductStatus;
  category?: string;
  search?: string;
  includeDeleted?: boolean;
}

export class BulkService {
  /**
   * Export products to CSV format
   */
  static async exportProducts(storeId: string, options?: ExportOptions): Promise<string> {
    const where: Prisma.ProductWhereInput = {
      storeId,
    };

    if (options?.status) {
      where.status = options.status;
    }

    if (!options?.includeDeleted) {
      where.deletedAt = null;
    }

    if (options?.search) {
      where.OR = [
        { name: { contains: options.search, mode: 'insensitive' } },
        { nameAr: { contains: options.search, mode: 'insensitive' } },
        { sku: { contains: options.search, mode: 'insensitive' } },
      ];
    }

    const products = await prisma.product.findMany({
      where,
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // CSV headers
    const headers = [
      'id',
      'name',
      'nameAr',
      'slug',
      'description',
      'descriptionAr',
      'price',
      'compareAtPrice',
      'costPrice',
      'sku',
      'barcode',
      'inventory',
      'lowStockThreshold',
      'trackInventory',
      'weight',
      'status',
      'featured',
      'isNew',
      'categories',
      'tags',
      'images',
      'metaTitle',
      'metaTitleAr',
      'metaDescription',
      'metaDescriptionAr',
    ];

    // Build CSV rows
    const rows = products.map(product => {
      const categories = product.categories.map(c => c.category.name).join(',');
      const tags = product.tags.map(t => t.tag.name).join(',');
      const images = product.images.map(i => i.url).join(',');

      return [
        product.id,
        this.escapeCSV(product.name),
        this.escapeCSV(product.nameAr || ''),
        product.slug,
        this.escapeCSV(product.description || ''),
        this.escapeCSV(product.descriptionAr || ''),
        product.price,
        product.compareAtPrice || '',
        product.costPrice || '',
        product.sku || '',
        product.barcode || '',
        product.inventory,
        product.lowStockThreshold,
        product.trackInventory,
        product.weight || '',
        product.status,
        product.featured,
        product.isNew,
        this.escapeCSV(categories),
        this.escapeCSV(tags),
        this.escapeCSV(images),
        this.escapeCSV(product.metaTitle || ''),
        this.escapeCSV(product.metaTitleAr || ''),
        this.escapeCSV(product.metaDescription || ''),
        this.escapeCSV(product.metaDescriptionAr || ''),
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Get CSV template for product import
   */
  static getImportTemplate(): string {
    const headers = [
      'name',
      'nameAr',
      'slug',
      'description',
      'descriptionAr',
      'price',
      'compareAtPrice',
      'costPrice',
      'sku',
      'barcode',
      'inventory',
      'lowStockThreshold',
      'trackInventory',
      'weight',
      'status',
      'featured',
      'isNew',
      'categories',
      'tags',
      'images',
      'metaTitle',
      'metaTitleAr',
      'metaDescription',
      'metaDescriptionAr',
    ];

    // Example row
    const exampleRow = [
      'Product Name',
      'اسم المنتج',
      'product-slug',
      'Product description goes here',
      'وصف المنتج هنا',
      '5000', // 5 KWD in fils
      '7500', // Compare at price
      '3000', // Cost price
      'SKU-001',
      '1234567890123',
      '100',
      '10',
      'true',
      '0.5',
      'active',
      'false',
      'true',
      '"Category 1,Category 2"',
      '"tag1,tag2"',
      '"https://example.com/image1.jpg,https://example.com/image2.jpg"',
      'SEO Title',
      'عنوان SEO',
      'SEO Description',
      'وصف SEO',
    ].join(',');

    return `${headers.join(',')}\n${exampleRow}`;
  }

  /**
   * Import products from CSV data
   */
  static async importProducts(
    storeId: string,
    csvData: string,
    options: { updateExisting: boolean } = { updateExisting: true },
    userId?: string
  ): Promise<ImportResult> {
    const result: ImportResult = {
      total: 0,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    };

    const lines = csvData.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      throw new AppError(
        400,
        'INVALID_CSV',
        'CSV file must have a header row and at least one data row'
      );
    }

    const headers = this.parseCSVLine(lines[0]);
    const dataRows = lines.slice(1);
    result.total = dataRows.length;

    // Get or create categories and tags cache
    const categoryCache = new Map<string, string>();
    const tagCache = new Map<string, string>();

    for (let i = 0; i < dataRows.length; i++) {
      const rowIndex = i + 2; // 1-based, accounting for header
      try {
        const values = this.parseCSVLine(dataRows[i]);
        const row = this.mapRowToObject(headers, values);

        // Validate required fields
        if (!row.name) {
          result.failed++;
          result.errors.push({ row: rowIndex, error: 'Name is required' });
          continue;
        }

        if (row.price === undefined || isNaN(Number(row.price))) {
          result.failed++;
          result.errors.push({ row: rowIndex, error: 'Price is required and must be a number' });
          continue;
        }

        // Generate slug if not provided
        const slug = row.slug || this.generateSlug(row.name);

        // Check if product exists (by SKU or slug)
        let existingProduct = null;
        if (row.sku) {
          existingProduct = await prisma.product.findFirst({
            where: { storeId, sku: row.sku, deletedAt: null },
          });
        }
        if (!existingProduct) {
          existingProduct = await prisma.product.findFirst({
            where: { storeId, slug, deletedAt: null },
          });
        }

        // Prepare product data
        const productData: Prisma.ProductCreateInput = {
          store: { connect: { id: storeId } },
          name: row.name,
          nameAr: row.nameAr || null,
          slug: await this.ensureUniqueSlug(storeId, slug, existingProduct?.id),
          description: row.description || null,
          descriptionAr: row.descriptionAr || null,
          price: parseInt(String(row.price)),
          compareAtPrice: row.compareAtPrice ? parseInt(String(row.compareAtPrice)) : null,
          costPrice: row.costPrice ? parseInt(String(row.costPrice)) : null,
          sku: row.sku || null,
          barcode: row.barcode || null,
          inventory: row.inventory ? parseInt(String(row.inventory)) : 0,
          lowStockThreshold: row.lowStockThreshold ? parseInt(String(row.lowStockThreshold)) : 5,
          trackInventory:
            row.trackInventory !== undefined ? String(row.trackInventory) === 'true' : true,
          weight: row.weight ? parseFloat(String(row.weight)) : null,
          status: (row.status as ProductStatus) || 'draft',
          featured: row.featured !== undefined ? String(row.featured) === 'true' : false,
          isNew: row.isNew !== undefined ? String(row.isNew) === 'true' : false,
          metaTitle: row.metaTitle || null,
          metaTitleAr: row.metaTitleAr || null,
          metaDescription: row.metaDescription || null,
          metaDescriptionAr: row.metaDescriptionAr || null,
        };

        if (existingProduct && options.updateExisting) {
          // Update existing product - exclude store field from update data
          const { store: _store, ...updateData } = productData;
          await prisma.product.update({
            where: { id: existingProduct.id },
            data: updateData as Prisma.ProductUpdateInput,
          });

          // Update categories if provided
          if (row.categories) {
            await this.updateProductCategories(
              existingProduct.id,
              storeId,
              row.categories,
              categoryCache
            );
          }

          // Update tags if provided
          if (row.tags) {
            await this.updateProductTags(existingProduct.id, storeId, row.tags, tagCache);
          }

          // Update images if provided
          if (row.images) {
            await this.updateProductImages(existingProduct.id, row.images);
          }

          result.updated++;
        } else if (!existingProduct) {
          // Create new product
          const product = await prisma.product.create({
            data: productData,
          });

          // Add categories
          if (row.categories) {
            await this.updateProductCategories(product.id, storeId, row.categories, categoryCache);
          }

          // Add tags
          if (row.tags) {
            await this.updateProductTags(product.id, storeId, row.tags, tagCache);
          }

          // Add images
          if (row.images) {
            await this.updateProductImages(product.id, row.images);
          }

          // Create inventory history entry
          if (product.inventory > 0) {
            await prisma.inventoryHistory.create({
              data: {
                productId: product.id,
                storeId,
                type: 'initial',
                quantity: product.inventory,
                previousStock: 0,
                newStock: product.inventory,
                reason: 'Initial stock from bulk import',
                createdBy: userId,
              },
            });
          }

          result.created++;
        } else {
          // Product exists but updateExisting is false
          result.failed++;
          result.errors.push({
            row: rowIndex,
            error: `Product with SKU "${row.sku}" or slug "${slug}" already exists`,
          });
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          row: rowIndex,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return result;
  }

  /**
   * Bulk delete products
   */
  static async bulkDelete(
    storeId: string,
    productIds: string[],
    permanent: boolean = false
  ): Promise<{ deleted: number; failed: number; errors: string[] }> {
    if (productIds.length === 0) {
      return { deleted: 0, failed: 0, errors: [] };
    }

    if (permanent) {
      // Hard delete: remove rows that belong to this store in one query
      const result = await prisma.product.deleteMany({
        where: { id: { in: productIds }, storeId },
      });
      return { deleted: result.count, failed: productIds.length - result.count, errors: [] };
    }

    // Soft delete: stamp deletedAt on all matching rows in one query
    const result = await prisma.product.updateMany({
      where: { id: { in: productIds }, storeId },
      data: { deletedAt: new Date() },
    });

    return { deleted: result.count, failed: productIds.length - result.count, errors: [] };
  }

  /**
   * Bulk update product status
   */
  static async bulkUpdateStatus(
    storeId: string,
    productIds: string[],
    status: ProductStatus
  ): Promise<{ updated: number; failed: number; errors: string[] }> {
    if (productIds.length === 0) {
      return { updated: 0, failed: 0, errors: [] };
    }

    // Update all matching rows for this store in one query
    const result = await prisma.product.updateMany({
      where: { id: { in: productIds }, storeId, deletedAt: null },
      data: { status },
    });

    return { updated: result.count, failed: productIds.length - result.count, errors: [] };
  }

  // Helper methods

  private static escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private static parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"' && !inQuotes) {
        inQuotes = true;
      } else if (char === '"' && inQuotes) {
        if (nextChar === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = false;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  }

  private static mapRowToObject(headers: string[], values: string[]): ProductImportRow {
    const obj: Record<string, string | undefined> = {};
    headers.forEach((header, index) => {
      obj[header.trim()] = values[index]?.trim() || undefined;
    });
    return obj as unknown as ProductImportRow;
  }

  private static generateSlug(name: string): string {
    let slug = name
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\s-]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/(^-|-$)/g, '');

    if (!slug) {
      slug = `product-${Date.now()}`;
    }

    return slug;
  }

  private static async ensureUniqueSlug(
    storeId: string,
    slug: string,
    excludeId?: string
  ): Promise<string> {
    let uniqueSlug = slug;
    let counter = 1;
    let isUnique = false;

    while (!isUnique) {
      const existing = await prisma.product.findFirst({
        where: {
          storeId,
          slug: uniqueSlug,
          deletedAt: null,
          ...(excludeId && { id: { not: excludeId } }),
        },
      });

      if (!existing) {
        isUnique = true;
      } else {
        uniqueSlug = `${slug}-${counter}`;
        counter++;
      }
    }

    return uniqueSlug;
  }

  private static async updateProductCategories(
    productId: string,
    storeId: string,
    categoriesStr: string,
    cache: Map<string, string>
  ): Promise<void> {
    const categoryNames = categoriesStr
      .split(',')
      .map(c => c.trim())
      .filter(Boolean);

    // Delete existing categories
    await prisma.productCategory.deleteMany({ where: { productId } });

    for (const name of categoryNames) {
      let categoryId = cache.get(name);

      if (!categoryId) {
        // Find or create category
        let category = await prisma.category.findFirst({
          where: { storeId, name },
        });

        if (!category) {
          const slug = this.generateSlug(name);
          category = await prisma.category.create({
            data: {
              storeId,
              name,
              slug: await this.ensureUniqueCategorySlug(storeId, slug),
            },
          });
        }

        categoryId = category.id;
        cache.set(name, categoryId);
      }

      await prisma.productCategory.create({
        data: { productId, categoryId },
      });
    }
  }

  private static async ensureUniqueCategorySlug(storeId: string, slug: string): Promise<string> {
    let uniqueSlug = slug;
    let counter = 1;
    let isUnique = false;

    while (!isUnique) {
      const existing = await prisma.category.findFirst({
        where: { storeId, slug: uniqueSlug },
      });

      if (!existing) {
        isUnique = true;
      } else {
        uniqueSlug = `${slug}-${counter}`;
        counter++;
      }
    }

    return uniqueSlug;
  }

  private static async updateProductTags(
    productId: string,
    storeId: string,
    tagsStr: string,
    cache: Map<string, string>
  ): Promise<void> {
    const tagNames = tagsStr
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    // Delete existing tags
    await prisma.productTag.deleteMany({ where: { productId } });

    for (const name of tagNames) {
      const cacheKey = `${storeId}:${name}`;
      let tagId = cache.get(cacheKey);

      if (!tagId) {
        // Find or create tag for this store (tags are now store-scoped)
        let tag = await prisma.tag.findFirst({
          where: { storeId, name },
        });

        if (!tag) {
          tag = await prisma.tag.create({
            data: { storeId, name },
          });
        }

        tagId = tag.id;
        cache.set(cacheKey, tagId);
      }

      await prisma.productTag.create({
        data: { productId, tagId },
      });
    }
  }

  private static async updateProductImages(productId: string, imagesStr: string): Promise<void> {
    const imageUrls = imagesStr
      .split(',')
      .map(i => i.trim())
      .filter(Boolean);

    // Delete existing images
    await prisma.productImage.deleteMany({ where: { productId } });

    // Create new images
    for (let i = 0; i < imageUrls.length; i++) {
      await prisma.productImage.create({
        data: {
          productId,
          url: imageUrls[i],
          position: i,
        },
      });
    }
  }
}
