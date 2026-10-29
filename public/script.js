const PALETTE = ['#e4572e','#f3a712','#f6e27a','#a8c686','#29a19c','#669bbc','#9d8189','#f4a6a0','#ffffff'];
const DEFAULT = () => ['Great luck','Good luck','Small luck','Luck','Slight luck','Bad luck'].map((l, i) => ({label: l, color: PALETTE[i % PALETTE.length], weight: 1}));
const API = '/api/items';
const ADMIN = document.body.dataset.admin === '1';
const $ = id => document.getElementById(id);

let items = DEFAULT();
let angle = 0, spinning = false;

const canvas = $('wheel');
const ctx = canvas.getContext('2d');
const resultEl = $('result');
const spinBtn = $('spinBtn');
const total = () => items.reduce((s, i) => s + i.weight, 0);

// Pick black or white text depending on the segment color's brightness
function textColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const y = ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return y > 140 ? '#161616' : '#ffffff';
}

/* ---------- wheel ---------- */
function draw() {
  const W = canvas.width, c = W / 2, r = c - 6;
  ctx.clearRect(0, 0, W, W);
  if (!items.length) {
    ctx.fillStyle = '#eee';
    ctx.beginPath(); ctx.arc(c, c, r, 0, 7); ctx.fill();
    ctx.fillStyle = '#161616'; ctx.font = '28px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No items', c, c);
    return;
  }
  let a = angle;
  const t = total();
  items.forEach(it => {
    const span = it.weight / t * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, r, a, a + span); ctx.closePath();
    ctx.fillStyle = it.color; ctx.fill();
    ctx.strokeStyle = '#161616'; ctx.lineWidth = 4; ctx.stroke();
    ctx.save();
    ctx.translate(c, c); ctx.rotate(a + span / 2);
    ctx.fillStyle = textColor(it.color);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const maxW = r * 0.64, thick = 2 * r * 0.42 * Math.sin(Math.min(span, Math.PI) / 2) - 8;
    let size = 34, lines;
    for (; ; size -= 1) {
      ctx.font = `700 ${size}px 'Space Grotesk','Noto Sans JP',sans-serif`;
      lines = wrapText(it.label, maxW);
      if (size <= 8 || lines.length * size * 1.15 <= thick) break;
    }
    const lh = size * 1.15, y0 = -(lines.length - 1) * lh / 2;
    lines.forEach((ln, k) => ctx.fillText(ln, r - 20, y0 + k * lh));
    ctx.restore();
    a += span;
  });
}

// Wrap text into lines no wider than maxW (breaks at spaces when possible, else per character)
function wrapText(text, maxW) {
  const lines = [];
  let cur = '';
  for (const ch of text) {
    if (ch === '\n') { lines.push(cur); cur = ''; continue; }
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      const sp = cur.lastIndexOf(' ');
      if (ch !== ' ' && sp > 0) { lines.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + ch; }
      else { lines.push(cur); cur = ch === ' ' ? '' : ch; }
    } else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function spin() {
  if (spinning || !items.length) return;
  spinning = true; spinBtn.disabled = true;
  resultEl.textContent = ''; resultEl.classList.remove('win', 'show');
  const start = angle;
  const target = start + (5 + Math.random() * 3) * Math.PI * 2 + Math.random() * Math.PI * 2;
  const dur = 5000, t0 = performance.now();
  const frame = now => {
    const p = Math.min(1, (now - t0) / dur);
    angle = start + (target - start) * (1 - Math.pow(1 - p, 4));
    draw();
    if (p < 1) return requestAnimationFrame(frame);
    spinning = false; spinBtn.disabled = false;
    finish();
  };
  requestAnimationFrame(frame);
}

function finish() {
  const two = Math.PI * 2;
  const pos = ((-Math.PI / 2 - angle) % two + two) % two;
  const t = total();
  let acc = 0, idx = 0;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].weight / t * two;
    if (pos < acc) { idx = i; break; }
  }
  const win = items[idx];
  resultEl.textContent = `🎉 ${win.label}`;
  resultEl.style.borderColor = win.color;
  void resultEl.offsetWidth; resultEl.classList.add('show', 'win');
}

spinBtn.onclick = spin;

async function loadItems() {
  try {
    const r = await fetch(API);
    const data = r.ok ? await r.json() : null;
    if (Array.isArray(data) && data.length) items = data;
  } catch {}
  draw();
  if (ADMIN) renderList();
}

/* ---------- admin ---------- */
const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
};
const post = (path, body) => fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body || {})});

