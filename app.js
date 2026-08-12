/* ==========================================================================
   MiListaDeInvitados — NEXUS-7 GUESTLIST OS
   Motor único de la aplicación. 100% cliente, sin backend.
   Persistencia: localStorage. QR: qrcode.js + jsQR (CDN, gratuitas).
   Sync entre dispositivos: WhatsApp deep-link + QR de estado comprimido (LZString).
   ========================================================================== */

(function(){
"use strict";

/* ===================== 1. ESTADO / PERSISTENCIA ===================== */

const DB_KEY = "mldi_db_v1";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);

const ACCENTS = {
  cyan:   {accent:"#00fff2", dim:"rgba(0,255,242,.35)"},
  magenta:{accent:"#ff2ea6", dim:"rgba(255,46,166,.35)"},
  violet: {accent:"#7b5cff", dim:"rgba(123,92,255,.35)"},
  amber:  {accent:"#ffb32e", dim:"rgba(255,179,46,.35)"},
};
const ACCENT_ORDER = Object.keys(ACCENTS);

function defaultDB(){
  return {
    events: [],
    guests: [],
    team: [],
    settings: { accent:"cyan", lang:"es" },
    activeEventId: null,
  };
}

let DB = loadDB();
let undoStack = []; // {label, undo:fn}
let sortState = { key:"name", dir:1 };
let filterState = { status:"all", q:"" };
let scanStream = null, scanRAF = null;
let scanMode = "checkin"; // 'checkin' | 'sync'

function loadDB(){
  try{
    const raw = localStorage.getItem(DB_KEY);
    if(!raw) return seedDemo();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultDB(), parsed);
  }catch(e){ return seedDemo(); }
}
function saveDB(){
  localStorage.setItem(DB_KEY, JSON.stringify(DB));
}
function seedDemo(){
  const db = defaultDB();
  const t1 = uid(), t2 = uid();
  db.team.push({id:t1, name:"Kai (Admin)", role:"Admin"});
  db.team.push({id:t2, name:"Rika", role:"Promotor"});
  const ev1 = uid();
  const d = new Date(); d.setDate(d.getDate()+2);
  db.events.push({
    id:ev1, name:"NEON NIGHTS #12", venue:"",
    date: d.toISOString().slice(0,10), time:"23:59", capacity:180,
    notes:"", createdAt: Date.now()
  });
  db.activeEventId = ev1;
  ["Ryo Tanaka","Selene Vox","Marco Cruz","Ana Kade","Iris Chen","Damian Reyes"].forEach((n,i)=>{
    db.guests.push({
      id:uid(), eventId:ev1, name:n, phone:"+593 9"+ (10000000+i*1111111),
      vip: i%3===0, plusOnes: i%2, status: i===0?"checked-in": i===1?"confirmed":"pending",
      addedBy: i%2? t1:t2, notes:"", code: genCode(), checkedInAt: i===0? Date.now(): null,
      createdAt: Date.now()-i*10000
    });
  });
  return db;
}
function genCode(){
  return Array.from({length:6},()=> "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random()*32)]).join("");
}

/* ===================== 2. HELPERS DOM ===================== */
const $ = (sel,ctx=document)=>ctx.querySelector(sel);
const $$ = (sel,ctx=document)=>Array.from(ctx.querySelectorAll(sel));
function el(tag, attrs={}, children=[]){
  const e = document.createElement(tag);
  for(const k in attrs){
    if(k==="class") e.className = attrs[k];
    else if(k==="html") e.innerHTML = attrs[k];
    else if(k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (Array.isArray(children)?children:[children]).forEach(c=>{
    if(c==null) return;
    e.appendChild(typeof c==="string"? document.createTextNode(c): c);
  });
  return e;
}
function openModal(id){ $(id).classList.add("open"); }
function closeModal(id){ $(id).classList.remove("open"); }
$$(".overlay").forEach(ov=>{
  ov.addEventListener("click", e=>{ if(e.target===ov) closeModal("#"+ov.id); });
});
$$("[data-close]").forEach(b=> b.addEventListener("click", e=>{
  const ov = e.target.closest(".overlay"); closeModal("#"+ov.id);
}));

/* ===================== 3. TOASTS + UNDO (feature original) ===================== */
function toast(msg, type=""){
  const t = el("div",{class:"toast "+type}, [
    el("span",{},type==="success"?"✓":type==="danger"?"⚠":"◈"),
    el("span",{},msg)
  ]);
  $("#toast-stack").appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transform="translateX(30px)"; t.style.transition=".25s"; setTimeout(()=>t.remove(),260); }, 3400);
}
function pushUndo(label, undoFn){
  undoStack.push({label, undo:undoFn});
  if(undoStack.length>15) undoStack.shift();
  showUndoBar(label);
}
function showUndoBar(label){
  $("#undo-text").textContent = label;
  $("#undo-bar").classList.add("show");
  clearTimeout(showUndoBar._t);
  showUndoBar._t = setTimeout(()=> $("#undo-bar").classList.remove("show"), 6000);
}
$("#undo-btn").addEventListener("click", ()=>{
  const last = undoStack.pop();
  if(last){ last.undo(); toast("Deshecho: "+last.label); render(); }
  $("#undo-bar").classList.remove("show");
});

/* ===================== 4. SONIDO SINTETIZADO (feature original, Web Audio) ===================== */
let actx;
function sfx(type){
  try{
    actx = actx || new (window.AudioContext||window.webkitAudioContext)();
    const t0 = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    if(type==="checkin"){
      o.type="sine"; o.frequency.setValueAtTime(440,t0); o.frequency.exponentialRampToValueAtTime(1100,t0+.12);
      g.gain.setValueAtTime(.14,t0); g.gain.exponentialRampToValueAtTime(.001,t0+.28);
      o.start(t0); o.stop(t0+.3);
    } else if(type==="error"){
      o.type="sawtooth"; o.frequency.setValueAtTime(180,t0); o.frequency.exponentialRampToValueAtTime(80,t0+.22);
      g.gain.setValueAtTime(.12,t0); g.gain.exponentialRampToValueAtTime(.001,t0+.25);
      o.start(t0); o.stop(t0+.26);
    } else if(type==="click"){
      o.type="square"; o.frequency.setValueAtTime(900,t0);
      g.gain.setValueAtTime(.05,t0); g.gain.exponentialRampToValueAtTime(.001,t0+.05);
      o.start(t0); o.stop(t0+.06);
    } else if(type==="success"){
      [660,880,1320].forEach((f,i)=>{
        const o2=actx.createOscillator(), g2=actx.createGain();
        o2.type="sine"; o2.frequency.value=f; o2.connect(g2); g2.connect(actx.destination);
        g2.gain.setValueAtTime(.001,t0+i*.07);
        g2.gain.exponentialRampToValueAtTime(.1,t0+i*.07+.02);
        g2.gain.exponentialRampToValueAtTime(.001,t0+i*.07+.22);
        o2.start(t0+i*.07); o2.stop(t0+i*.07+.24);
      });
    }
  }catch(e){/* audio no disponible, silencioso */}
}

/* ===================== 5. EVENTOS (CRUD + expiración) ===================== */
function eventStatus(ev){
  const expiry = new Date(ev.date+"T"+(ev.time||"23:59")+":00");
  const now = new Date();
  if(now > expiry) return "expired";
  const hoursLeft = (expiry-now)/36e5;
  if(hoursLeft<=24) return "soon";
  return "live";
}
function getActiveEvent(){
  return DB.events.find(e=>e.id===DB.activeEventId) || null;
}
function setActiveEvent(id){
  DB.activeEventId = id; saveDB(); render();
  sfx("click");
}

function openEventModal(ev){
  $("#event-modal-title").textContent = ev? "Editar Evento" : "Nuevo Evento";
  $("#ev-id").value = ev? ev.id : "";
  $("#ev-name").value = ev? ev.name : "";
  $("#ev-date").value = ev? ev.date : new Date().toISOString().slice(0,10);
  $("#ev-time").value = ev? ev.time : "23:59";
  $("#ev-venue").value = ev? ev.venue : "";
  $("#ev-capacity").value = ev? ev.capacity : "";
  $("#ev-notes").value = ev? ev.notes : "";
  $("#ev-delete").style.display = ev? "inline-flex":"none";
  openModal("#modal-event");
}
$("#btn-new-event").addEventListener("click", ()=> openEventModal(null));
$("#ev-save").addEventListener("click", ()=>{
  const name = $("#ev-name").value.trim();
  const date = $("#ev-date").value;
  if(!name || !date){ toast("Nombre y fecha son obligatorios","danger"); sfx("error"); return; }
  const id = $("#ev-id").value;
  const payload = {
    name, date, time: $("#ev-time").value||"23:59",
    venue: $("#ev-venue").value.trim(), capacity: Number($("#ev-capacity").value)||0,
    notes: $("#ev-notes").value.trim()
  };
  if(id){
    const ev = DB.events.find(e=>e.id===id);
    Object.assign(ev, payload);
    toast("Evento actualizado","success");
  } else {
    const newEv = Object.assign({id:uid(), createdAt:Date.now()}, payload);
    DB.events.push(newEv);
    DB.activeEventId = newEv.id;
    if(window.confetti){
      confetti({particleCount:80, spread:70, colors:['#00fff2','#ff2ea6','#7b5cff'], origin:{y:.3}});
    }
    toast("Evento creado ⚡","success"); sfx("success");
  }
  saveDB(); closeModal("#modal-event"); render();
});
$("#ev-delete").addEventListener("click", ()=>{
  const id = $("#ev-id").value;
  if(!confirm("¿Eliminar este evento y todos sus invitados?")) return;
  const evIdx = DB.events.findIndex(e=>e.id===id);
  const removedEv = DB.events[evIdx];
  const removedGuests = DB.guests.filter(g=>g.eventId===id);
  DB.events.splice(evIdx,1);
  DB.guests = DB.guests.filter(g=>g.eventId!==id);
  if(DB.activeEventId===id) DB.activeEventId = DB.events[0]? DB.events[0].id : null;
  saveDB(); closeModal("#modal-event"); render();
  toast("Evento eliminado","danger");
  pushUndo("eliminar evento «"+removedEv.name+"»", ()=>{
    DB.events.splice(evIdx,0,removedEv);
    DB.guests.push(...removedGuests);
    DB.activeEventId = removedEv.id;
    saveDB();
  });
});

/* ===================== 6. EQUIPO ===================== */
$("#btn-add-team").addEventListener("click", ()=> openModal("#modal-team"));
$("#t-save").addEventListener("click", ()=>{
  const name = $("#t-name").value.trim();
  if(!name){ toast("Escribe un nombre","danger"); return; }
  DB.team.push({id:uid(), name, role:$("#t-role").value});
  saveDB(); $("#t-name").value=""; closeModal("#modal-team"); render();
  toast("Miembro agregado al equipo","success");
});

/* ===================== 7. INVITADOS (CRUD) ===================== */
function guestsForActiveEvent(){
  const ev = getActiveEvent();
  if(!ev) return [];
  let list = DB.guests.filter(g=>g.eventId===ev.id);
  if(filterState.status!=="all") list = list.filter(g=>g.status===filterState.status);
  if(filterState.q){
    const q = filterState.q.toLowerCase();
    list = list.filter(g=> g.name.toLowerCase().includes(q) || (g.phone||"").includes(q) || (g.notes||"").toLowerCase().includes(q));
  }
  list.sort((a,b)=>{
    let av=a[sortState.key], bv=b[sortState.key];
    if(sortState.key==="name") { av=av.toLowerCase(); bv=bv.toLowerCase(); }
    if(av<bv) return -1*sortState.dir;
    if(av>bv) return 1*sortState.dir;
    return 0;
  });
  return list;
}

function openGuestModal(guest){
  $("#guest-modal-title").textContent = guest? "Editar Invitado":"Nuevo Invitado";
  $("#g-id").value = guest? guest.id : "";
  $("#g-name").value = guest? guest.name : "";
  $("#g-phone").value = guest? guest.phone : "";
  $("#g-plusones").value = guest? guest.plusOnes : 0;
  $("#g-vip").checked = guest? guest.vip : false;
  $("#g-notes").value = guest? guest.notes : "";
  const sel = $("#g-addedby");
  sel.innerHTML = '<option value="">— Equipo —</option>' + DB.team.map(t=>`<option value="${t.id}">${escapeHTML(t.name)}</option>`).join("");
  sel.value = guest? (guest.addedBy||"") : "";
  $("#g-delete").style.display = guest? "inline-flex":"none";
  openModal("#modal-guest");
}
$("#g-save").addEventListener("click", ()=>{
  const ev = getActiveEvent();
  if(!ev){ toast("Primero crea/selecciona un evento","danger"); return; }
  const name = $("#g-name").value.trim();
  if(!name){ toast("El nombre es obligatorio","danger"); sfx("error"); return; }
  const id = $("#g-id").value;
  const payload = {
    name, phone:$("#g-phone").value.trim(), plusOnes: Number($("#g-plusones").value)||0,
    vip: $("#g-vip").checked, notes: $("#g-notes").value.trim(), addedBy: $("#g-addedby").value
  };
  // detección de duplicados (feature)
  const dup = DB.guests.find(g=> g.eventId===ev.id && g.id!==id &&
      (g.name.trim().toLowerCase()===name.toLowerCase() || (payload.phone && g.phone===payload.phone)));
  if(dup && !id){
    if(!confirm(`«${dup.name}» ya está en la lista. ¿Agregar de todas formas?`)) return;
  }
  if(id){
    const g = DB.guests.find(x=>x.id===id);
    Object.assign(g, payload);
    toast("Invitado actualizado","success");
  } else {
    DB.guests.push(Object.assign({id:uid(), eventId:ev.id, status:"pending", code:genCode(), checkedInAt:null, createdAt:Date.now()}, payload));
    toast("Invitado agregado","success"); sfx("click");
  }
  saveDB(); closeModal("#modal-guest"); render();
});
$("#g-delete").addEventListener("click", ()=>{
  const id = $("#g-id").value;
  const idx = DB.guests.findIndex(g=>g.id===id);
  const removed = DB.guests[idx];
  DB.guests.splice(idx,1);
  saveDB(); closeModal("#modal-guest"); render();
  toast("Invitado eliminado","danger");
  pushUndo("eliminar a «"+removed.name+"»", ()=>{ DB.guests.splice(idx,0,removed); saveDB(); });
});

function setGuestStatus(id, status){
  const g = DB.guests.find(x=>x.id===id);
  const prev = g.status; const prevAt = g.checkedInAt;
  g.status = status;
  g.checkedInAt = status==="checked-in" ? Date.now() : null;
  saveDB(); render();
  if(status==="checked-in") sfx("checkin");
  pushUndo(`cambiar estado de «${g.name}» a ${status}`, ()=>{ g.status=prev; g.checkedInAt=prevAt; saveDB(); });
}

function escapeHTML(s){ return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

/* ===================== 8. QR — PASE INDIVIDUAL + WHATSAPP ===================== */
function guestPayload(g, ev){
  return JSON.stringify({app:"MLDI", v:1, code:g.code, eventId:ev.id, guestId:g.id, name:g.name});
}
function openGuestQR(guest){
  const ev = getActiveEvent();
  $("#qr-render").innerHTML = "";
  new QRCode($("#qr-render"), {
    text: guestPayload(guest, ev),
    width:190, height:190, colorDark:"#08060d", colorLight:"#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });
  $("#qr-code-text").textContent = guest.code;
  $("#qr-guest-info").textContent = `${guest.name} · ${ev.name} · +${guest.plusOnes} acompañante(s)`;
  $("#btn-share-wa").onclick = ()=> shareWhatsApp(guest, ev);
  $("#btn-copy-link").onclick = ()=>{
    navigator.clipboard?.writeText(waMessage(guest,ev)).then(()=> toast("Copiado al portapapeles","success"));
  };
  $("#btn-checkin-now").onclick = ()=>{ setGuestStatus(guest.id,"checked-in"); closeModal("#modal-qr"); };
  openModal("#modal-qr");
}
function waMessage(guest, ev){
  const expiry = new Date(ev.date+"T"+(ev.time||"23:59")+":00");
  return `✦ ${ev.name} ✦\nHola ${guest.name}, este es tu pase digital.\nCódigo: ${guest.code}\n📍 ${ev.venue||"Ver ubicación con el staff"}\n🗓 Válido hasta: ${expiry.toLocaleString()}\nMuestra este código en la puerta.`;
}
function shareWhatsApp(guest, ev){
  const phone = (guest.phone||"").replace(/[^\d+]/g,"");
  const text = encodeURIComponent(waMessage(guest, ev));
  const url = phone ? `https://wa.me/${phone.replace("+","")}?text=${text}` : `https://wa.me/?text=${text}`;
  window.open(url, "_blank");
}

/* ===================== 9. ESCÁNER DE CÁMARA (check-in + sync) ===================== */
async function startScanner(mode){
  scanMode = mode;
  $("#scan-result").textContent = "Iniciando cámara...";
  openModal("#modal-scan");
  try{
    scanStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
    const video = $("#scanner-video");
    video.srcObject = scanStream;
    await video.play();
    tickScan();
    $("#scan-result").textContent = "Apunta la cámara al código QR.";
  }catch(e){
    $("#scan-result").innerHTML = "⚠ No se pudo acceder a la cámara.<br>Verifica permisos del navegador.";
  }
}
function stopScanner(){
  if(scanRAF) cancelAnimationFrame(scanRAF);
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream=null; }
}
function tickScan(){
  const video = $("#scanner-video"), canvas = $("#scanner-canvas");
  if(video.readyState===video.HAVE_ENOUGH_DATA){
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const img = ctx.getImageData(0,0,canvas.width,canvas.height);
    const code = jsQR(img.data, img.width, img.height);
    if(code){ handleScanResult(code.data); return; }
  }
  scanRAF = requestAnimationFrame(tickScan);
}
function handleScanResult(raw){
  stopScanner();
  if(scanMode==="sync"){ return handleSyncScan(raw); }
  try{
    const data = JSON.parse(raw);
    if(data.app!=="MLDI") throw new Error();
    const guest = DB.guests.find(g=>g.id===data.guestId && g.code===data.code);
    if(!guest){ $("#scan-result").innerHTML = "✗ Código no reconocido en esta lista."; sfx("error"); return restartScanSoon(); }
    const ev = DB.events.find(e=>e.id===guest.eventId);
    const status = ev? eventStatus(ev) : "expired";
    if(status==="expired"){
      $("#scan-result").innerHTML = `⚠ <b>${escapeHTML(guest.name)}</b> — evento EXPIRADO`;
      sfx("error"); return restartScanSoon();
    }
    if(guest.status==="checked-in"){
      $("#scan-result").innerHTML = `↺ <b>${escapeHTML(guest.name)}</b> ya había ingresado (${new Date(guest.checkedInAt).toLocaleTimeString()})`;
      sfx("error"); return restartScanSoon();
    }
    setGuestStatus(guest.id,"checked-in");
    $("#scan-result").innerHTML = `✓ ACCESO OK — <b>${escapeHTML(guest.name)}</b> ${guest.vip?"★ VIP":""} · +${guest.plusOnes}`;
    if(window.confetti) confetti({particleCount:40,spread:55,origin:{y:.4},colors:['#00fff2','#39ff88']});
  }catch(e){
    $("#scan-result").innerHTML = "✗ QR no válido para MiListaDeInvitados.";
    sfx("error");
  }
  restartScanSoon();
}
function restartScanSoon(){ setTimeout(()=>{ if($("#modal-scan").classList.contains("open")) startScanner(scanMode); }, 1800); }
$("#btn-scan").addEventListener("click", ()=> startScanner("checkin"));
$("#scan-close").addEventListener("click", stopScanner);
$("#modal-scan").addEventListener("click", e=>{ if(e.target.id==="modal-scan") stopScanner(); });

/* ===================== 10. SYNC TOTAL SIN BACKEND (feature original) ===================== */
/* Codifica el evento activo + sus invitados comprimido en el propio QR, para que
   otro dispositivo del staff lo escanee y fusione el estado (merge por id, gana el más reciente). */
function openSyncModal(){
  const ev = getActiveEvent();
  if(!ev){ toast("Selecciona un evento primero","danger"); return; }
  const guests = DB.guests.filter(g=>g.eventId===ev.id);
  const payload = { app:"MLDI-SYNC", v:1, event: ev, guests, ts: Date.now() };
  const compressed = LZString.compressToBase64(JSON.stringify(payload));
  $("#sync-qr-render").innerHTML = "";
  if(compressed.length > 2800){
    $("#sync-qr-render").innerHTML = `<p class="hint">Lista muy grande para un solo QR (${guests.length} invitados). Usa exportar CSV en su lugar.</p>`;
  } else {
    new QRCode($("#sync-qr-render"), { text: compressed, width:220, height:220, colorDark:"#08060d", colorLight:"#fff", correctLevel: QRCode.CorrectLevel.M });
  }
  openModal("#modal-sync");
}
$("#btn-sync-qr").addEventListener("click", openSyncModal);
$("#btn-sync-scan").addEventListener("click", ()=>{ closeModal("#modal-sync"); startScanner("sync"); });

function handleSyncScan(raw){
  try{
    const json = LZString.decompressFromBase64(raw);
    const data = JSON.parse(json);
    if(data.app!=="MLDI-SYNC") throw new Error();
    // merge evento
    const existingEv = DB.events.find(e=>e.id===data.event.id);
    if(!existingEv) DB.events.push(data.event);
    else Object.assign(existingEv, data.event);
    // merge invitados: gana el registro con timestamp de check-in más reciente / status más "avanzado"
    const rank = {pending:0, confirmed:1, "no-show":1, "checked-in":2};
    data.guests.forEach(incoming=>{
      const local = DB.guests.find(g=>g.id===incoming.id);
      if(!local) DB.guests.push(incoming);
      else if(rank[incoming.status] > rank[local.status]) Object.assign(local, incoming);
    });
    DB.activeEventId = data.event.id;
    saveDB(); render();
    $("#scan-result").innerHTML = `✓ Sincronizado: ${data.guests.length} invitados de «${escapeHTML(data.event.name)}»`;
    toast("Sincronización completa","success"); sfx("success");
    if(window.confetti) confetti({particleCount:60,spread:80,origin:{y:.3}});
    setTimeout(()=> closeModal("#modal-scan"), 1600);
  }catch(e){
    $("#scan-result").innerHTML = "✗ QR de sincronización no válido.";
    sfx("error"); restartScanSoon();
  }
}

/* ===================== 11. CSV IMPORT/EXPORT ===================== */
$("#btn-export-csv").addEventListener("click", ()=>{
  const ev = getActiveEvent();
  if(!ev){ toast("Selecciona un evento","danger"); return; }
  const rows = [["nombre","telefono","vip","acompanantes","estado","notas","codigo"]];
  DB.guests.filter(g=>g.eventId===ev.id).forEach(g=>{
    rows.push([g.name, g.phone||"", g.vip?"SI":"NO", g.plusOnes, g.status, (g.notes||"").replace(/,/g," "), g.code]);
  });
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${ev.name.replace(/\s+/g,"_")}_invitados.csv`;
  a.click();
  toast("CSV exportado","success");
});
$("#btn-import-csv").addEventListener("click", ()=> $("#file-csv").click());
$("#file-csv").addEventListener("change", e=>{
  const ev = getActiveEvent();
  if(!ev){ toast("Selecciona un evento primero","danger"); return; }
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    const lines = reader.result.split(/\r?\n/).filter(Boolean);
    let added = 0;
    lines.slice(1).forEach(line=>{
      const cols = line.match(/(".*?"|[^,]+)(?=,|$)/g);
      if(!cols || !cols[0]) return;
      const clean = cols.map(c=>c.replace(/^"|"$/g,"").replace(/""/g,'"'));
      const [name, phone, vip, plusOnes] = clean;
      if(!name) return;
      DB.guests.push({id:uid(), eventId:ev.id, name:name.trim(), phone:(phone||"").trim(),
        vip:(vip||"").toUpperCase()==="SI", plusOnes:Number(plusOnes)||0, status:"pending",
        notes:"", addedBy:"", code:genCode(), checkedInAt:null, createdAt:Date.now()});
      added++;
    });
    saveDB(); render();
    toast(`${added} invitados importados`,"success");
    e.target.value = "";
  };
  reader.readAsText(file);
});

/* ===================== 12. LISTA DE PUERTA (impresión) ===================== */
$("#btn-print-door").addEventListener("click", ()=>{
  const ev = getActiveEvent();
  if(!ev){ toast("Selecciona un evento","danger"); return; }
  const guests = DB.guests.filter(g=>g.eventId===ev.id).sort((a,b)=>a.name.localeCompare(b.name));
  const rows = guests.map(g=>`<tr><td>${escapeHTML(g.name)}${g.vip?" ★":""}</td><td>${g.plusOnes}</td><td>${g.phone||""}</td><td>${g.status}</td></tr>`).join("");
  $("#print-area").innerHTML = `<h1>${escapeHTML(ev.name)}</h1><p>${ev.venue||""} — ${ev.date} ${ev.time}</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;font-family:sans-serif;">
    <thead><tr><th>Nombre</th><th>+</th><th>Teléfono</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table>`;
  window.print();
});

/* ===================== 13. FILTROS / BÚSQUEDA / ORDEN / TECLADO ===================== */
document.addEventListener("keydown", e=>{
  if(e.key==="Escape"){ $$(".overlay.open").forEach(o=>{closeModal("#"+o.id); if(o.id==="modal-scan") stopScanner();}); }
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="k"){ e.preventDefault(); const s=$("#search-input"); if(s) s.focus(); }
  if(e.key.toLowerCase()==="n" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)){
    if(getActiveEvent()) openGuestModal(null);
  }
});

/* ===================== 14. TEMA / IDIOMA ===================== */
function applyAccent(name){
  const a = ACCENTS[name]||ACCENTS.cyan;
  document.documentElement.style.setProperty("--accent", a.accent);
  document.documentElement.style.setProperty("--accent-dim", a.dim);
  DB.settings.accent = name; saveDB();
}
$("#btn-theme").addEventListener("click", ()=>{
  const idx = ACCENT_ORDER.indexOf(DB.settings.accent);
  applyAccent(ACCENT_ORDER[(idx+1)%ACCENT_ORDER.length]);
  sfx("click");
});
const I18N = {
  es:{lang:"EN"}, en:{lang:"ES"}
};
$("#btn-lang").addEventListener("click", ()=>{
  DB.settings.lang = DB.settings.lang==="es"?"en":"es";
  $("#btn-lang").textContent = DB.settings.lang==="es"?"EN":"ES";
  saveDB(); toast(DB.settings.lang==="es"? "Idioma: Español":"Language: English");
});

/* ===================== 15. RELOJ EN VIVO ===================== */
function tickClock(){
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString('es-EC',{hour12:false}) + "  //  " + d.toLocaleDateString('es-EC',{day:'2-digit',month:'short'});
}
setInterval(tickClock, 1000); tickClock();

/* auto-chequeo de expiración de eventos cada 30s (feature) */
setInterval(()=>{ render(true); }, 30000);

/* ===================== 16. RENDER: SIDEBAR ===================== */
function renderSidebar(){
  const list = $("#events-list");
  list.innerHTML = "";
  $("#ev-count").textContent = DB.events.length;
  const sorted = [...DB.events].sort((a,b)=> new Date(a.date) - new Date(b.date));
  sorted.forEach(ev=>{
    const st = eventStatus(ev);
    const guests = DB.guests.filter(g=>g.eventId===ev.id);
    const card = el("div",{class:"event-card"+(ev.id===DB.activeEventId?" active":"")+(st==="expired"?" expired":""),
      onclick:()=>setActiveEvent(ev.id), ondblclick:()=>openEventModal(ev)},[
      el("div",{class:"ev-name"}, ev.name),
      el("div",{class:"ev-meta"},[
        el("span",{}, ev.date+" · "+ev.time),
        el("span",{}, guests.length+"/"+(ev.capacity||"∞"))
      ]),
      el("span",{class:"ev-tag "+(st==="live"?"tag-live":st==="soon"?"tag-soon":"tag-expired")},
        st==="live"?"● activo": st==="soon"?"◐ expira pronto":"✕ expirado")
    ]);
    list.appendChild(card);
  });
  if(!sorted.length){
    list.appendChild(el("div",{class:"hint",style:"padding:10px 8px;"},"Sin eventos aún. Crea el primero →"));
  }

  const team = $("#team-list");
  team.innerHTML = "";
  DB.team.forEach(t=>{
    team.appendChild(el("div",{class:"team-chip"},[
      el("span",{class:"dot"}), el("span",{}, t.name), el("span",{class:"role"}, t.role)
    ]));
  });
}

/* ===================== 17. RENDER: MAIN ===================== */
function render(silent){
  renderSidebar();
  const ev = getActiveEvent();
  const main = $("#main");
  main.innerHTML = "";

  if(!ev){
    main.appendChild(el("div",{class:"empty-state"},[
      el("div",{class:"icon"},"▣"),
      el("h2",{}, "Ningún evento activo"),
      el("p",{}, "Crea un evento para empezar a manejar tu lista de invitados."),
      el("button",{class:"btn btn-solid", style:"margin-top:10px;", onclick:()=>openEventModal(null)}, "+ Crear evento")
    ]));
    return;
  }

  const status = eventStatus(ev);
  const guests = DB.guests.filter(g=>g.eventId===ev.id);
  const checkedIn = guests.filter(g=>g.status==="checked-in").length;
  const totalHeads = guests.reduce((s,g)=> s + 1 + (g.status!=="no-show"? g.plusOnes:0), 0);
  const vipCount = guests.filter(g=>g.vip).length;
  const cap = ev.capacity||0;
  const pct = cap? Math.min(100, Math.round(totalHeads/cap*100)) : 0;

  // Hero simplificado: solo lo esencial para actuar sobre la lista
  const expBadge = status!=="live" ? el("span",{class:"expiry-badge", style:`color:${status==='expired'?'var(--red)':'var(--amber)'};border-color:currentColor;`},
        status==="expired"?"EXPIRADO":"EXPIRA EN <24H") : null;
  const head = el("div",{class:"panel-head"},[
    el("div",{},[
      el("div",{class:"panel-title"},[ ev.name, expBadge ])
    ]),
    el("div",{class:"panel-actions"},[
      el("button",{class:"btn btn-solid", onclick:()=>openGuestModal(null)},"+ Invitado")
    ])
  ]);
  main.appendChild(head);

  // Toolbar — justo bajo el hero, directo a la lista
  const statuses = [["all","Todos"],["pending","Pendientes"],["confirmed","Confirmados"],["checked-in","Ingresaron"],["no-show","No-show"]];
  main.appendChild(el("div",{class:"toolbar"},[
    el("div",{class:"search-box"},[
      el("span",{class:"ic"},"⌕"),
      el("input",{id:"search-input", placeholder:"Buscar por nombre, teléfono o nota…  (Ctrl+K)", value:filterState.q,
        oninput:e=>{ filterState.q = e.target.value; renderGuestTable(); }})
    ]),
    el("div",{class:"chip-filter"}, statuses.map(([k,label])=>
      el("button",{class:filterState.status===k?"active":"", onclick:()=>{filterState.status=k; renderGuestTable(); refreshFilterChips();}}, label)
    ))
  ]));

  // ===== LA LISTA — foco central =====
  main.appendChild(el("div",{class:"guest-table-wrap", id:"guest-table-wrap"}));
  renderGuestTable();

  // ===== Detalles / extras — al fondo, secundarios =====
  main.appendChild(el("div",{class:"divider-label"},"Detalles del evento"));
  main.appendChild(el("div",{class:"stats-strip"},[
    statBox(guests.length,"Invitados"),
    statBox(checkedIn,"Check-in"),
    statBox(vipCount,"VIP"),
    statBox(totalHeads,"Total personas"),
    statBox(guests.length? Math.round(checkedIn/guests.length*100)+"%":"0%","Asistencia"),
  ]));
  main.appendChild(el("div",{class:"gauge-wrap"},[
    el("div",{class:"gauge-top"},[el("span",{},"Capacidad del venue"), el("span",{}, totalHeads+" / "+(cap||"∞")+"  ("+pct+"%)")]),
    el("div",{class:"gauge-track"},[ el("div",{class:"gauge-fill"+(pct>=90?" full":""), style:`width:${pct}%`}) ])
  ]));
  main.appendChild(el("div",{class:"panel-actions", style:"margin-top:14px; justify-content:flex-start;"},[
    el("span",{class:"g-sub", style:"align-self:center; margin-right:4px;"}, (ev.venue||"sin venue")+" · "+ev.date+" "+ev.time),
    el("button",{class:"btn btn-ghost btn-sm", onclick:()=>openEventModal(ev)},"✎ Editar evento"),
    el("button",{class:"btn btn-magenta btn-sm", onclick:()=>openAnalytics(ev,guests)},"◱ Analítica")
  ]));

  if(!silent) {} // reserved
}
function refreshFilterChips(){
  $$(".chip-filter button").forEach((b,i)=>{
    const keys=["all","pending","confirmed","checked-in","no-show"];
    b.classList.toggle("active", keys[i]===filterState.status);
  });
}
function statBox(num,label){
  return el("div",{class:"stat-box"},[ el("div",{class:"stat-num"}, String(num)), el("div",{class:"stat-label"}, label) ]);
}

function renderGuestTable(){
  const wrap = $("#guest-table-wrap");
  if(!wrap) return;
  const guests = guestsForActiveEvent();
  if(!guests.length){
    wrap.innerHTML = "";
    wrap.appendChild(el("div",{class:"table-empty"},"Sin resultados. Ajusta el filtro o agrega un invitado."));
    return;
  }
  const cols = [["name","Nombre"],["status","Estado"],["plusOnes","+"],["phone","Teléfono"],["addedBy","Staff"]];
  const table = el("table",{},[
    el("thead",{},[ el("tr",{}, cols.map(([k,label])=>
      el("th",{class:sortState.key===k?"sorted":"", onclick:()=>{
        if(sortState.key===k) sortState.dir*=-1; else { sortState.key=k; sortState.dir=1; }
        renderGuestTable();
      }}, label + (sortState.key===k? (sortState.dir>0?" ▲":" ▼"):""))
    ).concat(el("th",{},"")))]),
    el("tbody",{}, guests.map(g=> guestRow(g)))
  ]);
  wrap.innerHTML=""; wrap.appendChild(table);
}
function guestRow(g){
  const staff = DB.team.find(t=>t.id===g.addedBy);
  const tr = el("tr",{class:g.status==="checked-in"?"checked-in":(g.status==="no-show"?"no-show":"")},[
    el("td",{},[
      el("div",{class:"g-name"},[g.name, g.vip? el("span",{class:"vip"},"★ VIP"):null]),
      g.notes? el("div",{class:"g-sub"}, g.notes) : null
    ]),
    el("td",{},[ statusPill(g) ]),
    el("td",{}, g.plusOnes>0? "+"+g.plusOnes : "—"),
    el("td",{class:"g-sub"}, g.phone||"—"),
    el("td",{class:"g-sub"}, staff? staff.name : "—"),
    el("td",{},[ el("div",{class:"row-actions"},[
      el("button",{title:"Ver QR / Compartir", onclick:()=>openGuestQR(g)},"▣"),
      el("button",{title:"WhatsApp", onclick:()=>shareWhatsApp(g, getActiveEvent())},"✆"),
      g.status!=="checked-in"?
        el("button",{title:"Check-in manual", onclick:()=>setGuestStatus(g.id,"checked-in")},"✓") :
        el("button",{title:"Revertir check-in", onclick:()=>setGuestStatus(g.id,"confirmed")},"↺"),
      el("button",{title:"Editar", onclick:()=>openGuestModal(g)},"✎"),
      el("button",{class:"danger", title:"Eliminar", onclick:()=>{
        $("#g-id").value=g.id; $("#g-delete").click();
      }},"✕"),
    ])])
  ]);
  return tr;
}
function statusPill(g){
  const map = {pending:"Pendiente", confirmed:"Confirmado","checked-in":"Ingresó","no-show":"No-show"};
  const p = el("span",{class:"status-pill status-"+g.status},[ el("span",{class:"dot"}), map[g.status] ]);
  p.style.cursor="pointer";
  p.title = "Click para cambiar estado";
  p.addEventListener("click", ()=>{
    const order = ["pending","confirmed","checked-in","no-show"];
    const next = order[(order.indexOf(g.status)+1)%order.length];
    setGuestStatus(g.id, next);
  });
  return p;
}

/* ===================== 18. ANALÍTICA (mini dashboard) ===================== */
function openAnalytics(ev, guests){
  const byStatus = {pending:0,confirmed:0,"checked-in":0,"no-show":0};
  guests.forEach(g=> byStatus[g.status]++);
  const byStaff = {};
  guests.forEach(g=>{
    const staff = DB.team.find(t=>t.id===g.addedBy);
    const name = staff? staff.name : "Sin asignar";
    byStaff[name] = (byStaff[name]||0)+1;
  });
  const max = Math.max(1, guests.length);
  const html = `
    <div class="modal wide" style="max-width:520px;">
      <div class="modal-head"><h3>Analítica — ${escapeHTML(ev.name)}</h3><button class="modal-close" id="an-close">×</button></div>
      <div class="modal-body">
        <div class="divider-label">Por estado</div>
        ${Object.entries(byStatus).map(([k,v])=>abar(k,v,max)).join("")}
        <div class="divider-label">Por promotor / staff</div>
        ${Object.entries(byStaff).map(([k,v])=>abar(k,v,max)).join("") || '<p class="hint">Sin datos aún.</p>'}
      </div>
    </div>`;
  const ov = el("div",{class:"overlay open", id:"modal-analytics", html});
  document.body.appendChild(ov);
  $("#an-close").addEventListener("click", ()=> ov.remove());
  ov.addEventListener("click", e=>{ if(e.target===ov) ov.remove(); });
}
function abar(label,val,max){
  const pct = Math.round(val/max*100);
  return `<div class="abar-row"><div class="abar-label">${escapeHTML(label)}</div>
    <div class="abar-track"><div class="abar-fill" style="width:${pct}%"></div></div>
    <div class="abar-val">${val}</div></div>`;
}

/* ===================== 19. INIT ===================== */
applyAccent(DB.settings.accent);
$("#btn-lang").textContent = DB.settings.lang==="es"?"EN":"ES";
if(!DB.activeEventId && DB.events.length) DB.activeEventId = DB.events[0].id;
render();
toast("Sistema listo. Bienvenido a NEXUS-7 ⚡");

})();
