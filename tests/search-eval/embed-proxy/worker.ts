/**
 * LOCAL-ONLY embedding proxy for the search eval (tests/search-eval/run.ts). `wrangler dev` runs it
 * on 127.0.0.1 with the Workers AI `AI` binding, which wrangler proxies to the REAL model on the
 * logged-in account (the Whisky account, 69188202…; never a Force AI account). It lets the eval use
 * real bge-m3 without minting or copying an API token: wrangler's own login authorises the binding.
 * POST {"text": ["...", ...]} → the model's raw output ({ shape, data, pooling }). Never deployed.
 *   npx wrangler dev -c tests/search-eval/embed-proxy/wrangler.jsonc --ip 127.0.0.1 --port 8799
 */
interface Env {
  AI: { run(model: string, input: { text: string[] }): Promise<unknown> };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') return new Response('POST {"text": [...]}', { status: 405 });
    const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
    const text = body?.text;
    if (
      !Array.isArray(text) ||
      text.length === 0 ||
      text.length > 100 ||
      text.some(t => typeof t !== 'string')
    )
      return new Response('text must be 1-100 strings', { status: 400 });
    return Response.json(await env.AI.run('@cf/baai/bge-m3', { text: text as string[] }));
  },
};
