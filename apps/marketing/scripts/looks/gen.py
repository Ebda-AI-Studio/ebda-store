import sys, os, re, json, time, base64, subprocess, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompts import S
# MANUAL, offline step (needs a Cloudflare Workers AI token; FLUX.1 schnell). Never run from a build.
IMG = os.environ.get('LOOKS_IMG_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'img-src')
os.makedirs(IMG, exist_ok=True)
txt = open(os.path.expanduser('~/Library/Preferences/.wrangler/config/default.toml')).read()
TOK = re.search(r'oauth_token\s*=\s*"([^"]+)"', txt).group(1)
URL = 'https://api.cloudflare.com/client/v4/accounts/69188202efc4df480140dd76545aa3ab/ai/run/@cf/black-forest-labs/flux-1-schnell'
def call(prompt):
    req = urllib.request.Request(URL, json.dumps({'prompt': prompt, 'steps': 6}).encode(), {'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=120))['result']['image']
ok = fail = 0
for d, items in S.items():
    for k, p in items.items():
        out = f'{IMG}/{d}__{k}.jpg'
        if os.path.exists(out): continue
        for attempt in (1, 2):
            try:
                raw = base64.b64decode(call(p)); tmp = out + '.raw'
                open(tmp, 'wb').write(raw)
                subprocess.run(['sips', '-Z', '720', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', tmp, '--out', out], capture_output=True)
                os.remove(tmp); ok += 1; print('ok', d, k, os.path.getsize(out), flush=True); time.sleep(2); break
            except urllib.error.HTTPError as e:
                print('http', e.code, d, k, attempt, flush=True)
                if e.code == 401: print('AUTH EXPIRED'); sys.exit(2)
                if e.code == 429 and attempt == 1: time.sleep(30)
                elif attempt == 2: fail += 1
            except Exception as e:
                print('err', type(e).__name__, d, k, attempt, flush=True)
                if attempt == 2: fail += 1
print('done ok', ok, 'fail', fail)
