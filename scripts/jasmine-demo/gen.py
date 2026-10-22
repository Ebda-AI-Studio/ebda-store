# MANUAL, offline step (copy of scripts/souq-demo/gen.py for the Jasmine demo catalogue).
# Needs the local wrangler OAuth token (Cloudflare Workers AI, FLUX.1 schnell). Touches no production
# data. Never run from a build. Skips files that already exist: delete one to regenerate it.
import sys, os, re, json, time, base64, subprocess, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from prompts import P
IMG = os.path.join(HERE, 'img-src')
os.makedirs(IMG, exist_ok=True)
txt = open(os.path.expanduser('~/Library/Preferences/.wrangler/config/default.toml')).read()
TOK = re.search(r'oauth_token\s*=\s*"([^"]+)"', txt).group(1)
URL = 'https://api.cloudflare.com/client/v4/accounts/69188202efc4df480140dd76545aa3ab/ai/run/@cf/black-forest-labs/flux-1-schnell'
only = set(sys.argv[1:])
def call(prompt):
    body = {'prompt': prompt, 'steps': 8}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=120))['result']['image']
ok = fail = 0
for k, p in P.items():
    if only and k not in only: continue
    out = f'{IMG}/{k}.jpg'
    if os.path.exists(out): continue
    for attempt in (1, 2):
        try:
            raw = base64.b64decode(call(p)); tmp = out + '.raw'
            open(tmp, 'wb').write(raw)
            subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '92', tmp, '--out', out], capture_output=True, check=True)
            os.remove(tmp); ok += 1; print('ok', k, os.path.getsize(out), flush=True); time.sleep(1); break
        except urllib.error.HTTPError as e:
            print('http', e.code, k, attempt, flush=True)
            if e.code == 401: print('AUTH EXPIRED'); sys.exit(2)
            if e.code == 429 and attempt == 1: time.sleep(30)
            elif attempt == 2: fail += 1
        except Exception as e:
            print('err', type(e).__name__, k, attempt, flush=True)
            if attempt == 2: fail += 1
print('done ok', ok, 'fail', fail)
sys.exit(1 if fail else 0)
