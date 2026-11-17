import { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { AudioLines, Blocks, ChevronRight, CircleHelp, Clapperboard, Clock3, Image as ImageIcon, LayoutDashboard, LogOut, Menu, Music2, Plus, Settings2, Sparkles, WandSparkles, X } from 'lucide-react';

const initialStyle = 'Cinematic';
const styles = ['Cinematic','Anime','Realistic','Fantasy','Watercolor','3D Animation','Noir','Custom'];
const cx = (...v) => v.filter(Boolean).join(' ');


function splitLyricsIntoChunks(text, maxLines = 8) {
  const chunks = [];
  let current = [];
  let count = 0;
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[.*\]$/.test(line)) {
      section = line;
      current.push(line);
      continue;
    }
    if (count >= maxLines) {
      chunks.push(current.join('\n'));
      current = section ? [section] : [];
      count = 0;
    }
    current.push(line);
    count++;
  }
  if (current.some(line => line.trim() && !/^\[.*\]$/.test(line.trim()))) chunks.push(current.join('\n'));
  return chunks;
}

function App() {
  const [session,setSession] = useState(null);
  const [projects,setProjects] = useState([]);
  const [active,setActive] = useState('Dashboard');
  const [selected,setSelected] = useState(null);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [authMode,setAuthMode] = useState('login');
  const [email,setEmail] = useState('');
  const [password,setPassword] = useState('');
  const [showCreate,setShowCreate] = useState(false);
  const [title,setTitle] = useState('');
  const [lyrics,setLyrics] = useState('');
  const [visualStyle,setVisualStyle] = useState(initialStyle);
  const [ratio,setRatio] = useState('16:9');
  const [idea,setIdea] = useState('');
  const [assets,setAssets] = useState([]);
  const [pipelineMessage,setPipelineMessage] = useState('');
  const [gallery,setGallery] = useState([]);
  const [audioFile,setAudioFile] = useState(null);
  const [rendering,setRendering] = useState(false);
  const [renderProgress,setRenderProgress] = useState('');

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    supabase.auth.getSession().then(({data}) => setSession(data.session));
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_event,s) => setSession(s));
    return () => subscription.unsubscribe();
  },[]);
  useEffect(() => {
    if (!session || !supabase) { setProjects([]); setLoading(false); return; }
    loadProjects();
  },[session]);
  async function loadProjects() {
    setLoading(true);
    const {data,error} = await supabase.from('projects').select('*').order('created_at',{ascending:false});
    if(error) setNotice(error.message); else setProjects(data || []);
    setLoading(false);
  }
  async function signIn(e) {
    e.preventDefault(); setBusy(true); setNotice('');
    const fn = authMode === 'login' ? supabase.auth.signInWithPassword({email,password}) : supabase.auth.signUp({email,password});
    const {error} = await fn;
    setNotice(error ? error.message : (authMode === 'login' ? 'Berhasil masuk.' : 'Akun dibuat. Periksa email jika konfirmasi diaktifkan.'));
    setBusy(false);
  }
  async function createProject(e) {
    e.preventDefault(); if(!title.trim()) return;
    setBusy(true); setNotice('');
    const {data,error} = await supabase.from('projects').insert({user_id:session.user.id,title:title.trim(),lyrics,visual_style:visualStyle.toLowerCase(),image_ratio:ratio,status:'draft'}).select().single();
    if(error) setNotice(error.message); else { setProjects(p=>[data,...p]); setSelected(data); setShowCreate(false); setTitle(''); setLyrics(''); setActive('Proyek Lagu'); }
    setBusy(false);
  }
  async function saveLyrics() {
    if(!selected) return;
    setBusy(true);
    const {data,error} = await supabase.from('projects').update({lyrics,updated_at:new Date().toISOString()}).eq('id',selected.id).select().single();
    if(error) setNotice(error.message); else { setSelected(data); setProjects(p=>p.map(x=>x.id===data.id?data:x)); setNotice('Lirik berhasil disimpan.'); }
    setBusy(false);
  }
  async function signOut(){ await supabase.auth.signOut(); setSelected(null); }
  async function loadAssets(projectId) {
    if (!projectId) { setAssets([]); return; }
    const {data: prompts,error} = await supabase.from('image_prompts').select('*').eq('project_id',projectId).order('created_at',{ascending:true});
    if (error) { setNotice(error.message); return; }
    const {data: lines} = await supabase.from('lyric_lines').select('*').eq('project_id',projectId).order('line_number',{ascending:true});
    const {data: images} = await supabase.from('generated_images').select('*').eq('project_id',projectId).eq('status','completed');
    const rows = await Promise.all((prompts||[]).map(async p => {
      const line = (lines||[]).find(x=>x.id===p.lyric_line_id);
      const image = (images||[]).find(x=>x.prompt_id===p.id);
      let imageUrl = null;
      if (image?.storage_path) { const {data:signed} = await supabase.storage.from('music-studio-images').createSignedUrl(image.storage_path,3600); imageUrl = signed?.signedUrl || null; }
      return {...p,lyric_line:line,image,imageUrl};
    }));
    setAssets(rows);
  }
  async function runStudio(action,payload) {
    const {data,error} = await supabase.functions.invoke('studio-ai',{body:{action,...payload}});
    if (error) {
      let detail = error.message || 'Tidak dapat menghubungi backend AI.';
      try {
        const response = error.context;
        if (response && typeof response.json === 'function') {
          const body = await response.json();
          if (body?.error) detail = body.error;
        }
      } catch {}
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  async function generateLyrics() {
    if (!selected || !idea.trim()) { setNotice('Tuliskan ide atau tema lagu terlebih dahulu.'); return; }
    setBusy(true); setNotice('GPT melalui DataByte sedang menulis lirik…');
    try {
      const result = await runStudio('generate_lyrics',{project_id:selected.id,idea:idea.trim()});
      setLyrics(result.lyrics);
      const updated = {...selected,lyrics:result.lyrics,description:idea.trim()};
      setSelected(updated); setProjects(p=>p.map(x=>x.id===updated.id?updated:x));
      setNotice('Lirik berhasil dibuat melalui DataByte GPT. Periksa dan edit sebelum membuat visual.');
    } catch(e) { setNotice(e.message); } finally { setBusy(false); }
  }
  async function generateVisuals() {
    if (!selected) return;
    if (!lyrics.trim()) { setNotice('Tambahkan lirik terlebih dahulu.'); return; }
    setBusy(true); setPipelineMessage('Menyimpan lirik dan membuat prompt visual…'); setNotice('');
    try {
      const {data:saved,error:saveError} = await supabase.from('projects').update({lyrics,updated_at:new Date().toISOString()}).eq('id',selected.id).select().single();
      if (saveError) throw saveError;
      setSelected(saved); setProjects(p=>p.map(x=>x.id===saved.id?saved:x));
      const lyricChunks = splitLyricsIntoChunks(lyrics, 8);
      if (!lyricChunks.length) throw new Error('Tidak ditemukan baris lirik.');
      let allPrompts = [];
      let lineOffset = 0;
      for (let i = 0; i < lyricChunks.length; i++) {
        setPipelineMessage('Membuat prompt visual bagian ' + (i + 1) + ' dari ' + lyricChunks.length + '…');
        const part = await runStudio('create_prompts',{
          project_id:selected.id,
          lyrics_chunk:lyricChunks[i],
          line_offset:lineOffset,
          replace_existing:i === 0
        });
        allPrompts = allPrompts.concat(part.prompts || []);
        lineOffset += lyricChunks[i].split(/\r?\n/).filter(line => line.trim() && !/^\[.*\]$/.test(line.trim())).length;
      }
      await loadAssets(selected.id);
      await loadProjects();
      setPipelineMessage('');
      setNotice('Berhasil! '+allPrompts.length+' prompt visual siap. Salin prompt, buat gambar di aplikasi Gemini, lalu unggah hasilnya ke studio.');
    } catch(e) { setPipelineMessage(''); setNotice(e.message); } finally { setBusy(false); }
  }
  async function copyAllPrompts() {
    const ordered = [...assets].sort((a,b)=>(a.lyric_line?.line_number||0)-(b.lyric_line?.line_number||0));
    if (!ordered.length) { setNotice('Buat prompt visual terlebih dahulu.'); return; }
    const text = ordered.map(item => {
      const line = item.lyric_line?.line_number || '—';
      const lyric = item.lyric_line?.lyric_text || '';
      return 'BARIS '+line+': '+lyric+'\nPROMPT: '+item.prompt_text+(item.negative_prompt?'\nNEGATIVE PROMPT: '+item.negative_prompt:'');
    }).join('\n\n---\n\n');
    try { await navigator.clipboard.writeText(text); setNotice(ordered.length+' prompt berhasil disalin. Tempel satu per satu di Gemini.'); }
    catch { setNotice('Clipboard tidak dapat diakses. Gunakan tombol Salin Prompt pada setiap baris.'); }
  }
  async function copyOnePrompt(item) {
    const text = item.prompt_text + (item.negative_prompt ? '\nNegative prompt: '+item.negative_prompt : '');
    try { await navigator.clipboard.writeText(text); setNotice('Prompt baris '+(item.lyric_line?.line_number||'')+' berhasil disalin.'); }
    catch { setNotice('Tidak dapat menyalin prompt dari browser ini.'); }
  }
  async function uploadGeminiImages(fileList) {
    const files = Array.from(fileList || []).filter(file => file.type.startsWith('image/'));
    if (!files.length || !selected) return;
    const pending = [...assets].filter(item => !item.image).sort((a,b)=>(a.lyric_line?.line_number||0)-(b.lyric_line?.line_number||0));
    if (!pending.length) { setNotice('Semua baris sudah memiliki gambar.'); return; }
    if (files.length > pending.length) { setNotice('Jumlah gambar melebihi prompt yang belum memiliki gambar ('+pending.length+'). Upload sebagian dahulu.'); return; }
    setBusy(true);
    let uploaded = 0;
    try {
      for (let i=0;i<files.length;i++) {
        const file = files[i];
        const item = pending[i];
        setPipelineMessage('Mengunggah gambar '+(i+1)+' dari '+files.length+' — untuk baris '+(item.lyric_line?.line_number||'')+'…');
        const extension = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g,'') || 'png';
        const path = session.user.id+'/'+selected.id+'/'+item.lyric_line_id+'.'+extension;
        const {error:uploadError} = await supabase.storage.from('music-studio-images').upload(path,file,{contentType:file.type,upsert:true});
        if (uploadError) throw uploadError;
        const {data:existing,error:lookupError} = await supabase.from('generated_images').select('id').eq('prompt_id',item.id).eq('user_id',session.user.id).maybeSingle();
        if (lookupError) throw lookupError;
        const row = {project_id:selected.id,lyric_line_id:item.lyric_line_id,prompt_id:item.id,user_id:session.user.id,storage_path:path,public_url:null,model:'gemini-app-manual',status:'completed',error_message:null};
        const saved = existing?.id
          ? await supabase.from('generated_images').update(row).eq('id',existing.id)
          : await supabase.from('generated_images').insert(row);
        if (saved.error) throw saved.error;
        const {error:promptError} = await supabase.from('image_prompts').update({status:'completed',error_message:null,updated_at:new Date().toISOString()}).eq('id',item.id).eq('user_id',session.user.id);
        if (promptError) throw promptError;
        uploaded++;
      }
      const {count:remaining,error:countError} = await supabase.from('image_prompts').select('id',{count:'exact',head:true}).eq('project_id',selected.id).eq('user_id',session.user.id).neq('status','completed');
      if (countError) throw countError;
      if ((remaining ?? 0) === 0) await supabase.from('projects').update({status:'completed',updated_at:new Date().toISOString()}).eq('id',selected.id).eq('user_id',session.user.id);
      await loadAssets(selected.id);
      await loadProjects();
      setNotice(uploaded+' gambar dari Gemini berhasil disimpan dan dicocokkan dengan urutan lirik.');
    } catch(e) {
      await loadAssets(selected.id);
      setNotice('Upload gambar gagal: '+(e.message || 'Terjadi kesalahan.'));
    } finally {
      setPipelineMessage('');
      setBusy(false);
    }
  }
  function openGemini() {
    window.open('https://gemini.google.com/app','_blank','noopener,noreferrer');
  }
  async function retryImage(promptId) {
    setAssets(rows=>rows.map(x=>x.id===promptId?{...x,status:'processing',error_message:null}:x));
    try { await runStudio('generate_image',{prompt_id:promptId}); await loadAssets(selected?.id); await loadProjects(); }
    catch(e) { setNotice(e.message); await loadAssets(selected?.id); }
  }
  async function loadGallery() {
    if (!session) return;
    const {data:rows,error} = await supabase.from('generated_images').select('id,project_id,lyric_line_id,prompt_id,storage_path,model,created_at').eq('user_id',session.user.id).eq('status','completed').order('created_at',{ascending:false});
    if (error) { setNotice(error.message); return; }
    const items = await Promise.all((rows||[]).map(async row=>{
      const [{data:signed},{data:line},{data:project}] = await Promise.all([
        supabase.storage.from('music-studio-images').createSignedUrl(row.storage_path,3600),
        supabase.from('lyric_lines').select('lyric_text,line_number').eq('id',row.lyric_line_id).maybeSingle(),
        supabase.from('projects').select('title').eq('id',row.project_id).maybeSingle()
      ]);
      return {...row,imageUrl:signed?.signedUrl,line,project};
    }));
    setGallery(items);
  }

  useEffect(()=>{ if(selected?.id) loadAssets(selected.id); else setAssets([]); },[selected?.id]);
  useEffect(()=>{ if(active==='Galeri Gambar') loadGallery(); },[active,session]);

  const stats = useMemo(()=>({total:projects.length,done:projects.filter(p=>p.status==='completed').length,working:projects.filter(p=>p.status==='processing'||p.status==='queued').length}),[projects]);
  const nav = [{name:'Dashboard',icon:LayoutDashboard},{name:'Proyek Lagu',icon:Music2},{name:'Video Studio',icon:Clapperboard},{name:'Galeri Gambar',icon:ImageIcon},{name:'Pengaturan API',icon:Settings2}];

  if(!isSupabaseConfigured) return <div className="setup"><div className="setup-card"><div className="brand-mark"><AudioLines/></div><h1>AI Music Studio</h1><p>Hubungkan aplikasi ke Supabase untuk mulai mengelola proyek lagu.</p><code>Tambahkan VITE_SUPABASE_URL dan VITE_SUPABASE_PUBLISHABLE_KEY ke file .env</code><small>Jangan pernah menaruh service_role key atau API key AI di frontend.</small></div></div>;
  if(!session) return <div className="auth-shell"><div className="auth-art"><div className="brand"><div className="brand-mark"><AudioLines/></div><span>AI MUSIC <b>STUDIO</b></span></div><div className="art-copy"><span className="eyebrow"><Sparkles size={14}/> YOUR CREATIVE WORKSPACE</span><h1>Dari lirik,<br/><em>menjadi visual.</em></h1><p>Satu ruang kerja untuk mengubah setiap baris lagu menjadi cerita visual yang utuh.</p><div className="sound-bars">{Array.from({length:32},(_,i)=><i key={i} style={{height:(14+((i*17)%47))+'px'}}/>)}</div></div><div className="art-foot">CREATE · IMAGINE · COMPOSE</div></div><div className="auth-panel"><form className="auth-card" onSubmit={signIn}><span className="eyebrow">SELAMAT DATANG</span><h2>{authMode==='login'?'Masuk ke studio':'Buat akun studio'}</h2><p>Kelola semua proses kreatif lagu Anda dalam satu tempat.</p><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="nama@email.com" required/><label>Password</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Minimal 6 karakter" minLength="6" required/><button className="primary wide" disabled={busy}>{busy?'Memproses…':authMode==='login'?'Masuk':'Daftar akun'} <ChevronRight size={17}/></button>{notice&&<div className="notice">{notice}</div>}<div className="auth-switch">{authMode==='login'?'Belum punya akun?':'Sudah punya akun?'} <button type="button" onClick={()=>{setAuthMode(authMode==='login'?'signup':'login');setNotice('')}}>{authMode==='login'?'Daftar sekarang':'Masuk'}</button></div></form></div></div>;

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><AudioLines/></div><span>AI MUSIC <b>STUDIO</b></span></div><div className="workspace-label">WORKSPACE</div><nav>{nav.map(n=><button key={n.name} className={cx('nav-item',active===n.name&&'active')} onClick={()=>{setActive(n.name);if(n.name!=='Video Studio')setSelected(null)}}><n.icon size={18}/>{n.name}{n.name==='Proyek Lagu'&&<span className="nav-count">{projects.length}</span>}</button>)}</nav><div className="sidebar-bottom"><div className="help-row"><CircleHelp size={17}/><span>Pusat bantuan</span></div><div className="profile"><div className="avatar">{session.user.email?.[0]?.toUpperCase()}</div><div className="profile-text"><b>{session.user.email?.split('@')[0]}</b><small>Personal workspace</small></div><button title="Keluar" onClick={signOut}><LogOut size={17}/></button></div></div></aside>
  <main className="main"><header className="topbar"><div className="crumb">Workspace <ChevronRight size={14}/><b>{selected?.title||active}</b></div><div className="top-actions"><span className="status-dot"/> <span>Workspace aktif</span><div className="top-avatar">{session.user.email?.[0]?.toUpperCase()}</div></div></header>
  <div className="content">
  {notice&&<div className="notice global-notice">{notice}<button onClick={()=>setNotice('')}><X size={14}/></button></div>}
  {active==='Dashboard'&&<><div className="welcome"><div><span className="eyebrow">CREATIVE OVERVIEW</span><h1>Selamat datang di studio.</h1><p>Wujudkan ide lagu menjadi rangkaian visual yang bercerita.</p></div><button className="primary" onClick={()=>setShowCreate(true)}><Plus size={18}/> Buat Proyek</button></div><div className="hero-card"><div className="hero-glow"/><div className="hero-content"><span className="hero-tag"><WandSparkles size={14}/> AI-POWERED CREATION</span><h2>Setiap lirik punya<br/><em>cerita visualnya.</em></h2><p>Mulai dari lirik, kembangkan prompt, lalu bangun galeri gambar per baris lagu.</p><button className="hero-button" onClick={()=>setShowCreate(true)}>Mulai proyek pertama <ChevronRight size={16}/></button></div><div className="hero-orb"><div className="orb-ring ring-one"/><div className="orb-ring ring-two"/><AudioLines size={78}/><span>STORY<br/>IN FRAME</span></div><div className="hero-index">01 — 03</div></div><div className="stats-grid"><Stat icon={Music2} label="Total Proyek" value={stats.total}/><Stat icon={Clapperboard} label="Selesai" value={stats.done}/><Stat icon={Clock3} label="Dalam Proses" value={stats.working}/><Stat icon={ImageIcon} label="Visual Tersimpan" value="—"/></div><div className="section-head"><div><h3>Proyek Terbaru</h3><p>Lanjutkan karya yang sedang Anda kerjakan.</p></div><button className="text-button" onClick={()=>setActive('Proyek Lagu')}>Lihat semua <ChevronRight size={15}/></button></div><ProjectList projects={projects.slice(0,4)} loading={loading} onSelect={p=>{setSelected(p);setLyrics(p.lyrics||'');setActive('Proyek Lagu')}} onCreate={()=>setShowCreate(true)}/></>}
  {active==='Proyek Lagu'&&<><div className="page-heading"><div><span className="eyebrow">YOUR LIBRARY</span><h1>{selected?selected.title:'Proyek Lagu'}</h1><p>{selected?'Edit lirik dan detail visual proyek.':'Semua ide dan karya lagu Anda tersimpan di sini.'}</p></div><button className="primary" onClick={()=>selected?setSelected(null):setShowCreate(true)}>{selected?'Kembali ke daftar':<><Plus size={18}/> Proyek Baru</>}</button></div>{selected?<><div className="editor-grid"><section className="panel lyric-panel"><div className="panel-head"><div><h3><Music2 size={17}/> Lirik Lagu</h3><p>Satu kalimat per baris untuk hasil visual yang teratur.</p></div><span className="mini-pill">{lyrics.split(/\r?\n/).filter(x=>x.trim()).length} baris</span></div><label>Ide / tema lagu untuk GPT</label><textarea className="idea-input" value={idea} onChange={e=>setIdea(e.target.value)} placeholder="Contoh: lagu pop romantis tentang dua orang yang bertahan meski terpisah jarak…" rows="3"/><button type="button" className="secondary" onClick={generateLyrics} disabled={busy}><Sparkles size={16}/> {busy?'Memproses…':'Buat Lirik dengan GPT (DataByte)'}</button><textarea className="lyrics-input" value={lyrics} onChange={e=>setLyrics(e.target.value)} placeholder={'[Verse 1]\\nDi bawah langit senja\\nKita berjalan bersama\\n\\n[Chorus]\\n...'} rows="15"/><div className="editor-foot"><span>Periksa lirik sebelum membuat visual.</span><div className="editor-actions"><button className="secondary" onClick={saveLyrics} disabled={busy}>Simpan Lirik</button><button className="primary" onClick={generateVisuals} disabled={busy}><WandSparkles size={16}/> Buat Semua Visual</button></div></div>{pipelineMessage&&<div className="pipeline-progress">{pipelineMessage}</div>}</section><section className="panel settings-panel"><div className="panel-head"><div><h3><Blocks size={17}/> Pengaturan Visual</h3><p>Identitas visual untuk proyek ini.</p></div></div><label>Gaya visual</label><select value={selected.visual_style||'cinematic'} onChange={async e=>{const v=e.target.value;const {data,error}=await supabase.from('projects').update({visual_style:v}).eq('id',selected.id).select().single();if(!error){setSelected(data);setProjects(p=>p.map(x=>x.id===data.id?data:x))}}}>{styles.map(s=><option value={s.toLowerCase()} key={s}>{s}</option>)}</select><label>Rasio gambar</label><select value={selected.image_ratio||'16:9'} onChange={async e=>{const {data,error}=await supabase.from('projects').update({image_ratio:e.target.value}).eq('id',selected.id).select().single();if(!error){setSelected(data);setProjects(p=>p.map(x=>x.id===data.id?data:x))}}}><option>16:9</option><option>1:1</option><option>9:16</option><option>4:3</option></select><div className="pipeline-note"><Sparkles size={17}/><div><b>Alur visual tanpa API gambar</b><p>DataByte (GPT) membuat lirik, DataByte (DeepSeek) menyusun prompt. Gambar dibuat manual melalui aplikasi Gemini, lalu diunggah ke studio.</p></div></div><div className="progress-placeholder"><div className="progress-top"><b>Status proyek</b><span>{selected.status||'draft'}</span></div><div className="progress-track"><i style={{width:selected.status==='completed'?'100%':'0%'}}/></div></div></section></div><section className="panel assets-panel"><div className="panel-head"><div><h3><ImageIcon size={17}/> Prompt & Hasil Visual</h3><p>Buat gambar di aplikasi Gemini, kemudian unggah kembali sesuai urutan baris lirik.</p></div><span className="mini-pill">{assets.filter(x=>x.image).length}/{assets.length} gambar tersimpan</span></div>{assets.length>0&&<div className="gemini-tools"><button className="secondary" onClick={copyAllPrompts} disabled={busy}>Salin Semua Prompt</button><button className="primary" onClick={openGemini} disabled={busy}>Buka Gemini ↗</button><label className="secondary upload-many">Unggah Banyak Gambar<input type="file" accept="image/*" multiple disabled={busy} onChange={e=>{uploadGeminiImages(e.target.files);e.target.value=''}}/></label><p>Urutan upload mengikuti nomor baris lirik yang belum memiliki gambar. Pilih file sesuai urutan tersebut.</p></div>}{assets.length?<div className="visual-results">{[...assets].sort((a,b)=>(a.lyric_line?.line_number||0)-(b.lyric_line?.line_number||0)).map(item=><div className="visual-result" key={item.id}><div className="visual-result-image">{item.imageUrl?<img src={item.imageUrl} alt={item.lyric_line?.lyric_text||'Visual lagu'}/>:<ImageIcon size={22}/>}</div><div className="visual-result-copy"><b>Baris {item.lyric_line?.line_number||'—'} · {item.lyric_line?.section_name||'Lirik'}</b><p>{item.lyric_line?.lyric_text||''}</p><small>{item.image?'Gambar tersimpan':item.status==='failed'?(item.error_message||'Menunggu upload manual'):'Menunggu gambar dari Gemini'}</small><div className="prompt-actions"><button className="text-button" onClick={()=>copyOnePrompt(item)}>Salin Prompt</button></div></div></div>)}</div>:<div className="empty-inline">Belum ada prompt. Klik “Buat Semua Visual” untuk menyiapkan prompt Gemini.</div>}{pipelineMessage&&<div className="pipeline-progress">{pipelineMessage}</div>}</section></>:<ProjectList projects={projects} loading={loading} onSelect={p=>{setSelected(p);setLyrics(p.lyrics||'')}} onCreate={()=>setShowCreate(true)}/>}</>}
  {active==='Video Studio'&&<><div className="page-heading"><div><span className="eyebrow">MUSIC VIDEO WORKSPACE</span><h1>Video Studio</h1><p>Gabungkan audio, gambar, dan lirik menjadi video musik.</p></div>{selected&&<button className="secondary" onClick={()=>{setActive('Proyek Lagu')}}>Kembali ke proyek</button>}</div>{!selected?<ProjectList projects={projects} loading={loading} onSelect={p=>{setSelected(p);setLyrics(p.lyrics||'')}} onCreate={()=>setShowCreate(true)}/>:<><div className="video-steps"><div><b>01 · Audio duet</b><span>Buat lagu vokal pria & wanita di Gemini, lalu unggah MP3/WAV.</span></div><div><b>02 · Visual</b><span>{assets.filter(x=>x.imageUrl).length} gambar tersedia dari proyek ini.</span></div><div><b>03 · Render</b><span>Susun gambar dan subtitle mengikuti durasi audio.</span></div></div><section className="panel video-panel"><div className="panel-head"><div><h3><Music2 size={17}/> Audio lagu — {selected.title}</h3><p>File audio dipakai langsung dari perangkat Anda dan tidak dikirim ke layanan AI.</p></div></div><div className="audio-upload"><input type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg" onChange={e=>setAudioFile(e.target.files?.[0]||null)}/>{audioFile?<div className="audio-picked"><AudioLines size={20}/><div><b>{audioFile.name}</b><small>{(audioFile.size/1024/1024).toFixed(1)} MB</small></div><button className="text-button" onClick={()=>setAudioFile(null)}>Ganti</button></div>:<div className="audio-empty"><AudioLines size={24}/><b>Pilih audio lagu</b><span>Format MP3 atau WAV disarankan</span></div>}</div><div className="editor-actions video-actions"><button className="secondary" onClick={()=>window.open('https://gemini.google.com/app','_blank','noopener,noreferrer')}>Buka Gemini untuk membuat lagu ↗</button><button className="secondary" onClick={async()=>{const prompt='Buat lagu pop romantis sinematik berbahasa Indonesia berdasarkan lirik berikut. Nyanyikan sebagai DUET dua penyanyi: suara pria hangat dan rendah menyanyikan Verse 1, suara wanita lembut dan emosional menyanyikan Verse 2, lalu pria dan wanita bernyanyi bersama pada Chorus dan bagian akhir. Bedakan karakter kedua vokal dengan jelas, gunakan harmoni duet pada chorus. Hasil harus berupa lagu lengkap dengan vokal dan aransemen musik, bukan instrumental. Pertahankan lirik persis seperti teks yang diberikan.\n\n'+(selected.lyrics||lyrics||'Tempel lirik lagu di sini.');try{await navigator.clipboard.writeText(prompt);setNotice('Prompt lagu duet pria dan wanita berhasil disalin. Tempel di Gemini.')}catch{setNotice('Tidak dapat menyalin prompt.')}}}>Salin prompt duet pria + wanita</button></div><div className="pipeline-note"><Sparkles size={17}/><div><b>Pengaturan vokal duet</b><p>Pria: Verse 1. Wanita: Verse 2. Keduanya: Chorus dan outro. Minta Gemini menghasilkan lagu lengkap dengan vokal, bukan musik instrumental. Ketersediaan pembuatan audio bergantung pada fitur dan kuota akun Gemini.</p></div></div></section><section className="panel video-panel"><div className="panel-head"><div><h3><Clapperboard size={17}/> Susunan video</h3><p>Gambar diurutkan mengikuti nomor baris lirik. Subtitle dibagi merata sepanjang durasi lagu sebagai sinkronisasi awal.</p></div><span className="mini-pill">{assets.filter(x=>x.imageUrl).length} visual</span></div><div className="video-preview-grid">{[...assets].filter(x=>x.imageUrl).sort((a,b)=>(a.lyric_line?.line_number||0)-(b.lyric_line?.line_number||0)).map(item=><div className="video-preview-item" key={item.id}><img src={item.imageUrl} alt="Visual lagu"/><span>Baris {item.lyric_line?.line_number||'—'}</span><p>{item.lyric_line?.lyric_text||''}</p></div>)}</div>{!assets.some(x=>x.imageUrl)&&<div className="empty-inline">Belum ada gambar untuk proyek ini. Buat prompt dan unggah gambar di halaman Proyek Lagu.</div>}<div className="video-render-row"><div><b>Format video</b><span>16:9 · 1280 × 720 · WebM</span><small>Ekspor langsung dari browser. Bisa dikonversi ke MP4 setelah selesai.</small></div><button className="primary" disabled={!audioFile||!assets.some(x=>x.imageUrl)||rendering} onClick={()=>renderMusicVideo({audioFile,assets,lyrics:selected.lyrics||lyrics,title:selected.title,onProgress:setRenderProgress,onDone:()=>{setRendering(false);setRenderProgress('Video selesai dibuat. File WebM sudah diunduh.')},onError:e=>{setRendering(false);setRenderProgress('Render gagal: '+e.message)}}).then(()=>setRendering(true)).catch(e=>setRenderProgress('Render gagal: '+e.message))}><Clapperboard size={16}/>{rendering?'Merender…':'Buat Video'}</button></div>{renderProgress&&<div className="pipeline-progress">{renderProgress}</div>}</section></>}</>}

  {active==='Galeri Gambar'&&<><div className="page-heading"><div><span className="eyebrow">YOUR VISUAL LIBRARY</span><h1>Galeri Gambar</h1><p>Semua gambar dari Gemini atau upload manual, tersusun dari proyek dan baris lirik.</p></div></div>{gallery.length?<div className="gallery-grid">{gallery.map(item=><div className="gallery-card" key={item.id}>{item.imageUrl&&<img src={item.imageUrl} alt={item.line?.lyric_text||'Visual lagu'}/>}<div><b>{item.project?.title||'Proyek lagu'}</b><p>#{item.line?.line_number||'—'} · {item.line?.lyric_text||'Visual'}</p></div></div>)}</div>:<EmptyPage icon={ImageIcon} title="Galeri masih kosong" text="Buat visual dari halaman Proyek Lagu. Hasil gambar akan otomatis tersimpan di sini."/>}</>}
  {active==='Pengaturan API'&&<div className="page-heading"><div><span className="eyebrow">SECURE CONNECTIONS</span><h1>Pengaturan API</h1><p>Kredensial AI disimpan aman di Supabase Edge Function Secrets, bukan di browser.</p></div></div>} {active==='Pengaturan API'&&<div className="provider-grid"><Provider name="DataByte · GPT" detail="Pembuatan lirik lagu" status="Secret disimpan di backend" mark="DB"/><Provider name="DataByte · DeepSeek" detail="Prompt visual per baris lirik" status="Secret disimpan di backend" mark="DB"/><Provider name="Gemini App (manual)" detail="Pembuatan gambar tanpa API; hasil diunggah ke studio" status="Tanpa API gambar" mark="G"/></div>}
  </div></main>
  {showCreate&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setShowCreate(false)}}><form className="modal" onSubmit={createProject}><div className="modal-head"><div><span className="eyebrow">NEW CREATION</span><h2>Buat proyek lagu</h2></div><button type="button" className="icon-button" onClick={()=>setShowCreate(false)}><X/></button></div><label>Nama proyek</label><input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Contoh: Cerita di Ujung Senja" required/><label>Lirik lagu <small>(opsional, bisa ditambahkan nanti)</small></label><textarea value={lyrics} onChange={e=>setLyrics(e.target.value)} placeholder="Tempel lirik lagu Anda di sini…" rows="5"/><div className="form-row"><div><label>Gaya visual</label><select value={visualStyle} onChange={e=>setVisualStyle(e.target.value)}>{styles.map(s=><option key={s}>{s}</option>)}</select></div><div><label>Rasio gambar</label><select value={ratio} onChange={e=>setRatio(e.target.value)}><option>16:9</option><option>1:1</option><option>9:16</option><option>4:3</option></select></div></div><button className="primary wide" disabled={busy}>{busy?'Membuat…':'Buat Proyek'} <ChevronRight size={17}/></button></form></div>}
  </div>;
}

async function renderMusicVideo({audioFile,assets,lyrics,title,onProgress,onDone,onError}) {
  try {
    const slides=[...assets].filter(x=>x.imageUrl).sort((a,b)=>(a.lyric_line?.line_number||0)-(b.lyric_line?.line_number||0));
    if(!slides.length) throw new Error('Belum ada gambar yang siap digunakan.');
    const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=720;
    const ctx=canvas.getContext('2d');
    const images=await Promise.all(slides.map(item=>new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>resolve({item,img});img.onerror=()=>reject(new Error('Gambar gagal dimuat. Periksa koneksi atau akses penyimpanan.'));img.src=item.imageUrl;})));
    const audio=new Audio(URL.createObjectURL(audioFile)); audio.preload='auto';
    await new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=()=>reject(new Error('File audio tidak dapat dibaca.'));});
    if(!Number.isFinite(audio.duration)||audio.duration<=0) throw new Error('Durasi audio tidak valid.');
    const stream=canvas.captureStream(30); const AudioCtx=window.AudioContext||window.webkitAudioContext; const audioCtx=new AudioCtx();
    const source=audioCtx.createMediaElementSource(audio); const destination=audioCtx.createMediaStreamDestination(); source.connect(destination); source.connect(audioCtx.destination);
    destination.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
    if(!mime) throw new Error('Browser ini belum mendukung perekaman video WebM. Gunakan Chrome atau Edge terbaru.');
    const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:5000000}); const chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onerror=()=>onError(new Error('Perekaman video terhenti.'));
    const draw=()=>{const t=audio.currentTime;const index=Math.min(images.length-1,Math.floor(t/audio.duration*images.length));const {img,item}=images[index];const scale=Math.max(canvas.width/img.width,canvas.height/img.height);const w=img.width*scale,h=img.height*scale;ctx.fillStyle='#080b12';ctx.fillRect(0,0,1280,720);ctx.drawImage(img,(1280-w)/2,(720-h)/2,w,h);const lyric=item.lyric_line?.lyric_text||'';ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(0,560,1280,160);ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='600 32px Arial';ctx.fillStyle='#fff';const words=lyric.split(/\s+/);let line='',lines=[];for(const word of words){const test=line?line+' '+word:word;if(ctx.measureText(test).width>1100&&line){lines.push(line);line=word;}else line=test;}if(line)lines.push(line);lines.slice(0,3).forEach((text,i)=>ctx.fillText(text,640,610+i*42));ctx.font='600 16px Arial';ctx.fillStyle='rgba(255,255,255,.75)';ctx.fillText(title||'Music Video',640,45);};
    draw(); recorder.onstop=()=>{const blob=new Blob(chunks,{type:mime});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(title||'music-video').replace(/[^a-z0-9-_ ]/gi,'').trim().replace(/\s+/g,'-')+'.webm';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);stream.getTracks().forEach(t=>t.stop());audioCtx.close();URL.revokeObjectURL(audio.src);onDone();};
    recorder.start(1000);await audioCtx.resume();await audio.play();
    await new Promise(resolve=>{let raf;const tick=()=>{draw();onProgress('Merender video… '+Math.min(100,Math.round(audio.currentTime/audio.duration*100))+'%');if(audio.ended){cancelAnimationFrame(raf);recorder.stop();resolve();}else raf=requestAnimationFrame(tick);};tick();});
  } catch(error){onError(error);throw error;}
}

