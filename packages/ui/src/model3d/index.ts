// Subpath `@force/ui/model3d` — deliberately NOT re-exported from the package
// root: importing it pulls three.js. Reach it only via next/dynamic(ssr:false).
export * from './ProductModelViewer';
export { default } from './ProductModelViewer';
export * from './ar';
