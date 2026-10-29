const enc = new TextEncoder();
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
};
const rand = n => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = data => crypto.subtle.digest('SHA-256', data);
const cat = (...bufs) => {
  const out = new Uint8Array(bufs.reduce((s, b) => s + b.byteLength, 0));
  let o = 0; for (const b of bufs) { out.set(new Uint8Array(b), o); o += b.byteLength; }
  return out;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ECDSA DER signature -> raw r||s (P-256)
function derToRaw(der) {
  const d = new Uint8Array(der);
  let p = 2; if (d[1] & 0x80) p += d[1] & 0x7f;
  const readInt = () => {
    const len = d[p + 1]; let v = d.slice(p + 2, p + 2 + len); p += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
  };
  return cat(readInt(), readInt());
}

async function verifySig(cred, signedData, signature) {
  const spki = b64u.dec(cred.publicKey);
  if (cred.alg === -7) {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), signedData);
  }
  if (cred.alg === -257) {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedData);
  }
  return false;
}

async function checkClientData(env, url, clientDataJSON, expectedType, challengeId) {
  const cd = JSON.parse(new TextDecoder().decode(clientDataJSON));
  if (cd.type !== expectedType || cd.origin !== url.origin) return false;
  const key = 'chal:' + challengeId;
  const stored = await env.ROULETTE_KV.get(key);
  await env.ROULETTE_KV.delete(key); // one-time use
  return stored !== null && stored === cd.challenge;
}

async function checkAuthData(url, authData) {
  const a = new Uint8Array(authData);
  const rpHash = new Uint8Array(await sha256(enc.encode(url.hostname)));
  return a.length >= 37 && eq(a.slice(0, 32), rpHash) && (a[32] & 0x01) === 0x01; // user present
}

const getCreds = async env => JSON.parse((await env.ROULETTE_KV.get('creds')) || '[]');

async function isAuthed(request, env) {
  const m = /(?:^|;\s*)session=([\w-]+)/.exec(request.headers.get('cookie') || '');
  return !!m && (await env.ROULETTE_KV.get('sess:' + m[1])) !== null;
}

async function newChallenge(env) {
  const challenge = rand(32), id = rand(16);
  await env.ROULETTE_KV.put('chal:' + id, challenge, { expirationTtl: 120 });
  return { challenge, challengeId: id };
}

async function handleAuth(request, env, url) {
  const path = url.pathname;
  const authed = await isAuthed(request, env);

  if (path === '/api/auth/me') {
    return json({ authed, hasCredentials: (await getCreds(env)).length > 0 });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const m = /session=([\w-]+)/.exec(request.headers.get('cookie') || '');
    if (m) await env.ROULETTE_KV.delete('sess:' + m[1]);
    return json({ ok: true }, 200, { 'set-cookie': 'session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const body = await request.json().catch(() => ({}));

  // Registration requires an existing session or the setup token (secret).
  if (path.startsWith('/api/auth/register')) {
    const tokenOk = env.ADMIN_SETUP_TOKEN && body.setupToken === env.ADMIN_SETUP_TOKEN;
    if (!authed && !tokenOk) return json({ error: 'forbidden' }, 403);
  }

  if (path === '/api/auth/register-options') {
    const c = await newChallenge(env);
    return json({ ...c, rpId: url.hostname, userId: rand(16) });
  }
  if (path === '/api/auth/register-verify') {
    const c = body.credential;
    if (!c || !(await checkClientData(env, url, b64u.dec(c.clientDataJSON), 'webauthn.create', body.challengeId)))
      return json({ error: 'invalid challenge' }, 400);
    if (!(await checkAuthData(url, b64u.dec(c.authenticatorData)))) return json({ error: 'invalid authenticator data' }, 400);
    if (![-7, -257].includes(c.alg)) return json({ error: 'unsupported algorithm' }, 400);
    const creds = await getCreds(env);
    creds.push({ id: c.id, publicKey: c.publicKey, alg: c.alg });
    await env.ROULETTE_KV.put('creds', JSON.stringify(creds));
    return json({ ok: true });
  }
  if (path === '/api/auth/login-options') {
    const creds = await getCreds(env);
    if (!creds.length) return json({ error: 'no passkey registered' }, 400);
    const c = await newChallenge(env);
    return json({ ...c, rpId: url.hostname, allow: creds.map(x => x.id) });
  }
  if (path === '/api/auth/login-verify') {
    const c = body.credential;
    const cred = c && (await getCreds(env)).find(x => x.id === c.id);
    if (!cred) return json({ error: 'unknown credential' }, 400);
    const clientData = b64u.dec(c.clientDataJSON), authData = b64u.dec(c.authenticatorData);
    if (!(await checkClientData(env, url, clientData, 'webauthn.get', body.challengeId))) return json({ error: 'invalid challenge' }, 400);
    if (!(await checkAuthData(url, authData))) return json({ error: 'invalid authenticator data' }, 400);
    const signed = cat(authData, await sha256(clientData));
    if (!(await verifySig(cred, signed, b64u.dec(c.signature)))) return json({ error: 'bad signature' }, 401);
    const sid = rand(32);
    await env.ROULETTE_KV.put('sess:' + sid, '1', { expirationTtl: 60 * 60 * 8 });
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true }, 200, { 'set-cookie': `session=${sid}; Path=/; Max-Age=28800; HttpOnly; SameSite=Strict${secure}` });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/auth/')) return await handleAuth(request, env, url);
      if (url.pathname === '/api/items') {
        if (request.method === 'GET') {
          const data = await env.ROULETTE_KV.get('items');
          return new Response(data || 'null', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        }
        if (request.method === 'PUT') {
          if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, 401);
          let body;
          try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
          if (!Array.isArray(body) || body.length > 200) return json({ error: 'invalid' }, 400);
          const clean = body.map(i => ({
            label: String(i.label ?? ''),
            color: /^#[0-9a-fA-F]{6}$/.test(i.color) ? i.color : '#888888',
            weight: Math.max(1, Math.min(100, Number(i.weight) || 1)),
          }));
          await env.ROULETTE_KV.put('items', JSON.stringify(clean));
          return new Response(null, { status: 204 });
        }
        return json({ error: 'method not allowed' }, 405);
      }
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
