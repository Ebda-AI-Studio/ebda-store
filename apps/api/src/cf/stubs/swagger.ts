// swagger-jsdoc / swagger-ui-express: /docs moves to docs.ebda.app (SP9);
// docs/swagger.ts skips them on Workers.
const swagger = Object.assign(() => ({}), { serve: [], setup: () => () => undefined });
export default swagger;
