/**
 * Shared MCP tool result wrapper. A thrown Error inside a tool handler is
 * automatically converted by the SDK into `{ content: [...], isError: true }`
 * (see `CallToolRequestSchema` handler in
 * `@modelcontextprotocol/sdk/server/mcp.js`), so tools that need a "not
 * found"-style error can simply `throw` (e.g. the `AppError` thrown by
 * `ProductService.getPublicById`) rather than constructing an error result
 * themselves.
 *
 * Reused by catalog tools (Task 4), cart tools (Task 5), and order tools
 * (Task 6) so every MCP tool serializes its success payload the same way.
 */
export const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});
