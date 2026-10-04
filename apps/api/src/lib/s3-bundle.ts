// The S3 surface the API uses, in ONE module so `lazy-modules.ts` can load it with a dynamic
// import. Naming the commands here (instead of `import('@aws-sdk/client-s3')`) keeps esbuild's
// tree-shaking: a dynamically imported package is bundled whole, all ~100 commands (+540 KiB).
export {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
export { getSignedUrl } from '@aws-sdk/s3-request-presigner';
