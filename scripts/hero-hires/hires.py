# MANUAL, offline step: re-render a demo hero still at 2048x1152 from its committed 1024-wide
# reference, so the delivered file is >= 1.4x a 1440 px desktop viewport (the 1024 px originals were
# upscaled ~1.4x at DPR 1 and ~2.8x on retina). Cloudflare Workers AI FLUX.2 [dev] with the old still
# as `input_image_0` keeps composition, subjects and palette; width is capped at 2048 by the model.
# Needs the local wrangler OAuth token (`npx wrangler whoami` refreshes it). Touches no production data.
# usage: hires.py <template> <name> [<name> ...]   -> hero-hires/img-src/<template>-<name>.jpg (gitignored)
# then:  (Dahab only) uv run --with pillow --with numpy python dahab-demo/grade.py after pointing IMG at img-src,
#        encode.sh   -> <template>-demo/assets/<name>-2k.webp  (the strict Dahab orange probe is the gate)
import sys, os, re, json, base64, subprocess, importlib.util, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'img-src'); os.makedirs(OUT, exist_ok=True)
txt = open(os.path.expanduser('~/Library/Preferences/.wrangler/config/default.toml')).read()
TOK = re.search(r'oauth_token\s*=\s*"([^"]+)"', txt).group(1)
URL = 'https://api.cloudflare.com/client/v4/accounts/69188202efc4df480140dd76545aa3ab/ai/run/@cf/black-forest-labs/flux-2-dev'
STYLE = ('The same photograph at high resolution. Keep the composition, subjects, colours and lighting of the reference exactly; '
         'sharp realistic photograph, fine natural detail, no text, no logos, no orange, no yellow gold. ')
tpl, names = sys.argv[1], sys.argv[2:]
d = os.path.join(ROOT, f'{tpl}-demo')
spec = importlib.util.spec_from_file_location('prompts', os.path.join(d, 'prompts.py'))
m = importlib.util.module_from_spec(spec); sys.path.insert(0, d); spec.loader.exec_module(m)
for n in names:
    ref = os.path.join(d, 'assets', n + '.webp')
    jpg = tempfile.mktemp(suffix='.jpg')
    subprocess.run(['sips', '-s', 'format', 'jpeg', ref, '--out', jpg], capture_output=True, check=True)
    base = m.P.get(n, '')
    prompt = STYLE + (re.sub(r'\s+', ' ', base)[:600])
    r = subprocess.run(['curl', '-s', '-X', 'POST', URL, '-H', 'Authorization: Bearer ' + TOK, '-F', 'prompt=' + prompt,
                        '-F', 'width=2048', '-F', 'height=1152', '-F', 'steps=28', '-F', 'input_image_0=@' + jpg],
                       capture_output=True, text=True)
    j = json.loads(r.stdout)
    if not j.get('success'): print('FAIL', tpl, n, j.get('errors')); sys.exit(1)
    open(f'{OUT}/{tpl}-{n}.jpg', 'wb').write(base64.b64decode(j['result']['image'])); print('ok', tpl, n, flush=True)