function Stat({icon:Icon,label,value}){return <div className="stat-card"><div className="stat-icon"><Icon size={18}/></div><div><span>{label}</span><b>{value}</b></div></div>}
function ProjectList({projects,loading,onSelect,onCreate}){if(loading)return <div className="empty-state">Memuat proyek…</div>;if(!projects.length)return <div className="empty-state"><div className="empty-icon"><Music2/></div><h3>Belum ada proyek lagu</h3><p>Mulai dengan membuat proyek pertama Anda.</p><button className="primary" onClick={onCreate}><Plus size={17}/> Buat Proyek</button></div>;return <div className="project-list">{projects.map(p=><button className="project-row" key={p.id} onClick={()=>onSelect(p)}><div className="project-thumb"><AudioLines/></div><div className="project-info"><b>{p.title}</b><span>{p.visual_style||'cinematic'} · {p.image_ratio||'16:9'}</span></div><span className={cx('status-pill',p.status)}>{p.status||'draft'}</span><ChevronRight size={17}/></button>)}</div>}
function EmptyPage({icon:Icon,title,text}){return <div className="empty-state large"><div className="empty-icon"><Icon/></div><h3>{title}</h3><p>{text}</p><span className="coming">FITUR DALAM PENGEMBANGAN</span></div>}
function Provider({name,detail,status,mark}){return <div className="provider-card"><div className="provider-mark">{mark}</div><div className="provider-info"><b>{name}</b><span>{detail}</span></div><span className="status-pill completed">Secret disimpan di backend</span><p>Kredensial tersimpan di Supabase Secrets dan dipanggil melalui backend saat proses AI dijalankan.</p></div>}
export default App;