function initAdmin() {
  const statusEl = $('status'), listEl = $('list');
  const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = 'status ' + (cls || ''); };
  let saveTimer;

  function save() {
    clearTimeout(saveTimer);
    setStatus('Saving…');
    saveTimer = setTimeout(async () => {
      try {
        const r = await fetch(API, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(items)});
        if (r.status === 401) { setStatus('Session expired', 'err'); return showLogin(); }
        if (!r.ok) throw new Error(r.status);
        setStatus('Saved', 'ok');
      } catch { setStatus('Save failed', 'err'); }
    }, 500);
  }

  window.renderList = function () {
    listEl.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `<input type="color" aria-label="Color">
        <textarea rows="1" aria-label="Label"></textarea>
        <input class="w" type="number" min="1" max="100" title="Weight (chance)">
        <button class="del" title="Delete">✕</button>`;
      const [col, txt, w, del] = li.children;
      col.value = it.color; txt.value = it.label; w.value = it.weight;
      col.oninput = () => { it.color = col.value; save(); draw(); };
      const fit = () => { txt.style.height = 'auto'; txt.style.height = txt.scrollHeight + 'px'; };
      txt.oninput = () => { it.label = txt.value; fit(); save(); draw(); };
      setTimeout(fit);
      w.oninput = () => { it.weight = Math.max(1, Math.min(100, +w.value || 1)); save(); draw(); };
      del.onclick = () => { items.splice(i, 1); save(); renderList(); draw(); };
      listEl.appendChild(li);
    });
  };

  function addItem() {
    const input = $('newLabel');
    const label = input.value.trim();
    if (!label) return input.focus();
    items.push({label, color: PALETTE[Math.floor(Math.random() * PALETTE.length)], weight: 1});
    input.value = '';
    save(); renderList(); draw();
    listEl.scrollTop = listEl.scrollHeight;
  }

  $('addBtn').onclick = addItem;
  $('newLabel').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addItem(); } };
  $('shuffleBtn').onclick = () => { items.forEach(it => it.color = PALETTE[Math.floor(Math.random() * PALETTE.length)]); save(); renderList(); draw(); };
  $('resetBtn').onclick = () => { if (confirm('Reset to defaults?')) { items = DEFAULT(); save(); renderList(); draw(); } };
  $('logoutBtn').onclick = async () => { await post('/api/auth/logout'); location.reload(); };

  /* passkeys */
  async function registerPasskey(extra) {
    const o = await (await post('/api/auth/register-options', extra)).json();
    if (o.error) throw new Error(o.error);
    const cred = await navigator.credentials.create({publicKey: {
      challenge: b64u.dec(o.challenge), rp: {name: 'Roulette Admin', id: o.rpId},
      user: {id: b64u.dec(o.userId), name: 'admin', displayName: 'Admin'},
      pubKeyCredParams: [{type: 'public-key', alg: -7}, {type: 'public-key', alg: -257}],
      authenticatorSelection: {residentKey: 'preferred', userVerification: 'preferred'},
      attestation: 'none', timeout: 60000,
    }});
    const res = cred.response;
    const r = await post('/api/auth/register-verify', {...extra, challengeId: o.challengeId, credential: {
      id: cred.id, alg: res.getPublicKeyAlgorithm(), publicKey: b64u.enc(res.getPublicKey()),
      clientDataJSON: b64u.enc(res.clientDataJSON), authenticatorData: b64u.enc(res.getAuthenticatorData()),
    }});
    if (!r.ok) throw new Error((await r.json()).error || 'registration failed');
  }

  async function login() {
    const o = await (await post('/api/auth/login-options')).json();
    if (o.error) throw new Error(o.error);
    const cred = await navigator.credentials.get({publicKey: {
      challenge: b64u.dec(o.challenge), rpId: o.rpId, userVerification: 'preferred', timeout: 60000,
      allowCredentials: o.allow.map(id => ({type: 'public-key', id: b64u.dec(id)})),
    }});
    const res = cred.response;
    const r = await post('/api/auth/login-verify', {challengeId: o.challengeId, credential: {
      id: cred.id, clientDataJSON: b64u.enc(res.clientDataJSON), authenticatorData: b64u.enc(res.authenticatorData),
      signature: b64u.enc(res.signature),
    }});
    if (!r.ok) throw new Error((await r.json()).error || 'sign-in failed');
  }

  const loginMsg = $('loginMsg');
  function showLogin(hasCreds = true) {
    $('editor').hidden = true; $('login').hidden = false;
    loginMsg.textContent = hasCreds ? 'Sign in with your passkey to edit the roulette.' : 'No passkey registered yet. Register one using the setup token.';
    $('regBox').open = !hasCreds;
    $('loginBtn').hidden = !hasCreds;
  }
  function showEditor() { $('login').hidden = true; $('editor').hidden = false; setStatus('Signed in', 'ok'); renderList(); draw(); }

  $('loginBtn').onclick = async () => {
    try { await login(); showEditor(); } catch (e) { loginMsg.textContent = 'Error: ' + e.message; }
  };
  $('regBtn').onclick = async () => {
    try {
      await registerPasskey({setupToken: $('setupToken').value});
      loginMsg.textContent = 'Passkey registered. You can now sign in.';
      $('setupToken').value = ''; $('regBox').open = false; $('loginBtn').hidden = false;
    } catch (e) { loginMsg.textContent = 'Error: ' + e.message; }
  };
  $('addPasskeyBtn').onclick = async () => {
    try { await registerPasskey({}); setStatus('Passkey added', 'ok'); } catch (e) { setStatus('Error: ' + e.message, 'err'); }
  };

  (async () => {
    const me = await (await fetch('/api/auth/me')).json();
    if (me.authed) showEditor(); else showLogin(me.hasCredentials);
  })();
}

if (ADMIN) initAdmin();
loadItems();
