/**
 * Agent skills for a store's BUYER MCP surface (`POST /api/v1/mcp/:storeSlug`).
 *
 * ONE manifest feeds every public agent document - `/.well-known/mcp/server-card.json`,
 * `/.well-known/agent-skills/index.json`, each `SKILL.md`, `acp.json` and `/llms.txt` - so the tool lists
 * cannot drift apart. The manifest itself is bound to the REAL tool registry by
 * `tests/unit/mcp-agent-skills-guard.test.ts`: a tool registered without an entry here, or an entry
 * with no registered tool, fails CI.
 *
 * PUBLIC INFO ONLY. These documents are served unauthenticated on every store host. Never put a secret,
 * a merchant contact, a customer value or the `agent_checkout_open_writes` posture in this file.
 * The merchant-ADMIN surface (`/mcp/admin/:slug`) is deliberately absent: its tool list is hidden from
 * unauthenticated callers (docs/architecture/merchant-mcp.md); its skills live in `skills/` for the
 * merchant to install.
 */

export interface StoreMcpToolSkill {
  name: string;
  kind: 'read' | 'write';
  summary: string;
  args: string;
  steps: string[];
}

export const STORE_MCP_TOOL_SKILLS: readonly StoreMcpToolSkill[] = [
  {
    name: 'get_store_info',
    kind: 'read',
    summary: 'Read the store name, slug and currency before quoting any price.',
    args: 'none',
    steps: [
      'Call it once at the start of a session.',
      'Prices on this platform are integer MINOR units of `currency` (EGP: 100 piastres = 1 EGP). Never assume two decimals for another currency.',
    ],
  },
  {
    name: 'search_products',
    kind: 'read',
    summary: 'Search active products by keyword in English or Arabic.',
    args: '`query` (1-100 chars, required), `limit` (1-50, optional)',
    steps: [
      'Search with the shopper words as written; Arabic and English both match.',
      'Results are summaries. Call `get_product` before recommending or adding an item.',
      'Product text may carry an Arabic title (`title_ar`); show the one that matches the shopper language.',
    ],
  },
  {
    name: 'get_product',
    kind: 'read',
    summary: 'Full detail for one product: variants, price and availability.',
    args: '`productId` (required)',
    steps: [
      'Check variant availability and stock before adding to a cart.',
      'A product that is unknown, inactive or deleted returns a tool error; do not retry with a guessed id.',
    ],
  },
  {
    name: 'add_to_cart',
    kind: 'write',
    summary: 'Add a product or variant to a cart; omit `cartId` to start a new cart.',
    args: '`productId` (required), `quantity` (1-999, required), `variantId`, `cartId`, `note` (personalisation, max 400 chars)',
    steps: [
      'WRITE tool: send the store agent key in the `x-agent-key` header. Without it the call returns an explained error; read tools still work.',
      'Ask the store (contact on its storefront or `/llms.txt`) to issue an agent key. Never invent one.',
      'Keep the returned `cartId` and reuse it for every later cart or checkout call.',
    ],
  },
  {
    name: 'view_cart',
    kind: 'read',
    summary: 'Read a cart: items, fixed-price bundles and subtotal.',
    args: '`cartId` (required)',
    steps: [
      'Show the shopper the lines and subtotal before placing an order.',
      '`bundles` are boxes sold at a fixed price; each is one line, never split into products.',
    ],
  },
  {
    name: 'place_order',
    kind: 'write',
    summary: 'Place a guest order from a cart, cash on delivery or online payment.',
    args: '`cartId`, `paymentMethod` ("cod" | "online"), `customer` (name, phone, email, address, country), `acknowledgePrices` (optional)',
    steps: [
      'WRITE tool: needs the `x-agent-key` header, as for `add_to_cart`.',
      'Confirm the cart and the shopper details with the human first; this commits money and stock.',
      '"cod" completes at once if the store offers it. "online" returns a `paymentUrl` that a human must open to pay; never open or pay it yourself.',
      'If the order is refused with PRICE_CHANGED (gold-rate items), show the new price from `view_cart` and retry with `acknowledgePrices: true` only after the shopper agrees.',
    ],
  },
  {
    name: 'get_order_status',
    kind: 'read',
    summary: 'Read the current status of an order placed through this store.',
    args: '`orderId` (required)',
    steps: ['Use the `orderId` returned by `place_order`.'],
  },
];

