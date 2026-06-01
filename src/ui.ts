/**
 * Professional 3-pane chat app served at `GET /`. Zero dependencies / no build
 * step — plain HTML+CSS+JS so it works offline on the Pi.
 *
 * Panes:
 *   - left  : conversation history (list, switch, rename, delete, new chat)
 *   - center: chat (markdown, drag & drop / paste / file + image uploads)
 *   - right : artifact preview (code with copy/download + live HTML/SVG render,
 *             and images the assistant references)
 *
 * Backend: GET/POST /chat, GET /sessions, GET/PATCH/DELETE /sessions/:id.
 */
export const chatPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>jklaiagent</title>
<style>
  :root {
    --bg:#0e1014; --panel:#161922; --panel2:#1d212c; --border:#262b38;
    --text:#e9ebf0; --muted:#8b94a7; --accent:#3b82f6; --accent2:#2563eb;
    --err:#f87171; --radius:14px;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; }
  body { font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--text); display:flex; flex-direction:column; overflow:hidden; }

  header { display:flex; align-items:center; gap:12px; padding:10px 14px; background:var(--panel); border-bottom:1px solid var(--border); flex:0 0 auto; }
  header .logo { width:28px; height:28px; border-radius:8px; background:linear-gradient(135deg,var(--accent),#8b5cf6); display:grid; place-items:center; font-weight:700; font-size:14px; color:#fff; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .status { color:var(--muted); font-size:12px; }
  header .spacer { flex:1; }
  .iconbtn { border:1px solid var(--border); background:var(--panel2); color:var(--text); border-radius:10px; padding:7px 11px; font:inherit; font-size:13px; cursor:pointer; }
  .iconbtn:hover { background:#232836; }
  .iconbtn.on { background:var(--accent2); color:#fff; border-color:transparent; }
  .iconbtn .badge { display:inline-block; min-width:16px; padding:0 4px; margin-left:4px; border-radius:8px; background:rgba(255,255,255,.18); font-size:11px; line-height:16px; text-align:center; }
  .ghost { border:none; background:transparent; color:var(--muted); cursor:pointer; font-size:18px; padding:4px 8px; border-radius:8px; }
  .ghost:hover { background:#232836; color:var(--text); }

  .app { flex:1; display:flex; min-height:0; }

  /* Sidebar */
  .sidebar { width:264px; flex:0 0 264px; background:var(--panel); border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; }
  .sidebar .new { margin:12px; padding:10px; border-radius:10px; border:1px solid var(--border); background:var(--panel2); color:var(--text); font:inherit; cursor:pointer; }
  .sidebar .new:hover { background:#232836; }
  .convs { flex:1; overflow-y:auto; padding:0 8px 12px; }
  .conv { display:flex; align-items:center; gap:6px; padding:9px 10px; border-radius:9px; cursor:pointer; color:var(--text); }
  .conv:hover { background:var(--panel2); }
  .conv.active { background:var(--accent2); }
  .conv .t { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:14px; }
  .conv .act { opacity:0; border:none; background:transparent; color:inherit; cursor:pointer; font-size:13px; padding:2px 4px; border-radius:6px; }
  .conv:hover .act { opacity:.7; } .conv .act:hover { opacity:1; background:rgba(255,255,255,.12); }
  .sidebar .empty { color:var(--muted); font-size:13px; padding:12px; text-align:center; }

  /* Chat */
  .main { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; }
  main { flex:1; overflow-y:auto; }
  #chat { max-width:820px; margin:0 auto; padding:24px 16px 16px; display:flex; flex-direction:column; gap:16px; }
  .blank { color:var(--muted); text-align:center; margin-top:12vh; }
  .blank h2 { color:var(--text); font-weight:600; }
  .turn { display:flex; gap:12px; align-items:flex-start; }
  .turn.user { flex-direction:row-reverse; }
  .avatar { flex:0 0 30px; width:30px; height:30px; border-radius:8px; display:grid; place-items:center; font-size:13px; font-weight:700; }
  .user .avatar { background:var(--accent2); color:#fff; }
  .assistant .avatar { background:#2a2f3d; color:#cbd2e0; }
  .bubble { padding:12px 16px; border-radius:var(--radius); max-width:78%; }
  .user .bubble { background:var(--accent2); color:#fff; border-bottom-right-radius:4px; }
  .assistant .bubble { background:var(--panel); border:1px solid var(--border); border-bottom-left-radius:4px; }
  .bubble p:first-child { margin-top:0; } .bubble p:last-child { margin-bottom:0; }
  .bubble pre { background:#0b0d12; border:1px solid var(--border); border-radius:10px; padding:12px; overflow-x:auto; }
  .bubble code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .bubble :not(pre) > code { background:#0b0d12; padding:1px 5px; border-radius:5px; }
  .bubble a { color:#93c5fd; }
  .atts { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
  .att-img { max-width:200px; max-height:200px; border-radius:8px; display:block; }
  .att-chip { display:inline-flex; align-items:center; gap:6px; background:rgba(0,0,0,.25); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:13px; }
  .tools { font-size:12px; color:var(--muted); margin-top:6px; }
  .err { color:var(--err); font-size:13px; }
  .typing span { display:inline-block; width:6px; height:6px; margin:0 1px; background:var(--muted); border-radius:50%; animation:blink 1.2s infinite both; }
  .typing span:nth-child(2){animation-delay:.2s} .typing span:nth-child(3){animation-delay:.4s}
  @keyframes blink { 0%,80%,100%{opacity:.2} 40%{opacity:1} }

  /* Composer */
  footer { border-top:1px solid var(--border); background:var(--panel); flex:0 0 auto; }
  .composer { max-width:820px; margin:0 auto; padding:12px 16px; }
  .pending { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
  .pending:empty { display:none; }
  .pend { position:relative; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--panel2); }
  .pend img { width:64px; height:64px; object-fit:cover; display:block; }
  .pend .file { width:160px; padding:10px; font-size:12px; }
  .pend .file .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pend .file .sz { color:var(--muted); }
  .pend .x { position:absolute; top:2px; right:2px; width:20px; height:20px; border:none; border-radius:50%; background:rgba(0,0,0,.65); color:#fff; cursor:pointer; font-size:13px; line-height:1; }
  .inputrow { display:flex; align-items:flex-end; gap:8px; background:var(--panel2); border:1px solid var(--border); border-radius:var(--radius); padding:8px 8px 8px 12px; }
  .inputrow.drag { border-color:var(--accent); box-shadow:0 0 0 2px rgba(59,130,246,.25); }
  textarea { flex:1; resize:none; font:inherit; background:transparent; border:none; color:var(--text); outline:none; max-height:200px; padding:6px 0; }
  .send { border:none; background:var(--accent); color:#fff; width:40px; height:40px; border-radius:10px; cursor:pointer; font-size:18px; display:grid; place-items:center; }
  .send:disabled { opacity:.5; cursor:default; }
  .attach { border:none; background:transparent; color:var(--muted); width:36px; height:36px; border-radius:8px; cursor:pointer; font-size:18px; }
  .attach:hover { background:#232836; color:var(--text); }
  .hint { max-width:820px; margin:6px auto 0; color:var(--muted); font-size:11px; text-align:center; }

  /* Artifact panel */
  .artifact { width:0; flex:0 0 0; background:var(--panel); border-left:1px solid var(--border); display:flex; flex-direction:column; min-height:0; overflow:hidden; transition:flex-basis .15s,width .15s; }
  .artifact.open { width:420px; flex-basis:420px; }
  .art-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border); }
  .art-head .title { flex:1; font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .art-tabs { display:flex; gap:6px; flex-wrap:wrap; padding:8px 12px 0; }
  .art-tabs:empty { display:none; }
  .tab { border:1px solid var(--border); background:var(--panel2); color:var(--muted); border-radius:8px; padding:4px 9px; font:inherit; font-size:12px; cursor:pointer; }
  .tab.on { background:var(--accent2); color:#fff; border-color:transparent; }
  .art-body { flex:1; overflow:auto; padding:12px; }
  .art-body pre { margin:0; background:#0b0d12; border:1px solid var(--border); border-radius:10px; padding:12px; }
  .art-body code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; white-space:pre; }
  .art-img { max-width:100%; border-radius:8px; }
  .art-frame { width:100%; height:100%; min-height:400px; border:none; background:#fff; border-radius:8px; }

  /* Mobile */
  .backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:5; }
  @media (max-width:900px) {
    .sidebar { position:fixed; z-index:6; top:0; bottom:0; left:0; transform:translateX(-100%); transition:transform .2s; }
    .sidebar.open { transform:translateX(0); }
    .artifact.open { position:fixed; z-index:6; top:0; bottom:0; right:0; width:100%; flex-basis:100%; }
    .backdrop.show { display:block; }
  }
  @media (min-width:901px) { .hamburger { display:none; } }

  /* Settings modal */
  .settings { position:fixed; inset:0; background:rgba(0,0,0,.5); display:none; place-items:center; z-index:20; }
  .settings.open { display:grid; }
  .settings .card { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:20px; width:min(440px,92vw); }
  .settings h3 { margin:0 0 14px; }
  .settings label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
  .settings input { width:100%; padding:9px 11px; border-radius:9px; border:1px solid var(--border); background:var(--panel2); color:var(--text); font:inherit; }
  .settings .note { font-size:12px; color:var(--muted); margin-top:8px; }
  .settings .row { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
</style>
</head>
<body>
<header>
  <button class="ghost hamburger" id="hamburger" title="Conversations">☰</button>
  <div class="logo">jk</div>
  <div><h1>jklaiagent</h1><div class="status" id="status">connecting…</div></div>
  <span class="spacer"></span>
  <button class="iconbtn" id="artToggle" title="Show/hide preview panel" style="display:none">⧉ Preview<span class="badge" id="artCount">0</span></button>
  <button class="iconbtn" id="settingsBtn">⚙</button>
</header>

<div class="app">
  <aside class="sidebar" id="sidebar">
    <button class="new" id="newchat">+ New chat</button>
    <div class="convs" id="convs"></div>
  </aside>

  <section class="main">
    <main><div id="chat"></div></main>
    <footer>
      <div class="composer">
        <div class="pending" id="pending"></div>
        <div class="inputrow" id="inputrow">
          <button class="attach" id="attachBtn" title="Attach files">📎</button>
          <input type="file" id="file" multiple accept="image/*,application/pdf,.txt,.md,.csv,.json,.log,.ts,.js,.py,text/*" hidden />
          <textarea id="input" rows="1" placeholder="Message jklaiagent…  (Enter to send, Shift+Enter for newline)"></textarea>
          <button class="send" id="send" title="Send">↑</button>
        </div>
        <div class="hint">Images (vision) · PDFs · text files — drag, paste, or 📎 · up to 10 MB each</div>
      </div>
    </footer>
  </section>

  <aside class="artifact" id="artifact">
    <div class="art-head">
      <span class="title" id="artTitle">Preview</span>
      <button class="ghost" id="artPreview" title="Toggle live preview">▶</button>
      <button class="ghost" id="artCopy" title="Copy">⧉</button>
      <button class="ghost" id="artDownload" title="Download">⬇</button>
      <button class="ghost" id="artClose" title="Close">×</button>
    </div>
    <div class="art-tabs" id="artTabs"></div>
    <div class="art-body" id="artBody"></div>
  </aside>

  <div class="backdrop" id="backdrop"></div>
</div>

<div class="settings" id="settings">
  <div class="card">
    <h3>Settings</h3>
    <label for="apikey">Bearer token</label>
    <input id="apikey" type="password" placeholder="Only required if AGENT_API_KEY is set on the server" />
    <div class="note">Stored locally in this browser and sent as <code>Authorization: Bearer …</code>. Leave blank if the server has no API key.</div>
    <div class="row"><button class="iconbtn" id="settingsClose">Done</button></div>
  </div>
</div>

<script>
(function () {
  var MAX_BYTES = 10 * 1024 * 1024;
  var IMAGE_RE = /^image\\//;
  var EXT = { javascript:'js', js:'js', typescript:'ts', ts:'ts', tsx:'tsx', jsx:'jsx', python:'py', py:'py', bash:'sh', sh:'sh', shell:'sh', html:'html', xml:'xml', svg:'svg', css:'css', json:'json', yaml:'yaml', yml:'yml', sql:'sql', go:'go', rust:'rs', rs:'rs', java:'java', c:'c', cpp:'cpp', md:'md', markdown:'md' };
  var $ = function (id) { return document.getElementById(id); };

  var chat=$('chat'), input=$('input'), sendBtn=$('send'), fileInput=$('file'), pendingEl=$('pending'),
      inputrow=$('inputrow'), statusEl=$('status'), apikey=$('apikey'), settings=$('settings'),
      convsEl=$('convs'), sidebar=$('sidebar'), backdrop=$('backdrop'), panel=$('artifact'),
      artTitle=$('artTitle'), artTabs=$('artTabs'), artBody=$('artBody'),
      artToggle=$('artToggle'), artCount=$('artCount');

  var sessionId = null, pending = [], artifacts = [], active = 0;

  apikey.value = localStorage.getItem('apikey') || '';
  apikey.addEventListener('change', function () { localStorage.setItem('apikey', apikey.value); });
  $('settingsBtn').onclick = function () { settings.classList.add('open'); };
  $('settingsClose').onclick = function () { settings.classList.remove('open'); };
  settings.onclick = function (e) { if (e.target === settings) settings.classList.remove('open'); };

  function headers() { var h={'content-type':'application/json'}; var k=apikey.value.trim(); if(k) h['authorization']='Bearer '+k; return h; }
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtSize(n){ return n<1024 ? n+' B' : n<1048576 ? (n/1024).toFixed(0)+' KB' : (n/1048576).toFixed(1)+' MB'; }
  function scrollChat(){ document.querySelector('main').scrollTop = 1e9; }

  // ---------- markdown ----------
  function md(src) {
    var codes=[], inls=[];
    src = src.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, function(m,l,c){ codes.push(c); return '\\u0000CB'+(codes.length-1)+'\\u0000'; });
    src = src.replace(/\`([^\`]+)\`/g, function(m,c){ inls.push(c); return '\\u0000IC'+(inls.length-1)+'\\u0000'; });
    var h = esc(src);
    h = h.replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>');
    h = h.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
    h = h.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/^(?:[-*] .*(?:\\n|$))+/gm, function(b){ return '<ul>'+b.trim().split('\\n').map(function(l){return '<li>'+l.replace(/^[-*] /,'')+'</li>';}).join('')+'</ul>'; });
    h = h.replace(/\\n/g,'<br>');
    h = h.replace(/<br>\\s*(<\\/?(?:ul|li|h[1-3]|pre)>)/g,'$1').replace(/(<\\/?(?:ul|li|h[1-3]|pre)>)\\s*<br>/g,'$1');
    h = h.replace(/\\u0000IC(\\d+)\\u0000/g, function(m,i){ return '<code>'+esc(inls[i])+'</code>'; });
    h = h.replace(/\\u0000CB(\\d+)\\u0000/g, function(m,i){ return '<pre><code>'+esc(codes[i])+'</code></pre>'; });
    return h;
  }

  // ---------- artifacts ----------
  function extractArtifacts(text) {
    var arts=[], m;
    var re = /\`\`\`(\\w+)?\\n?([\\s\\S]*?)\`\`\`/g;
    while ((m = re.exec(text))) {
      var lang=(m[1]||'').toLowerCase(), code=m[2]||'';
      if (code.trim().length < 2) continue;
      arts.push({ kind:'code', lang:lang, code:code, title:(lang||'code'), previewing:false });
    }
    var ir = /!\\[[^\\]]*\\]\\(([^)\\s]+)\\)/g;
    while ((m = ir.exec(text))) arts.push({ kind:'image', url:m[1], title:'image' });
    return arts;
  }
  function setArtifacts(list, open) {
    artifacts = list; active = artifacts.length - 1;
    if (artifacts.length && open) panel.classList.add('open');
    renderArtifacts();
  }
  // Header toggle: visible only when the current conversation has artifacts,
  // highlighted while the panel is open. This is what lets you re-open the
  // preview after closing it to revisit code/files from any chat.
  function updateArtToggle() {
    var n = artifacts.length;
    artToggle.style.display = n ? '' : 'none';
    artCount.textContent = String(n);
    artToggle.classList.toggle('on', panel.classList.contains('open'));
  }
  function renderArtifacts() {
    if (!artifacts.length) { panel.classList.remove('open'); artBody.innerHTML=''; artTabs.innerHTML=''; artTitle.textContent='Preview'; updateArtToggle(); return; }
    if (active >= artifacts.length) active = artifacts.length - 1;
    artTabs.innerHTML='';
    if (artifacts.length > 1) artifacts.forEach(function(a,i){
      var b=document.createElement('button'); b.className='tab'+(i===active?' on':''); b.textContent=(i+1)+'. '+a.title;
      b.onclick=function(){ active=i; renderArtifacts(); }; artTabs.appendChild(b);
    });
    var a = artifacts[active];
    artTitle.textContent = a.title;
    var renderable = a.kind==='code' && (a.lang==='html'||a.lang==='svg');
    $('artPreview').style.display = renderable ? '' : 'none';
    $('artCopy').style.display = a.kind==='code' ? '' : 'none';
    $('artDownload').style.display = a.kind==='code' ? '' : 'none';
    artBody.innerHTML='';
    if (a.kind==='image') { var im=document.createElement('img'); im.className='art-img'; im.src=a.url; artBody.appendChild(im); }
    else if (a.previewing && renderable) { var f=document.createElement('iframe'); f.className='art-frame'; f.setAttribute('sandbox','allow-scripts'); f.srcdoc=a.code; artBody.appendChild(f); }
    else { var pre=document.createElement('pre'); var c=document.createElement('code'); c.textContent=a.code; pre.appendChild(c); artBody.appendChild(pre); }
    updateArtToggle();
  }
  artToggle.onclick = function(){ if(!artifacts.length) return; panel.classList.toggle('open'); updateArtToggle(); };
  $('artClose').onclick = function(){ panel.classList.remove('open'); updateArtToggle(); };
  $('artPreview').onclick = function(){ var a=artifacts[active]; if(a){ a.previewing=!a.previewing; renderArtifacts(); } };
  $('artCopy').onclick = function(){ var a=artifacts[active]; if(a&&navigator.clipboard) navigator.clipboard.writeText(a.code); };
  $('artDownload').onclick = function(){ var a=artifacts[active]; if(!a) return; var ext=EXT[a.lang]||'txt'; var blob=new Blob([a.code],{type:'text/plain'}); var url=URL.createObjectURL(blob); var el=document.createElement('a'); el.href=url; el.download='artifact.'+ext; el.click(); setTimeout(function(){URL.revokeObjectURL(url);},1000); };

  // ---------- chat rendering ----------
  function blank(){ chat.innerHTML='<div class="blank"><h2>Start a conversation</h2><div>Type a message, drag in a file, or paste an image.</div></div>'; }
  function userTurn(opts){
    var t=document.createElement('div'); t.className='turn user';
    var a=document.createElement('div'); a.className='avatar'; a.textContent='You';
    var b=document.createElement('div'); b.className='bubble';
    if ((opts.images&&opts.images.length)||(opts.files&&opts.files.length)) {
      var w=document.createElement('div'); w.className='atts';
      (opts.images||[]).forEach(function(src){ var im=document.createElement('img'); im.className='att-img'; im.src=src; w.appendChild(im); });
      (opts.files||[]).forEach(function(nm){ var c=document.createElement('span'); c.className='att-chip'; c.textContent='📄 '+nm; w.appendChild(c); });
      b.appendChild(w);
    }
    if (opts.text) { var p=document.createElement('div'); p.textContent=opts.text; b.appendChild(p); }
    t.appendChild(a); t.appendChild(b); chat.appendChild(t); scrollChat();
  }
  function assistantTurn(){
    var t=document.createElement('div'); t.className='turn assistant';
    var a=document.createElement('div'); a.className='avatar'; a.textContent='AI';
    var b=document.createElement('div'); b.className='bubble';
    t.appendChild(a); t.appendChild(b); chat.appendChild(t); scrollChat();
    return b;
  }
  function fillAssistant(bubble, text, tools){
    bubble.innerHTML = md(text || '(empty reply)');
    if (tools && tools.length) { var d=document.createElement('div'); d.className='tools'; d.textContent='🔧 used: '+tools.join(', '); bubble.appendChild(d); }
  }

  // ---------- sessions ----------
  function loadSessions(){
    fetch('sessions',{headers:headers()}).then(function(r){return r.json();}).then(function(j){ renderConvs(j.sessions||[]); }).catch(function(){});
  }
  function renderConvs(list){
    convsEl.innerHTML='';
    if (!list.length) { convsEl.innerHTML='<div class="empty">No conversations yet</div>'; return; }
    list.forEach(function(c){
      var row=document.createElement('div'); row.className='conv'+(c.id===sessionId?' active':'');
      var t=document.createElement('div'); t.className='t'; t.textContent=c.title||'Untitled';
      var ren=document.createElement('button'); ren.className='act'; ren.textContent='✎'; ren.title='Rename';
      ren.onclick=function(e){ e.stopPropagation(); var nt=prompt('Rename conversation', c.title||''); if(nt&&nt.trim()){ fetch('sessions/'+c.id,{method:'PATCH',headers:headers(),body:JSON.stringify({title:nt.trim()})}).then(loadSessions); } };
      var del=document.createElement('button'); del.className='act'; del.textContent='🗑'; del.title='Delete';
      del.onclick=function(e){ e.stopPropagation(); if(!confirm('Delete this conversation?')) return; fetch('sessions/'+c.id,{method:'DELETE',headers:headers()}).then(function(){ if(c.id===sessionId) newChat(); loadSessions(); }); };
      row.appendChild(t); row.appendChild(ren); row.appendChild(del);
      row.onclick=function(){ openSession(c.id); closeMobile(); };
      convsEl.appendChild(row);
    });
  }
  function openSession(id){
    fetch('sessions/'+id,{headers:headers()}).then(function(r){return r.json();}).then(function(j){
      sessionId=id; chat.innerHTML='';
      var allArts=[];
      (j.transcript||[]).forEach(function(turn){
        if (turn.role==='user') userTurn({text:turn.text, images:turn.images, files:turn.files});
        else { var b=assistantTurn(); fillAssistant(b, turn.text, turn.tools); allArts=allArts.concat(extractArtifacts(turn.text)); }
      });
      setArtifacts(allArts, false);
      loadSessions(); // refresh active highlight
      scrollChat();
    });
  }
  function newChat(){ sessionId=null; pending=[]; renderPending(); blank(); setArtifacts([], false); loadSessions(); input.focus(); }

  // ---------- uploads ----------
  function renderPending(){
    pendingEl.innerHTML='';
    pending.forEach(function(p,idx){
      var w=document.createElement('div'); w.className='pend';
      if (p.preview){ var im=document.createElement('img'); im.src=p.preview; w.appendChild(im); }
      else { var f=document.createElement('div'); f.className='file'; f.innerHTML='<div class="nm">'+esc(p.name)+'</div><div class="sz">'+fmtSize(p.size)+'</div>'; w.appendChild(f); }
      var x=document.createElement('button'); x.className='x'; x.textContent='×'; x.onclick=function(){ pending.splice(idx,1); renderPending(); };
      w.appendChild(x); pendingEl.appendChild(w);
    });
  }
  function addFiles(files){
    Array.prototype.forEach.call(files, function(file){
      if (file.size>MAX_BYTES){ alert('"'+file.name+'" is '+fmtSize(file.size)+' — over the 10 MB limit.'); return; }
      var reader=new FileReader();
      reader.onload=function(){ var res=String(reader.result); var b64=res.split(',')[1]||''; var mt=file.type||'text/plain';
        pending.push({ name:file.name||'file', mediaType:mt, data:b64, size:file.size, preview:IMAGE_RE.test(mt)?res:null }); renderPending(); };
      reader.readAsDataURL(file);
    });
  }
  $('attachBtn').onclick=function(){ fileInput.click(); };
  fileInput.onchange=function(){ addFiles(fileInput.files); fileInput.value=''; };
  ['dragenter','dragover'].forEach(function(ev){ inputrow.addEventListener(ev,function(e){ e.preventDefault(); inputrow.classList.add('drag'); }); });
  ['dragleave','drop'].forEach(function(ev){ inputrow.addEventListener(ev,function(e){ e.preventDefault(); inputrow.classList.remove('drag'); }); });
  inputrow.addEventListener('drop',function(e){ if(e.dataTransfer&&e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  input.addEventListener('paste',function(e){ var items=e.clipboardData&&e.clipboardData.items; if(!items) return; var imgs=[]; for(var i=0;i<items.length;i++){ if(items[i].kind==='file'){ var f=items[i].getAsFile(); if(f) imgs.push(f); } } if(imgs.length){ e.preventDefault(); addFiles(imgs); } });

  // ---------- composer ----------
  input.addEventListener('input',function(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,200)+'px'; });
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
  sendBtn.onclick=send;
  $('newchat').onclick=function(){ newChat(); closeMobile(); };

  function send(){
    var text=input.value.trim();
    if (!text && pending.length===0) return;
    var atts=pending.slice();
    var blankEl=chat.querySelector('.blank'); if(blankEl) blankEl.remove();
    userTurn({ text:text, images:atts.filter(function(p){return p.preview;}).map(function(p){return p.preview;}), files:atts.filter(function(p){return !p.preview;}).map(function(p){return p.name;}) });
    input.value=''; input.style.height='auto'; pending=[]; renderPending(); sendBtn.disabled=true;
    var rb=assistantTurn(); rb.innerHTML='<span class="typing"><span></span><span></span><span></span></span>';

    var payload={ message:text };
    if (sessionId) payload.sessionId=sessionId;
    if (atts.length) payload.attachments=atts.map(function(p){ return {name:p.name,mediaType:p.mediaType,data:p.data}; });

    fetch('chat',{method:'POST',headers:headers(),body:JSON.stringify(payload)})
      .then(function(res){ return res.json().then(function(j){ return {ok:res.ok,status:res.status,j:j}; }); })
      .then(function(r){
        if (!r.ok){ rb.innerHTML='<span class="err">Error '+r.status+': '+esc(r.j.detail||r.j.error||'request failed')+'</span>'; return; }
        var isNew = !sessionId;
        sessionId=r.j.sessionId;
        fillAssistant(rb, r.j.reply, r.j.toolsUsed);
        var arts=extractArtifacts(r.j.reply||''); if(arts.length) setArtifacts(artifacts.concat(arts), true);
        loadSessions();
      })
      .catch(function(err){ rb.innerHTML='<span class="err">Network error: '+esc(err.message)+'</span>'; })
      .finally(function(){ sendBtn.disabled=false; input.focus(); scrollChat(); });
  }

  // ---------- mobile ----------
  function closeMobile(){ sidebar.classList.remove('open'); backdrop.classList.remove('show'); }
  $('hamburger').onclick=function(){ var o=sidebar.classList.toggle('open'); backdrop.classList.toggle('show',o); };
  backdrop.onclick=closeMobile;

  // Esc backs out of whatever overlay is open: settings → preview panel → mobile sidebar.
  document.addEventListener('keydown',function(e){
    if (e.key!=='Escape') return;
    if (settings.classList.contains('open')) { settings.classList.remove('open'); }
    else if (panel.classList.contains('open')) { panel.classList.remove('open'); updateArtToggle(); }
    else if (sidebar.classList.contains('open')) { closeMobile(); }
  });

  // ---------- init ----------
  fetch('health',{headers:headers()}).then(function(r){return r.json();})
    .then(function(j){ statusEl.textContent=j.model+' · tools: '+(j.tools||[]).join(', '); })
    .catch(function(){ statusEl.textContent='agent unreachable'; });
  blank(); loadSessions(); input.focus();
})();
</script>
</body>
</html>`;
