// `@aws-sdk/xml-builder` for workerd (prod P1 2026-11-05: catalog-import-uploads-sweep "ReferenceError: DOMParser is not defined").
//
// The package has two XML parsers: `xml-parser.js` (pure JS, no dependencies) and `xml-parser.browser.js`, which calls the global
// `DOMParser`. Its `browser` field swaps the first for the second, and wrangler's esbuild resolves with the `browser` condition,
// so the Worker got the DOMParser one. Workers have no DOMParser, so EVERY S3 response with an XML body failed to deserialize:
// ListObjectsV2, DeleteObjects, and the XML error body of any failed call.
//
// wrangler.jsonc aliases `@aws-sdk/xml-builder` to this file: the SDK's own node parser, imported by file path (a direct path
// import is not remapped by the `browser` field), plus the two XML builders the serializers use. No dependency is added.
// Pinned by workers-test/s3-xml.test.ts (built Worker) and tests/unit/ops/aws-xml-builder-alias.test.ts.
// @ts-ignore -- the SDK ships declarations for the package entry, not for these dist-es files
export { XmlNode } from '../../../../../node_modules/@aws-sdk/xml-builder/dist-es/XmlNode.js';
// @ts-ignore -- the SDK ships declarations for the package entry, not for these dist-es files
export { XmlText } from '../../../../../node_modules/@aws-sdk/xml-builder/dist-es/XmlText.js';
// @ts-ignore -- the SDK ships declarations for the package entry, not for these dist-es files
export { parseXML } from '../../../../../node_modules/@aws-sdk/xml-builder/dist-es/xml-parser.js';
