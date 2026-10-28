# SEARCH-T10-3

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T10-3 — the REST fallback path is verified by fakes only. Task 10 Step 1 measured the binding (above), not the REST endpoint: no `CF_AI_API_TOKEN` exists in this session and the wrangler OAuth token was deliberately not lifted out of its config file. The REST body shape (`{ success, result: { data, shape } }`) is Cloudflare's documented envelope around the same model output. It matters only for local Node dev; the Worker never uses it. To settle: with a Workers AI token on the Whisky account, `curl -s https://api.cloudflare.com/client/v4/accounts/$CF_AI_ACCOUNT_ID/ai/run/@cf/baai/bge-m3 -H "Authorization: Bearer $CF_AI_API_TOKEN" -d '{"text":["x"]}'` and check `result.shape` = `[1,1024]`. Cost if wrong: Node-dev embedding calls throw a clear "expected N vectors" error; production is unaffected.
