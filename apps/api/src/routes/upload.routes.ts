import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { StorageService } from '../services/storage.service';
import { uploadLimiter, dailyUploadLimiter, auditLog } from '../middleware/security';

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 10, // Max 10 files at once
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/x-icon',
      'image/vnd.microsoft.icon',
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`));
    }
  },
});

/**
 * GET /uploads/status
 * Check if storage is configured
 */
router.get('/status', authenticate, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      available: StorageService.isAvailable(),
    },
  });
});

/**
 * POST /uploads/image
 * Upload a single image
 */
router.post(
  '/image',
  authenticate,
  requirePermission('products:write'),
  uploadLimiter,
  dailyUploadLimiter,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' },
        });
        return;
      }

      const folder = ((req.query.folder as string) || 'products').replace(/[^a-zA-Z0-9_-]/g, '');

      const result = await StorageService.upload(req.file.buffer, req.file.originalname, {
        folder,
      });

      await auditLog({
        action: 'file.uploaded',
        userId: req.user!.userId,
        resourceType: 'file',
        resourceId: result.key,
        details: {
          filename: req.file.originalname,
          size: result.size,
          contentType: result.contentType,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /uploads/images
 * Upload multiple images
 */
router.post(
  '/images',
  authenticate,
  requirePermission('products:write'),
  uploadLimiter,
  dailyUploadLimiter,
  upload.array('files', 10),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILES', message: 'No files uploaded' },
        });
        return;
      }

      const folder = ((req.query.folder as string) || 'products').replace(/[^a-zA-Z0-9_-]/g, '');

      const results = await StorageService.uploadMultiple(
        files.map(f => ({ buffer: f.buffer, filename: f.originalname })),
        { folder }
      );

      await auditLog({
        action: 'files.uploaded',
        userId: req.user!.userId,
        resourceType: 'file',
        details: {
          count: results.length,
          totalSize: results.reduce((sum, r) => sum + r.size, 0),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { files: results },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /uploads/presigned
 * Get a presigned URL for direct upload
 */
router.post(
  '/presigned',
  authenticate,
  requirePermission('products:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename, contentType, folder } = req.body;

      if (!filename || !contentType) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_PARAMS', message: 'filename and contentType are required' },
        });
        return;
      }

      // Validate content type against allowed types
      const allowedContentTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/x-icon',
        'image/vnd.microsoft.icon',
      ];
      if (!allowedContentTypes.includes(contentType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TYPE',
            message: `Invalid content type: ${contentType}. Allowed: ${allowedContentTypes.join(', ')}`,
          },
        });
        return;
      }

      const sanitizedFolder = (folder || 'products').replace(/[^a-zA-Z0-9_-]/g, '');
      const result = await StorageService.getUploadUrl(filename, contentType, sanitizedFolder);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /uploads/:key
 * Delete a file
 */
router.delete(
  '/:key(*)',
  authenticate,
  requirePermission('products:delete'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;

      // Validate key doesn't contain path traversal
      if (key.includes('..') || key.startsWith('/')) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_KEY', message: 'Invalid file key' },
        });
        return;
      }

      // Validate key belongs to the requesting store to prevent cross-store deletion
      const storeId = req.headers['x-store-id'] as string;
      if (!storeId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_STORE', message: 'Store ID is required' },
        });
        return;
      }

      if (!key.startsWith(storeId + '/') && !key.startsWith('stores/' + storeId + '/')) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Cannot delete files from another store' },
        });
        return;
      }

      await StorageService.delete(key);

      await auditLog({
        action: 'file.deleted',
        userId: req.user!.userId,
        resourceType: 'file',
        resourceId: key,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { message: 'File deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
