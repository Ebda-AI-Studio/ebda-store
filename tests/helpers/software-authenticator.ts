/**
 * A software WebAuthn authenticator (ES256, "none" attestation) for tests. It produces the same JSON a
 * browser hands back from `navigator.credentials.create/get` (after @simplewebauthn/browser's encoding),
 * so the server code under test runs the REAL @simplewebauthn/server verification, not a stub.
 *
 * Deliberately independent of the library under test: the CBOR/COSE/authData bytes are written here by hand.
 */
import crypto from 'node:crypto';

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | Uint8Array | string) => crypto.createHash('sha256').update(b).digest();

// ---- minimal CBOR encoder (unsigned/negative ints, byte strings, text strings, maps) ----
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  throw new Error('cbor: too large for test encoder');
}
type Cbor = number | Buffer | string | Array<[Cbor, Cbor]>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.length), ...v.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export interface SoftCredential {
  /** base64url credential id, as the server stores it. */
  id: string;
  privateKey: crypto.KeyObject;
  rpId: string;
  counter: number;
  /** base64url of the user handle the server asked us to remember (discoverable credential). */
  userHandle: string;
}

export interface AuthOptions {
  /** Defaults to the origin passed to `register` / `assert`. */
  clientDataOrigin?: string;
  /** Defaults to true. Clears the UV flag when false. */
  userVerified?: boolean;
}

function authData(rpId: string, flags: number, counter: number, attested?: Buffer): Buffer {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(counter);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), c, attested ?? Buffer.alloc(0)]);
}

/** navigator.credentials.create() against `options` (PublicKeyCredentialCreationOptionsJSON). */
export function register(
  options: { challenge: string; rp: { id?: string }; user: { id: string } },
  origin: string,
  opts: AuthOptions = {}
): { credential: SoftCredential; response: Record<string, unknown> } {
  const rpId = options.rp.id as string;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = crypto.randomBytes(32);
  const cose = cbor([
    [1, 2], // kty EC2
    [3, -7], // alg ES256
    [-1, 1], // crv P-256
    [-2, Buffer.from(jwk.x as string, 'base64url')],
    [-3, Buffer.from(jwk.y as string, 'base64url')],
  ]);
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(id.length);
  const attested = Buffer.concat([Buffer.alloc(16), idLen, id, cose]);
  const uv = opts.userVerified === false ? 0 : 0x04;
  const ad = authData(rpId, 0x01 | uv | 0x40, 0, attested); // UP | UV | AT
  const attestationObject = cbor([
    ['fmt', 'none'],
    ['attStmt', []],
    ['authData', ad],
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: opts.clientDataOrigin ?? origin,
      crossOrigin: false,
    })
  );
  return {
    credential: {
      id: b64u(id),
      privateKey,
      rpId,
      counter: 0,
      userHandle: options.user.id,
    },
    response: {
      id: b64u(id),
      rawId: b64u(id),
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    },
  };
}

/** navigator.credentials.get() against `options` (PublicKeyCredentialRequestOptionsJSON). */
export function assert(
  cred: SoftCredential,
  options: { challenge: string },
  origin: string,
  opts: AuthOptions & { counter?: number; omitUserHandle?: boolean; userHandle?: string } = {}
): Record<string, unknown> {
  cred.counter = opts.counter ?? cred.counter + 1;
  const uv = opts.userVerified === false ? 0 : 0x04;
  const ad = authData(cred.rpId, 0x01 | uv, cred.counter);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: options.challenge,
      origin: opts.clientDataOrigin ?? origin,
      crossOrigin: false,
    })
  );
  const signature = crypto.sign(
    'sha256',
    Buffer.concat([ad, sha256(clientDataJSON)]),
    cred.privateKey
  );
  return {
    id: cred.id,
    rawId: cred.id,
    type: 'public-key',
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(ad),
      signature: b64u(signature),
      ...(opts.omitUserHandle ? {} : { userHandle: opts.userHandle ?? cred.userHandle }),
    },
  };
}
