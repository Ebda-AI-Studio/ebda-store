/** A software WebAuthn authenticator (platform, UV, ES256, "none" attestation) so passkey ceremonies run for real in tests. */
import { b64urlEncode } from '../src/util';

const enc = new TextEncoder();
const cat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const sha = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

// --- minimal CBOR (uint, negint, bytes, text, map) ---
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return cat(head(3, enc.encode(v).length), enc.encode(v));
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

function derSig(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let s = b.slice(i);
    if (s[0] & 0x80) s = cat(Uint8Array.of(0), s);
    return cat(Uint8Array.of(0x02, s.length), s);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

export class SoftAuthenticator {
  counter = 0;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private keys!: CryptoKeyPair;

  static async create() {
    const a = new SoftAuthenticator();
    a.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return a;
  }

  get id() {
    return b64urlEncode(this.credentialId);
  }

  private async cose(): Promise<Uint8Array> {
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const b = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, b(jwk.x!)],
        [-3, b(jwk.y!)],
      ])
    );
  }

  private clientData(type: string, challenge: string, origin: string) {
    return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  async register(opts: { challenge: string; rpId: string }, origin: string) {
    const rpIdHash = await sha(enc.encode(opts.rpId));
    const attested = cat(
      new Uint8Array(16),
      Uint8Array.of(0, this.credentialId.length),
      this.credentialId,
      await this.cose()
    );
    const counter = new Uint8Array(4);
    const authData = cat(rpIdHash, Uint8Array.of(0x45 /* UP|UV|AT */), counter, attested);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ])
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64urlEncode(this.clientData('webauthn.create', opts.challenge, origin)),
        attestationObject: b64urlEncode(attestationObject),
        transports: ['internal'],
      },
    };
  }

  async assert(
    opts: { challenge: string; rpId: string },
    origin: string,
    userHandle?: string,
    forceCounter?: number
  ) {
    this.counter = forceCounter ?? this.counter + 1;
    const rpIdHash = await sha(enc.encode(opts.rpId));
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, this.counter);
    const authData = cat(rpIdHash, Uint8Array.of(0x05 /* UP|UV */), c);
    const clientDataJSON = this.clientData('webauthn.get', opts.challenge, origin);
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.keys.privateKey,
        cat(authData, await sha(clientDataJSON)) as BufferSource
      )
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(derSig(sig)),
        ...(userHandle ? { userHandle: b64urlEncode(enc.encode(userHandle)) } : {}),
      },
    };
  }
}
