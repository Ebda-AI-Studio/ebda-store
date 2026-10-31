// @cantoo/pdf-lib imports three packages for features catalogue import never calls: colour
// conversion (form fields / SVG), HTML entity encoding and an HTML parser (rich-text form fields).
// Loading, counting and copying pages touches none of them, so the Worker aliases them to this stub
// (about 130 KB of the API bundle budget, Ruling CATIMP-4). Calling one throws instead of misbehaving.
// colors.js runs `converter('rgb')` at module load, so `converter` itself must return a function that
// throws only when the colour is actually converted, or the Worker fails to start.
const unavailable = (name: string) => (): never => {
  throw new Error(`${name} is not available on the Worker (stubbed out of the API bundle)`);
};
export const converter = (): (() => never) => unavailable('culori.converter(...)');
export const encode = unavailable('html-entities.encode');
export const parse = unavailable('node-html-better-parser.parse');
export const NodeType = { ELEMENT_NODE: 1, TEXT_NODE: 3 } as const;
