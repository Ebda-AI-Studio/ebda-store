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

    // Hard ceiling to prevent OOM on very large stores.
    // Most stores have well under 10,000 products.
    const products = await prisma.product.findMany({
      where,
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
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
   * Import products from CSV data.
   *
   * Batched approach: pre-loads existing products, categories and tags for the
   * store into Maps, collects all create/update operations, then executes them
   * inside a single prisma.$transaction to minimise round-trips (~7500 queries
   * down to ~50 for a 500-row import).
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

    // ---- Phase 1: Pre-load existing data for fast in-memory lookups ----

    const existingProducts = await prisma.product.findMany({
      where: { storeId, deletedAt: null },
      select: { id: true, sku: true, slug: true },
    });

    // Maps for O(1) lookups by sku and slug
    const productBySku = new Map<string, { id: string; sku: string | null; slug: string }>();
    const productBySlug = new Map<string, { id: string; sku: string | null; slug: string }>();
    for (const p of existingProducts) {
      if (p.sku) productBySku.set(p.sku, p);
      productBySlug.set(p.slug, p);
    }

    // Pre-load all existing slugs into a Set for fast unique-slug generation
    const existingSlugs = new Set(existingProducts.map(p => p.slug));

    const existingCategories = await prisma.category.findMany({
      where: { storeId },
      select: { id: true, name: true, slug: true },
    });
    const categoryByName = new Map<string, string>();
    const existingCategorySlugs = new Set<string>();
    for (const c of existingCategories) {
      categoryByName.set(c.name, c.id);
      existingCategorySlugs.add(c.slug);
    }

    const existingTags = await prisma.tag.findMany({
      where: { storeId },
      select: { id: true, name: true },
    });
    const tagByName = new Map<string, string>();
    for (const t of existingTags) {
      tagByName.set(t.name, t.id);
    }

    // ---- Phase 2: Parse rows and collect operations ----

    // Collect new categories and tags that need to be created
    const newCategoryNames = new Set<string>();
    const newTagNames = new Set<string>();

    // Parsed row data for Phase 3
    interface ParsedRow {
      rowIndex: number;
      row: ProductImportRow;
      slug: string;
      existing: { id: string; sku: string | null; slug: string } | null;
    }
    const validRows: ParsedRow[] = [];

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
        const baseSlug = row.slug || this.generateSlug(row.name);

        // Check if product exists (by SKU or slug) using pre-loaded Maps
        let existing: { id: string; sku: string | null; slug: string } | null = null;
        if (row.sku) {
          existing = productBySku.get(row.sku) ?? null;
        }
        if (!existing) {
          existing = productBySlug.get(baseSlug) ?? null;
        }

        if (existing && !options.updateExisting) {
          result.failed++;
          result.errors.push({
            row: rowIndex,
            error: `Product with SKU "${row.sku}" or slug "${baseSlug}" already exists`,
          });
          continue;
        }

        // Ensure unique slug using the in-memory Set (avoid DB round-trip)
        let uniqueSlug = baseSlug;
        if (!existing || existing.slug !== baseSlug) {
          let counter = 1;
          while (existingSlugs.has(uniqueSlug)) {
            if (counter > 100) throw new Error('Too many slug collisions');
            uniqueSlug = `${baseSlug}-${counter}`;
            counter++;
          }
          existingSlugs.add(uniqueSlug);
        } else {
          // Updating existing product -- keep its current slug
          uniqueSlug = existing.slug;
        }

        validRows.push({ rowIndex, row, slug: uniqueSlug, existing });

        // Collect category/tag names that don't exist yet
        if (row.categories) {
          const names = String(row.categories)
            .split(',')
            .map(c => c.trim())
            .filter(Boolean);
          for (const name of names) {
            if (!categoryByName.has(name)) newCategoryNames.add(name);
          }
        }
        if (row.tags) {
          const names = String(row.tags)
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);
          for (const name of names) {
            if (!tagByName.has(name)) newTagNames.add(name);
          }
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          row: rowIndex,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // ---- Phase 3: Batch-create new categories and tags ----

    // Track the IDs of categories/tags this run created so we can clean
    // up orphans at the end. Phase 3 runs OUTSIDE the per-batch product
    // transaction (it has to — categories/tags are referenced by every
    // batch), so a Phase-4 batch failure used to leave dangling rows
    // with no products attached. We collect the new IDs here and prune
    // any that never got linked at the bottom of the function.
    const createdCategoryIds = new Set<string>();
    const createdTagIds = new Set<string>();

    if (newCategoryNames.size > 0) {
      // Generate unique slugs for new categories using the in-memory set
      const categoryData: Array<{ storeId: string; name: string; slug: string }> = [];
      for (const name of newCategoryNames) {
        let slug = this.generateSlug(name);
        let counter = 1;
        while (existingCategorySlugs.has(slug)) {
          if (counter > 100) throw new Error('Too many category slug collisions');
          slug = `${this.generateSlug(name)}-${counter}`;
          counter++;
        }
        existingCategorySlugs.add(slug);
        categoryData.push({ storeId, name, slug });
      }

      await prisma.category.createMany({ data: categoryData, skipDuplicates: true });

      // Re-fetch to get generated IDs
      const newCats = await prisma.category.findMany({
        where: { storeId, name: { in: [...newCategoryNames] } },
        select: { id: true, name: true },
      });
      for (const c of newCats) {
        categoryByName.set(c.name, c.id);
        createdCategoryIds.add(c.id);
      }
    }

    if (newTagNames.size > 0) {
      const tagData = [...newTagNames].map(name => ({ storeId, name }));
      await prisma.tag.createMany({ data: tagData, skipDuplicates: true });

      // Re-fetch to get generated IDs
      const newTags = await prisma.tag.findMany({
        where: { storeId, name: { in: [...newTagNames] } },
        select: { id: true, name: true },
      });
      for (const t of newTags) {
        tagByName.set(t.name, t.id);
        createdTagIds.add(t.id);
      }
    }

    // ---- Phase 4: Batch create/update products inside a transaction ----
    // Process in batches to avoid overly large transactions
    const BATCH_SIZE = 50;

    for (let batchStart = 0; batchStart < validRows.length; batchStart += BATCH_SIZE) {
      const batch = validRows.slice(batchStart, batchStart + BATCH_SIZE);

      try {
        await prisma.$transaction(async tx => {
          for (const { rowIndex, row, slug, existing } of batch) {
            try {
              const productFields = {
                name: row.name,
                nameAr: row.nameAr || null,
                slug,
                description: row.description || null,
                descriptionAr: row.descriptionAr || null,
                price: parseInt(String(row.price)),
                compareAtPrice: row.compareAtPrice ? parseInt(String(row.compareAtPrice)) : null,
                costPrice: row.costPrice ? parseInt(String(row.costPrice)) : null,
                sku: row.sku || null,
                barcode: row.barcode || null,
                inventory: row.inventory ? parseInt(String(row.inventory)) : 0,
                lowStockThreshold: row.lowStockThreshold
                  ? parseInt(String(row.lowStockThreshold))
                  : 5,
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

              let productId: string;

              if (existing) {
                // Update existing product
                await tx.product.update({
                  where: { id: existing.id },
                  data: productFields,
                });
                productId = existing.id;
                result.updated++;
              } else {
                // Create new product
                const created = await tx.product.create({
                  data: {
                    store: { connect: { id: storeId } },
                    ...productFields,
                  },
                });
                productId = created.id;

                // Create inventory history entry for initial stock
                if (productFields.inventory > 0) {
                  await tx.inventoryHistory.create({
                    data: {
                      productId,
                      storeId,
                      type: 'initial',
                      quantity: productFields.inventory,
                      previousStock: 0,
                      newStock: productFields.inventory,
                      reason: 'Initial stock from bulk import',
                      createdBy: userId,
                    },
                  });
                }

                result.created++;
              }

              // Handle categories: delete existing links, then bulk create new ones
              if (row.categories) {
                const categoryNames = String(row.categories)
                  .split(',')
                  .map(c => c.trim())
                  .filter(Boolean);

                await tx.productCategory.deleteMany({ where: { productId } });

                const categoryLinks = categoryNames
                  .map(name => {
                    const categoryId = categoryByName.get(name);
                    return categoryId ? { productId, categoryId } : null;
                  })
                  .filter(
                    (link): link is { productId: string; categoryId: string } => link !== null
                  );

                if (categoryLinks.length > 0) {
                  await tx.productCategory.createMany({
                    data: categoryLinks,
                    skipDuplicates: true,
                  });
                }
              }

              // Handle tags: delete existing links, then bulk create new ones
              if (row.tags) {
                const tagNames = String(row.tags)
                  .split(',')
                  .map(t => t.trim())
                  .filter(Boolean);

                await tx.productTag.deleteMany({ where: { productId } });

                const tagLinks = tagNames
                  .map(name => {
                    const tagId = tagByName.get(name);
                    return tagId ? { productId, tagId } : null;
                  })
                  .filter((link): link is { productId: string; tagId: string } => link !== null);

                if (tagLinks.length > 0) {
                  await tx.productTag.createMany({ data: tagLinks, skipDuplicates: true });
                }
              }

              // Handle images: delete existing, then bulk create new ones
              if (row.images) {
                const imageUrls = String(row.images)
                  .split(',')
                  .map(u => u.trim())
                  .filter(Boolean);

                await tx.productImage.deleteMany({ where: { productId } });

                if (imageUrls.length > 0) {
                  await tx.productImage.createMany({
                    data: imageUrls.map((url, position) => ({ productId, url, position })),
                  });
                }
              }
            } catch (error) {
              // Re-throw to roll back the batch transaction; per-row errors
              // are only possible for validation issues caught in Phase 2.
              throw Object.assign(error instanceof Error ? error : new Error('Unknown error'), {
                __rowIndex: rowIndex,
              });
            }
          }
        });
      } catch (error) {
        // If the batch transaction fails, mark all rows in the batch as failed
        const rowIndex =
          error && typeof error === 'object' && '__rowIndex' in error
            ? (error as { __rowIndex: number }).__rowIndex
            : batch[0].rowIndex;
        const message = error instanceof Error ? error.message : 'Unknown error';

        // Undo optimistic counts from within the rolled-back transaction
        for (const item of batch) {
          // Reset any counts that were incremented inside the transaction
          if (item.existing) {
            if (result.updated > 0) result.updated--;
          } else {
            if (result.created > 0) result.created--;
          }
          result.failed++;
          result.errors.push({
            row: item.rowIndex,
            error:
              item.rowIndex === rowIndex
                ? message
                : `Rolled back (batch failure at row ${rowIndex})`,
          });
        }
      }
    }

    // Orphan cleanup. Any category/tag this run created that didn't
    // end up linked to a product is dead weight (the rows referencing
    // it failed and rolled back). Delete the unreferenced ones — leaves
    // categories/tags that another product happens to use intact.
    if (createdCategoryIds.size > 0) {
      const referenced = await prisma.productCategory.findMany({
        where: { categoryId: { in: [...createdCategoryIds] } },
        select: { categoryId: true },
        distinct: ['categoryId'],
      });
      const referencedIds = new Set(referenced.map(r => r.categoryId));
      const orphanIds = [...createdCategoryIds].filter(id => !referencedIds.has(id));
      if (orphanIds.length > 0) {
        await prisma.category.deleteMany({
          where: { id: { in: orphanIds }, storeId },
        });
      }
    }

    if (createdTagIds.size > 0) {
      const referenced = await prisma.productTag.findMany({
        where: { tagId: { in: [...createdTagIds] } },
        select: { tagId: true },
        distinct: ['tagId'],
      });
      const referencedIds = new Set(referenced.map(r => r.tagId));
      const orphanIds = [...createdTagIds].filter(id => !referencedIds.has(id));
      if (orphanIds.length > 0) {
        await prisma.tag.deleteMany({
          where: { id: { in: orphanIds }, storeId },
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

  // Note: ensureUniqueSlug, updateProductCategories, updateProductTags,
  // updateProductImages, and ensureUniqueCategorySlug were removed in DB-002
  // refactor -- their logic is now handled inline in importProducts via
  // pre-loaded Maps and batched createMany calls.
}
