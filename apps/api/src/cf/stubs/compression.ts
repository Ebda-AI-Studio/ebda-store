// The edge compresses; app.ts does not install the middleware on Workers
// (experiment B7: node:zlib streams lose the body under httpServerHandler).
function compression(): (req: unknown, res: unknown, next: () => void) => void {
  return (_req, _res, next) => next();
}
compression.filter = (): boolean => false;
export default compression;
