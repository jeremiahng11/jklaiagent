/**
 * Professional single-page chat UI served at `GET /`. Zero dependencies / no
 * build step — plain HTML+CSS+JS so it works offline on the Pi.
 *
 * Features: streamed-feel send, markdown rendering, drag & drop + paste image,
 * file/image attachments with previews, conversation memory via sessionId, and
 * an optional bearer-token settings panel (stored in localStorage).
 */
export const chatPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>jklaiagent</title>
<style>
  :root {
    --bg: #0e1014; --panel: #161922; --panel2: #1d212c; --border: #262b38;
    --text: #e9ebf0; --muted: #8b94a7; --accent: #3b82f6; --accent2: #2563eb;
    --err: #f87171; --radius: 14px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); display: flex; flex-direction: column; }

  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
  header .logo { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, var(--accent), #8b5cf6); display: grid; place-items: center; font-weight: 700; font-size: 14px; color: #fff; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .status { color: var(--muted); font-size: 12px; }
  header .spacer { flex: 1; }
  .iconbtn { border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 10px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  .iconbtn:hover { background: #232836; }

  main { flex: 1; overflow-y: auto; }
  #chat { max-width: 820px; margin: 0 auto; padding: 24px 16px 16px; display: flex; flex-direction: column; gap: 16px; }
  .empty { color: var(--muted); text-align: center; margin-top: 12vh; }
  .empty h2 { color: var(--text); font-weight: 600; }

  .turn { display: flex; gap: 12px; align-items: flex-start; }
  .turn.user { flex-direction: row-reverse; }
  .avatar { flex: 0 0 30px; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; font-size: 13px; font-weight: 700; }
  .user .avatar { background: var(--accent2); color: #fff; }
  .assistant .avatar { background: #2a2f3d; color: #cbd2e0; }
  .bubble { padding: 12px 16px; border-radius: var(--radius); max-width: 78%; }
  .user .bubble { background: var(--accent2); color: #fff; border-bottom-right-radius: 4px; }
  .assistant .bubble { background: var(--panel); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
  .bubble p:first-child { margin-top: 0; } .bubble p:last-child { margin-bottom: 0; }
  .bubble pre { background: #0b0d12; border: 1px solid var(--border); border-radius: 10px; padding: 12px; overflow-x: auto; }
  .bubble code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .bubble :not(pre) > code { background: #0b0d12; padding: 1px 5px; border-radius: 5px; }
  .bubble a { color: #93c5fd; }
  .atts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .att-img { max-width: 200px; max-height: 200px; border-radius: 8px; display: block; }
  .att-chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(0,0,0,.25); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  .tools { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .err { color: var(--err); font-size: 13px; }
  .typing span { display: inline-block; width: 6px; height: 6px; margin: 0 1px; background: var(--muted); border-radius: 50%; animation: blink 1.2s infinite both; }
  .typing span:nth-child(2){animation-delay:.2s} .typing span:nth-child(3){animation-delay:.4s}
  @keyframes blink { 0%,80%,100%{opacity:.2} 40%{opacity:1} }

  footer { border-top: 1px solid var(--border); background: var(--panel); }
  .composer { max-width: 820px; margin: 0 auto; padding: 12px 16px; }
  .pending { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .pending:empty { display: none; }
  .pend { position: relative; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--panel2); }
  .pend img { width: 64px; height: 64px; object-fit: cover; display: block; }
  .pend .file { width: 160px; padding: 10px; font-size: 12px; }
  .pend .file .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pend .file .sz { color: var(--muted); }
  .pend .x { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; border: none; border-radius: 50%; background: rgba(0,0,0,.65); color: #fff; cursor: pointer; font-size: 13px; line-height: 1; }
  .inputrow { display: flex; align-items: flex-end; gap: 8px; background: var(--panel2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 8px 8px 12px; }
  .inputrow.drag { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(59,130,246,.25); }
  textarea { flex: 1; resize: none; font: inherit; background: transparent; border: none; color: var(--text); outline: none; max-height: 200px; padding: 6px 0; }
  .send { border: none; background: var(--accent); color: #fff; width: 40px; height: 40px; border-radius: 10px; cursor: pointer; font-size: 18px; display: grid; place-items: center; }
  .send:disabled { opacity: .5; cursor: default; }
  .attach { border: none; background: transparent; color: var(--muted); width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 18px; }
  .attach:hover { background: #232836; color: var(--text); }
  .hint { max-width: 820px; margin: 6px auto 0; color: var(--muted); font-size: 11px; text-align: center; }

  .settings { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; place-items: center; z-index: 10; }
  .settings.open { display: grid; }
  .settings .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; width: min(440px, 92vw); }
  .settings h3 { margin: 0 0 14px; }
  .settings label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  .settings input { width: 100%; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--border); background: var(--panel2); color: var(--text); font: inherit; }
  .settings .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .settings .note { font-size: 12px; color: var(--muted); margin-top: 8px; }
</style>
</head>
<body>
<header>
  <div class="logo">jk</div>
  <div>
    <h1>jklaiagent</h1>
    <div class="status" id="status">connecting…</div>
  </div>
  <span class="spacer"></span>
  <button class="iconbtn" id="settingsBtn">⚙ Settings</button>
  <button class="iconbtn" id="newchat">+ New chat</button>
</header>

<main><div id="chat"><div class="empty" id="empty"><h2>Start a conversation</h2><div>Type a message, drag in a file, or paste an image.</div></div></div></main>

<footer>
  <div class="composer">
    <div class="pending" id="pending"></div>
    <div class="inputrow" id="inputrow">
      <button class="attach" id="attachBtn" title="Attach files">📎</button>
      <input type="file" id="file" multiple accept="image/*,application/pdf,.txt,.md,.csv,.json,.log,.ts,.js,.py,text/*" hidden />
      <textarea id="input" rows="1" placeholder="Message jklaiagent…  (Enter to send, Shift+Enter for newline)"></textarea>
      <button class="send" id="send" title="Send">↑</button>
    </div>
    <div class="hint">Supports images (vision), PDFs, and text files · up to 10 MB each</div>
  </div>
</footer>

<div class="settings" id="settings">
  <div class="card">
    <h3>Settings</h3>
    <label for="apikey">Bearer token</label>
    <input id="apikey" type="password" placeholder="Only required if AGENT_API_KEY is set on the server" />
    <div class="note">Stored locally in this browser and sent as <code>Authorization: Bearer …</code>. Leave blank if the server has no API key.</div>
    <div class="row">
      <button class="iconbtn" id="settingsClose">Done</button>
    </div>
  </div>
</div>

<script>
(function () {
  var MAX_BYTES = 10 * 1024 * 1024;
  var IMAGE_RE = /^image\\//;
  var chat = document.getElementById('chat');
  var emptyEl = document.getElementById('empty');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var fileInput = document.getElementById('file');
  var pendingEl = document.getElementById('pending');
  var inputrow = document.getElementById('inputrow');
  var statusEl = document.getElementById('status');
  var apikey = document.getElementById('apikey');
  var settings = document.getElementById('settings');
  var sessionId = sessionStorage.getItem('sessionId') || null;
  var pending = []; // { name, mediaType, data(base64), preview, size }

  apikey.value = localStorage.getItem('apikey') || '';
  apikey.addEventListener('change', function () { localStorage.setItem('apikey', apikey.value); });
  document.getElementById('settingsBtn').onclick = function () { settings.classList.add('open'); };
  document.getElementById('settingsClose').onclick = function () { settings.classList.remove('open'); };
  settings.onclick = function (e) { if (e.target === settings) settings.classList.remove('open'); };

  function headers() {
    var h = { 'content-type': 'application/json' };
    var k = apikey.value.trim();
    if (k) h['authorization'] = 'Bearer ' + k;
    return h;
  }
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(0)+' KB' : (n/1048576).toFixed(1)+' MB'; }

  function md(src) {
    var codes = [], inls = [];
    src = src.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, function (m, l, c) { codes.push(c); return '\\u0000CB' + (codes.length-1) + '\\u0000'; });
    src = src.replace(/\`([^\`]+)\`/g, function (m, c) { inls.push(c); return '\\u0000IC' + (inls.length-1) + '\\u0000'; });
    var h = esc(src);
    h = h.replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>');
    h = h.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
    h = h.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/^(?:[-*] .*(?:\\n|$))+/gm, function (b) {
      var items = b.trim().split('\\n').map(function (l) { return '<li>' + l.replace(/^[-*] /,'') + '</li>'; }).join('');
      return '<ul>' + items + '</ul>';
    });
    h = h.replace(/\\n/g,'<br>');
    h = h.replace(/<br>\\s*(<\\/?(?:ul|li|h[1-3]|pre)>)/g,'$1').replace(/(<\\/?(?:ul|li|h[1-3]|pre)>)\\s*<br>/g,'$1');
    h = h.replace(/\\u0000IC(\\d+)\\u0000/g, function (m, i) { return '<code>' + esc(inls[i]) + '</code>'; });
    h = h.replace(/\\u0000CB(\\d+)\\u0000/g, function (m, i) { return '<pre><code>' + esc(codes[i]) + '</code></pre>'; });
    return h;
  }

  function turn(role) {
    if (emptyEl) { emptyEl.remove(); emptyEl = null; }
    var t = document.createElement('div'); t.className = 'turn ' + role;
    var a = document.createElement('div'); a.className = 'avatar'; a.textContent = role === 'user' ? 'You' : 'AI';
    var b = document.createElement('div'); b.className = 'bubble';
    t.appendChild(a); t.appendChild(b); chat.appendChild(t);
    document.querySelector('main').scrollTop = 1e9;
    return b;
  }

  function renderPending() {
    pendingEl.innerHTML = '';
    pending.forEach(function (p, idx) {
      var w = document.createElement('div'); w.className = 'pend';
      if (p.preview) { var im = document.createElement('img'); im.src = p.preview; w.appendChild(im); }
      else { var f = document.createElement('div'); f.className = 'file'; f.innerHTML = '<div class="nm">' + esc(p.name) + '</div><div class="sz">' + fmtSize(p.size) + '</div>'; w.appendChild(f); }
      var x = document.createElement('button'); x.className = 'x'; x.textContent = '×';
      x.onclick = function () { pending.splice(idx, 1); renderPending(); };
      w.appendChild(x); pendingEl.appendChild(w);
    });
  }

  function addFiles(files) {
    Array.prototype.forEach.call(files, function (file) {
      if (file.size > MAX_BYTES) { alert('"' + file.name + '" is ' + fmtSize(file.size) + ' — over the 10 MB limit.'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var res = String(reader.result); var base64 = res.split(',')[1] || '';
        var mt = file.type || 'text/plain';
        pending.push({ name: file.name || 'file', mediaType: mt, data: base64, size: file.size, preview: IMAGE_RE.test(mt) ? res : null });
        renderPending();
      };
      reader.readAsDataURL(file);
    });
  }

  document.getElementById('attachBtn').onclick = function () { fileInput.click(); };
  fileInput.onchange = function () { addFiles(fileInput.files); fileInput.value = ''; };

  ['dragenter','dragover'].forEach(function (ev) { inputrow.addEventListener(ev, function (e) { e.preventDefault(); inputrow.classList.add('drag'); }); });
  ['dragleave','drop'].forEach(function (ev) { inputrow.addEventListener(ev, function (e) { e.preventDefault(); inputrow.classList.remove('drag'); }); });
  inputrow.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  input.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    var imgs = [];
    for (var i = 0; i < items.length; i++) { if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) imgs.push(f); } }
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  });

  input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  sendBtn.onclick = send;

  document.getElementById('newchat').onclick = function () {
    sessionId = null; sessionStorage.removeItem('sessionId');
    chat.innerHTML = '<div class="empty"><h2>Start a conversation</h2><div>Type a message, drag in a file, or paste an image.</div></div>';
    emptyEl = chat.firstChild; input.focus();
  };

  function send() {
    var text = input.value.trim();
    if (!text && pending.length === 0) return;
    var atts = pending.slice();

    var b = turn('user');
    if (atts.length) {
      var wrap = document.createElement('div'); wrap.className = 'atts';
      atts.forEach(function (p) {
        if (p.preview) { var im = document.createElement('img'); im.className = 'att-img'; im.src = p.preview; wrap.appendChild(im); }
        else { var c = document.createElement('span'); c.className = 'att-chip'; c.textContent = '📄 ' + p.name; wrap.appendChild(c); }
      });
      b.appendChild(wrap);
    }
    if (text) { var p = document.createElement('div'); p.textContent = text; b.appendChild(p); }

    input.value = ''; input.style.height = 'auto'; pending = []; renderPending();
    sendBtn.disabled = true;

    var rb = turn('assistant'); rb.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';

    var payload = { message: text };
    if (sessionId) payload.sessionId = sessionId;
    if (atts.length) payload.attachments = atts.map(function (p) { return { name: p.name, mediaType: p.mediaType, data: p.data }; });

    fetch('chat', { method: 'POST', headers: headers(), body: JSON.stringify(payload) })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, status: res.status, j: j }; }); })
      .then(function (r) {
        if (!r.ok) { rb.innerHTML = '<span class="err">Error ' + r.status + ': ' + esc(r.j.detail || r.j.error || 'request failed') + '</span>'; return; }
        sessionId = r.j.sessionId; sessionStorage.setItem('sessionId', sessionId);
        rb.innerHTML = md(r.j.reply || '(empty reply)');
        if (r.j.toolsUsed && r.j.toolsUsed.length) { var t = document.createElement('div'); t.className = 'tools'; t.textContent = '🔧 used: ' + r.j.toolsUsed.join(', '); rb.appendChild(t); }
      })
      .catch(function (err) { rb.innerHTML = '<span class="err">Network error: ' + esc(err.message) + '</span>'; })
      .finally(function () { sendBtn.disabled = false; input.focus(); document.querySelector('main').scrollTop = 1e9; });
  }

  fetch('health', { headers: headers() })
    .then(function (r) { return r.json(); })
    .then(function (j) { statusEl.textContent = j.model + ' · tools: ' + (j.tools || []).join(', '); })
    .catch(function () { statusEl.textContent = 'agent unreachable'; });
  input.focus();
})();
</script>
</body>
</html>`;