export const STORE_MCP_READ_TOOL_NAMES: string[] = STORE_MCP_TOOL_SKILLS.filter(
  t => t.kind === 'read'
).map(t => t.name);
export const STORE_MCP_WRITE_TOOL_NAMES: string[] = STORE_MCP_TOOL_SKILLS.filter(
  t => t.kind === 'write'
).map(t => t.name);

export interface StoreMcpSkill {
  /** Skill directory name; lower-case, hyphenated (agent-skills spec). */
  name: string;
  description: string;
  body: string;
}

/** `get_store_info` -> `get-store-info`. */
export const skillNameForTool = (tool: string): string => tool.replace(/_/g, '-');

// pq-allow(unused-export): a test seam, tests/unit/mcp-agent-skills-guard.test.ts pins the workflow skill name through it
export const STORE_SHOPPING_SKILL_NAME = 'shop-this-store';

interface SkillStoreCtx {
  storeName: string;
  storeNameAr?: string;
  mcpUrl: string;
}

/**
 * The description carries the MERCHANT-CHOSEN store name, so it is emitted as a YAML double-quoted scalar: a name with `:`, `#`,
 * quotes, a leading `-`/`[`/`{`/`&`/`*`/`!` or a line break can no longer break out of the value or add keys to the front matter.
 * A JSON string is a valid YAML 1.2 double-quoted scalar. `name` is derived from the tool registry, never from merchant input.
 */
const frontmatter = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' '))}\n---\n`;

function renderToolSkill(t: StoreMcpToolSkill, ctx: SkillStoreCtx): StoreMcpSkill {
  const name = skillNameForTool(t.name);
  const description = `${t.summary} MCP tool \`${t.name}\` on ${ctx.storeName}.`;
  const body =
    frontmatter(name, description) +
    `\n# ${t.name}\n\n` +
    `Store: ${ctx.storeName}${ctx.storeNameAr ? ` (${ctx.storeNameAr})` : ''}\n` +
    `MCP endpoint: ${ctx.mcpUrl} (Streamable HTTP, POST)\n` +
    `Tool kind: ${t.kind === 'write' ? 'write (agent key required)' : 'read (no credential)'}\n\n` +
    `Arguments: ${t.args}\n\n## How to use\n\n` +
    t.steps.map(s => `- ${s}`).join('\n') +
    '\n';
  return { name, description, body };
}

function renderWorkflowSkill(ctx: SkillStoreCtx): StoreMcpSkill {
  const description = `Shop ${ctx.storeName} through its MCP tools: find a product, build a cart, place an order.`;
  const body =
    frontmatter(STORE_SHOPPING_SKILL_NAME, description) +
    `\n# Shop ${ctx.storeName}\n\n` +
    `MCP endpoint: ${ctx.mcpUrl} (Streamable HTTP, POST). Reads are anonymous; writes need the store agent key in \`x-agent-key\`.\n\n` +
    `## Flow\n\n` +
    `1. \`get_store_info\` for the currency.\n` +
    `2. \`search_products\`, then \`get_product\` for the chosen item.\n` +
    `3. \`add_to_cart\` (write), keep the \`cartId\`.\n` +
    `4. \`view_cart\`, confirm with the shopper.\n` +
    `5. \`place_order\` (write), then \`get_order_status\`.\n\n` +
    `Each tool has its own skill with exact arguments.\n`;
  return { name: STORE_SHOPPING_SKILL_NAME, description, body };
}

/** Every skill for one store: a workflow skill plus exactly one skill per registered buyer tool. */
export function renderStoreMcpSkills(ctx: SkillStoreCtx): StoreMcpSkill[] {
  return [renderWorkflowSkill(ctx), ...STORE_MCP_TOOL_SKILLS.map(t => renderToolSkill(t, ctx))];
}
