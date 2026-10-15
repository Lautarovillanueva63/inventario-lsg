/* =====================================================================
   Inventario de Obra LSG — v2
   Modelo: el INVENTARIO es lo principal (qué hay en cada ubicación) y
   cada cambio es un MOVIMIENTO. Los traslados generan un remito numerado
   para imprimir y que firme el capataz.

   Capas: 1) datos  2) cálculos  3) pantallas  4) formularios  5) remito
          impreso  6) eventos  7) login y arranque
   ===================================================================== */
const sb = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_ANON_KEY);
const BUCKET = 'remitos';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const UNIDADES = ['un','bolsa','kg','tn','m','m²','m³','l','barra','rollo','caja','pallet','juego'];
const TIPOS = {
  traslado:  {chip:'c-tras',   corto:'Remito',          titulo:'Mover con remito',      boton:'Generar remito',
              ayuda:'Los ítems cambian de ubicación al confirmar y se genera un remito numerado para imprimir y que lo firme el capataz.'},
  proveedor: {chip:'c-prov',   corto:'Proveedor',       titulo:'Ingreso de proveedor',  boton:'Registrar ingreso',
              ayuda:'Lo que llega de un proveedor. Se suma al inventario del destino y queda adjunto el remito del proveedor.'},
  alta:      {chip:'c-alta',   corto:'Alta',            titulo:'Cargar lo que ya hay',  boton:'Cargar al inventario',
              ayuda:'Para cargar lo que ya tienen hoy, sin remito. Queda registrado como alta de inventario.'},
  consumo:   {chip:'c-sale',   corto:'Consumo / baja',  titulo:'Consumo o baja',        boton:'Registrar',
              ayuda:'Materiales que se usaron en la obra, o herramientas rotas o perdidas. Se descuentan del inventario.'}
};

const S = {
  me:null, admin:false,
  ubic:[], herr:[], mats:[], stock:[], movs:[], evs:[], loaded:{},
  sel:null, tab:'ubic', verBajas:false,
  urls:{}, vence:{}, firmando:{}, canal:null,
  mov:null, fotosNuevas:[], verId:null
};
try{ S.sel = localStorage.getItem('inv.sel'); }catch(e){}

const fmt = n => (Math.round(Number(n)*1000)/1000).toLocaleString('es-AR');
const hoy = () => new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
const fFecha = f => f ? String(f).slice(0,10).split('-').reverse().join('/') : '';
const fHora = f => new Date(f).toLocaleString('es-AR',{dateStyle:'short',timeStyle:'short'});
const norm = s => String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
const ubicPor = id => S.ubic.find(u=>u.id===id);
const nomUbic = id => id ? (ubicPor(id)?.nombre || 'Ubicación borrada') : '—';
const quien = email => !email ? 'Alguien' : email===S.me ? 'vos' : email.split('@')[0];
const esPdf = p => /\.pdf$/i.test(p||'');
const numRemito = m => m.numero ? 'R-' + String(m.numero).padStart(5,'0') : '';
const porCodigo = (a,b) => String(a.codigo).localeCompare(String(b.codigo),'es',{numeric:true});
const porNombre = (a,b) => String(a.nombre).localeCompare(String(b.nombre),'es',{numeric:true});
function setEstado(txt, cls){ const e=$('#estado'); e.textContent=txt; e.className='pill '+(cls||''); }

/* =====================================================================
   1) DATOS — lectura desde Supabase y tiempo real
   ===================================================================== */
const TABLAS = {
  ubicaciones:      ['ubic',  () => sb.from('ubicaciones').select('*')],
  herramientas:     ['herr',  () => sb.from('herramientas').select('*')],
  materiales:       ['mats',  () => sb.from('materiales').select('*')],
  stock_materiales: ['stock', () => sb.from('stock_materiales').select('*')],
  movimientos:      ['movs',  () => sb.from('movimientos').select('*').order('creado_en',{ascending:false}).limit(1000)],
  eventos:          ['evs',   () => sb.from('eventos').select('*').order('en',{ascending:false}).limit(300)]
};
async function cargar(tabla){
  const [clave, consulta] = TABLAS[tabla];
  const {data, error} = await consulta();
  if(error){
    console.error('Error al leer', tabla, error);
    setEstado(/does not exist|schema cache/i.test(error.message||'') ? 'Falta correr supabase.sql' : 'Error de conexión','bad');
    return;
  }
  S[clave] = data; S.loaded[tabla] = true;
  render();
  if(tabla==='herramientas' || tabla==='materiales') firmarFotos();
  if(tabla==='ubicaciones' && S.tab==='flota') window.flotaRender?.();
}
async function cargarTodo(){
  await Promise.all(Object.keys(TABLAS).map(cargar));
  if(Object.keys(TABLAS).every(t=>S.loaded[t]) && !S.enVivo) setEstado('Conectado','ok');
}

// Tiempo real: cuando alguien cambia algo, Supabase avisa y recargamos esa tabla.
const pendientes = {};
function escucharCambios(){
  if(S.canal) return;
  let ch = sb.channel('inventario-lsg');
  for(const t of Object.keys(TABLAS)){
    ch = ch.on('postgres_changes', {event:'*', schema:'public', table:t}, () => {
      clearTimeout(pendientes[t]); pendientes[t] = setTimeout(()=>cargar(t), 250);
    });
  }
  S.canal = ch.subscribe((st, err) => {
    if(st==='SUBSCRIBED'){ S.enVivo = true; setEstado('En vivo','ok'); }
    else if(st==='CHANNEL_ERROR' || st==='TIMED_OUT' || st==='CLOSED'){
      S.enVivo = false;
      if(err) console.warn('Tiempo real:', st, err);
      if(Object.keys(TABLAS).every(t=>S.loaded[t])) setEstado('Conectado','ok');
    }
  });
  // Respaldo: si el tiempo real no está activo, recarga los datos cada 30 segundos
  clearInterval(S.respaldo);
  S.respaldo = setInterval(()=>{ if(!S.enVivo && S.me && !document.hidden) cargarTodo(); }, 30000);
}

// Fotos: el bucket es privado, así que pedimos "links firmados" que VENCEN.
// Guardamos cuándo vence cada uno (vence[path]) y lo volvemos a pedir antes de que caduque.
const MARGEN_MS = 10*60*1000;                       // renovamos 10 min antes de que venza
const vigente = (urls, vence, p) => !!urls[p] && (vence[p]||0) > Date.now();
async function pedirFirmas(urls, vence, firmando, paths, segundos){
  const falt = [...new Set(paths)].filter(p=>p && !vigente(urls, vence, p) && !firmando[p]);
  if(!falt.length) return false;
  falt.forEach(p=>firmando[p]=1);
  try{
    const {data} = await sb.storage.from(BUCKET).createSignedUrls(falt, segundos);
    const hasta = Date.now() + segundos*1000 - MARGEN_MS;
    (data||[]).forEach(d=>{ if(d.signedUrl){ urls[d.path] = d.signedUrl; vence[d.path] = hasta; } });
    return true;
  } catch(e){ return false; }
  finally { falt.forEach(p=>delete firmando[p]); }   // si falló, se reintenta en el próximo pedido
}
async function firmar(paths){
  if(await pedirFirmas(S.urls, S.vence, S.firmando, paths, 3600) && $('#dlgVer').open) abrirVer(S.verId, true);
}
// Cada 5 minutos, y al volver a la pestaña, renovamos los links que estén por vencer.
function renovarFotos(){
  if(!S.me) return;
  const hayVencidos = Object.keys(S.urls).some(p=>!vigente(S.urls, S.vence, p));
  if(hayVencidos){ firmarFotos(); if($('#dlgVer').open) abrirVer(S.verId, true); }
  window.flotaRenovar?.();
}
setInterval(renovarFotos, 5*60*1000);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) renovarFotos(); });
window.addEventListener('focus', renovarFotos);    // al volver de la suspensión de la compu
window.addEventListener('online', renovarFotos);   // al volver internet
async function comprimir(file){
  if(!file.type.startsWith('image/') || file.type==='image/gif') return file;
  try{
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, 1800/Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width=Math.round(bmp.width*sc); c.height=Math.round(bmp.height*sc);
    c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(res=>c.toBlob(b=>res(b||file),'image/jpeg',0.82));
  }catch(e){ return file; }
}
async function subirArchivos(files, onProgreso){
  const paths = [];
  for(let i=0;i<files.length;i++){
    onProgreso?.(i+1, files.length);
    const blob = await comprimir(files[i]);
    const ext = blob.type==='application/pdf' ? 'pdf' : blob.type==='image/png' ? 'png' : 'jpg';
    const path = `${hoy().slice(0,7)}/${crypto.randomUUID()}.${ext}`;
    const {error} = await sb.storage.from(BUCKET).upload(path, blob, {contentType: blob.type || 'image/jpeg'});
    if(error) throw new Error('No se pudo subir la foto. Revisá la conexión y probá de nuevo.');
    paths.push(path);
  }
  return paths;
}
async function registrarEvento(texto){ await sb.from('eventos').insert({texto, por:S.me}); }

/* ---------- Fotos de herramientas y materiales ---------- */
// Links firmados de 24 h para las fotos de herramientas y materiales (se renuevan solos, ver renovarFotos).
async function firmarFotos(){
  const paths = [...S.herr, ...S.mats].map(x=>x.foto);
  if(!await pedirFirmas(S.urls, S.vence, S.firmando, paths, 86400)) return;
  render();
  if(dlgH?.open) (S.fichaTipo==='mat' ? abrirMat(S.fichaId) : abrirHerr(S.fichaId));
}
const ICONO = {
  lapiz:'<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  tacho:'<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  camara:'<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
};
const miniatura = (path, alt) => path && S.urls[path]
  ? `<img class="thumb" src="${esc(S.urls[path])}" alt="${esc(alt)}" loading="lazy">`
  : `<span class="thumb vacia" aria-hidden="true"></span>`;
function bloqueFoto(path, alt){
  return `<div class="foto-ficha">
    ${path && S.urls[path] ? `<button type="button" class="foto-ver" data-act="verFoto" data-path="${esc(path)}" title="Ampliar"><img src="${esc(S.urls[path])}" alt="${esc(alt)}"></button>`
      : path ? `<div class="foto-vacia">Cargando…</div>`
      : `<div class="foto-vacia">${ICONO.camara}<span>Sin foto</span></div>`}
    ${S.admin ? `<div class="foto-acc">
      <button type="button" class="icono" data-act="cambiarFoto" title="${path?'Cambiar foto':'Agregar foto'}" aria-label="${path?'Cambiar foto':'Agregar foto'}">${ICONO.lapiz}</button>
      ${path?`<button type="button" class="icono peligro" data-act="quitarFotoItem" title="Quitar foto" aria-label="Quitar foto">${ICONO.tacho}</button>`:''}
    </div>` : ''}
  </div>`;
}
async function subirFotoItem(file){
  const tabla = S.fichaTipo==='mat' ? 'materiales' : 'herramientas';
  const ok = $('#hError'); if(ok) ok.hidden = true;
  try{
    const [path] = await subirArchivos([file]);
    const {error} = await sb.from(tabla).update({foto:path}).eq('id', S.fichaId);
    if(error) throw new Error('No se pudo guardar la foto.');
    await cargar(tabla); firmarFotos();
  }catch(e){ if(ok){ ok.textContent = e.message; ok.hidden = false; } }
}
async function quitarFotoItem(btn){
  if(btn.dataset.ok!=='1'){ btn.dataset.ok='1'; btn.classList.add('confirmar'); btn.title='Tocá de nuevo para quitar'; btn.innerHTML = '¿Quitar?'; return; }
  const tabla = S.fichaTipo==='mat' ? 'materiales' : 'herramientas';
  const {error} = await sb.from(tabla).update({foto:null}).eq('id', S.fichaId);
  if(!error){ await cargar(tabla); S.fichaTipo==='mat' ? abrirMat(S.fichaId) : abrirHerr(S.fichaId); }
}

/* =====================================================================
   2) CÁLCULOS — qué hay en cada lugar
   ===================================================================== */
const herrEn = loc => S.herr.filter(h=>!h.de_baja && h.ubicacion_id===loc).sort(porCodigo);
const matPor = id => S.mats.find(m=>m.id===id);
const matsEn = loc => S.stock
  .filter(s=>s.ubicacion_id===loc && Number(s.cantidad)>0)
  .map(s=>({...matPor(s.material_id), cantidad:Number(s.cantidad)}))
  .filter(m=>m.id).sort(porNombre);
const movsDe = loc => S.movs.filter(m=>m.origen_id===loc || m.destino_id===loc);
const sinFirma = m => m.tipo==='traslado' && !(m.fotos||[]).length;
const ubicActivas = () => [...S.ubic].filter(u=>u.activa!==false).sort(ordenUbic);
function ordenUbic(a,b){
  const pa=(a.activa===false?2:0)+(a.tipo==='deposito'?0:1), pb=(b.activa===false?2:0)+(b.tipo==='deposito'?0:1);
  return pa-pb || porNombre(a,b);
}
function resumenItems(items, max=6){
  const txt = (items||[]).map(i => i.clase==='herramienta' ? `${i.codigo} ${i.nombre}` : `${fmt(i.cantidad)} ${i.unidad} ${i.nombre}`);
  return txt.length>max ? txt.slice(0,max).join(', ') + ` y ${txt.length-max} más` : txt.join(', ');
}

/* =====================================================================
   3) PANTALLAS
   ===================================================================== */
function render(){
  if(S.sel && !ubicPor(S.sel)) S.sel=null;
  if(!S.sel && S.ubic.length) S.sel = [...S.ubic].sort(ordenUbic)[0].id;
  renderLista(); renderDetalle(); renderHerr(); renderMov(); renderDatalists();
}

function renderLista(){
  const el = $('#listaUbic');
  if(!S.loaded.ubicaciones){ el.innerHTML='<div class="vacio">Cargando ubicaciones…</div>'; return; }
  if(!S.ubic.length){ el.innerHTML='<div class="vacio"><strong>Sin ubicaciones</strong>Corré el archivo supabase.sql para crear el depósito.</div>'; return; }
  let separado = false;
  el.innerHTML = [...S.ubic].sort(ordenUbic).map(u=>{
    let sep = '';
    if(u.activa===false && !separado){ separado = true; sep = `<p class="lista-sep">Obras finalizadas (${S.ubic.filter(x=>x.activa===false).length})</p>`; }
    const nh = herrEn(u.id).length, nm = matsEn(u.id).length;
    const pend = S.movs.filter(m=>m.destino_id===u.id && sinFirma(m)).length;
    return sep + `<button class="ubic ${u.tipo} ${u.id===S.sel?'on':''} ${u.activa===false?'archivada':''}" data-ubic="${esc(u.id)}">
      <span class="u-tipo">${u.tipo==='deposito'?'Depósito':(u.activa===false?'Obra finalizada':'Obra')}</span>
      <span class="u-nom">${esc(u.nombre)}</span>
      <span class="u-meta">${nh} ${nh===1?'herramienta':'herramientas'} · ${nm} ${nm===1?'material':'materiales'}</span>
      ${pend?`<span class="u-pend">${pend} ${pend===1?'remito':'remitos'} sin firma</span>`:''}</button>`;
  }).join('');
}

function renderDetalle(){
  const el = $('#detalle');
  const u = ubicPor(S.sel);
  if(!u){ el.innerHTML=''; return; }
  const herrs = herrEn(u.id), mats = matsEn(u.id), movs = movsDe(u.id);
  const ultimo = movs.find(m=>m.tipo==='traslado' && m.destino_id===u.id);
  const pend = movs.filter(m=>m.destino_id===u.id && sinFirma(m));
  firmar(movs.slice(0,20).flatMap(m=>(m.fotos||[]).slice(0,3)).filter(p=>!esPdf(p)));
  el.innerHTML = `<div class="det">
    <div class="det-head">
      <div><span class="u-tipo ${u.tipo}">${u.tipo==='deposito'?'Depósito':(u.activa===false?'Obra finalizada':'Obra')}</span>
        <h2>${esc(u.nombre)}</h2>
        ${u.direccion?`<p class="muted" style="margin:4px 0 0">${esc(u.direccion)}</p>`:''}
        ${ultimo?`<p class="a-cargo">Último remito: <strong>${numRemito(ultimo)}</strong> · ${fFecha(ultimo.fecha)}${ultimo.recibe?` · recibió ${esc(ultimo.recibe)}`:''}</p>`:''}
      </div>
      <div class="det-actions">
      ${S.admin && u.activa!==false ? `
        <button class="btn primary sm" data-act="nuevoMov" data-tipo="traslado" ${herrs.length||mats.length?'':'disabled title="No hay nada para mover"'}>Mover con remito</button>
        <button class="btn sm" data-act="nuevoMov" data-tipo="alta">Cargar lo que ya hay</button>
        <button class="btn sm" data-act="nuevoMov" data-tipo="proveedor">Ingreso de proveedor</button>
        <button class="btn sm" data-act="nuevoMov" data-tipo="consumo" ${herrs.length||mats.length?'':'disabled'}>Consumo o baja</button>` : ''}
        <button class="btn sm" data-act="informe">Informe de ${u.tipo==='deposito'?'depósito':'obra'}</button>
        ${S.admin && u.tipo==='obra' && u.activa!==false ? '<button class="btn sm fin" data-act="finalizar">Finalizar obra</button>' : ''}
        ${S.admin ? `<button class="btn ghost sm" data-act="editarUbic">${u.activa===false?'Reabrir / editar':'Editar'}</button>` : ''}
      </div>
    </div>
    ${u.activa===false ? `<p class="aviso fin">Obra finalizada${fechaFinal(u)?` el ${fFecha(fechaFinal(u))}`:''}. Todo su historial queda guardado: usá <strong>Informe de obra</strong> para verlo o guardarlo en PDF.</p>` : ''}
    ${pend.length?`<p class="aviso">Falta cargar la foto firmada de ${pend.length===1?'1 remito':pend.length+' remitos'}: ${pend.map(m=>`<button class="link" data-mov="${esc(m.id)}">${numRemito(m)}</button>`).join(', ')}</p>`:''}
    <div class="seccion">
      <h3>Herramientas y equipos (${herrs.length})</h3>
      ${herrs.length?`<div class="tabla-wrap"><table><thead><tr><th class="col-foto"></th><th>Código</th><th>Herramienta</th><th>Descripción</th></tr></thead><tbody>
        ${herrs.map(h=>`<tr class="click" data-herr="${esc(h.id)}" tabindex="0"><td class="col-foto">${miniatura(h.foto, h.nombre)}</td><td class="mono">${esc(h.codigo)}</td><td>${esc(h.nombre)}</td><td class="muted">${esc(h.descripcion)}</td></tr>`).join('')}
      </tbody></table></div>`:`<div class="vacio">No hay herramientas acá.</div>`}
    </div>
    <div class="seccion">
      <h3>Materiales (${mats.length})</h3>
      ${mats.length?`<div class="tabla-wrap"><table><thead><tr><th class="col-foto"></th><th>Material</th><th class="num">Cantidad</th><th>Unidad</th></tr></thead><tbody>
        ${mats.map(m=>`<tr class="click" data-mat="${esc(m.id)}" tabindex="0"><td class="col-foto">${miniatura(m.foto, m.nombre)}</td><td>${esc(m.nombre)}</td><td class="num">${fmt(m.cantidad)}</td><td>${esc(m.unidad)}</td></tr>`).join('')}
      </tbody></table></div>`:`<div class="vacio">No hay materiales acá.</div>`}
    </div>
    <div class="seccion">
      <h3>Movimientos (${movs.length})</h3>
      ${movs.length?`<div class="remitos">${movs.slice(0,25).map(m=>tarjetaMov(m,u.id)).join('')}</div>`:'<div class="vacio">Sin movimientos todavía.</div>'}
    </div>
  </div>`;
}

function descMov(m, loc){
  switch(m.tipo){
    case 'traslado':
      if(loc===m.origen_id) return `Salió hacia ${nomUbic(m.destino_id)}`;
      if(loc===m.destino_id) return `Llegó desde ${nomUbic(m.origen_id)}`;
      return `${nomUbic(m.origen_id)} → ${nomUbic(m.destino_id)}`;
    case 'proveedor': return `Ingreso de ${m.proveedor || 'proveedor'}${loc ? '' : ' a ' + nomUbic(m.destino_id)}`;
    case 'alta':      return `Alta de inventario${loc ? '' : ' en ' + nomUbic(m.destino_id)}`;
    case 'consumo':   return `Consumo o baja${loc ? '' : ' en ' + nomUbic(m.origen_id)}`;
  }
  return '';
}
function chipsMov(m){
  const t = TIPOS[m.tipo];
  let h = `<span class="chip ${t.chip}">${m.tipo==='traslado' ? numRemito(m) : t.corto}</span>`;
  if(m.tipo==='traslado') h += (m.fotos||[]).length ? '<span class="chip c-ok">Firmado</span>' : '<span class="chip c-pend">Sin firma</span>';
  return h;
}
function tarjetaMov(m, loc){
  return `<button class="remito" data-mov="${esc(m.id)}">
    <span class="r-top"><span class="r-chips">${chipsMov(m)}</span><span class="mono muted">${fFecha(m.fecha)}</span></span>
    <span class="r-dir">${esc(descMov(m, loc))}</span>
    ${m.tipo==='traslado' && m.recibe?`<span class="r-recibe">Recibe: ${esc(m.recibe)}</span>`:''}
    <span class="r-items">${esc(resumenItems(m.items))}</span>
  </button>`;
}

function renderHerr(){
  const el = $('#listaHerr');
  if(!S.loaded.herramientas){ el.innerHTML='<div class="vacio">Cargando…</div>'; return; }
  const q = norm($('#buscaHerr').value);
  const todas = S.herr.filter(h=>S.verBajas || !h.de_baja).sort(porCodigo);
  const lista = todas.filter(h=>!q || norm(`${h.codigo} ${h.nombre} ${h.descripcion} ${nomUbic(h.ubicacion_id)}`).includes(q));
  const nBajas = S.herr.filter(h=>h.de_baja).length;
  el.innerHTML = `
    <p class="muted conteo">${lista.length} de ${todas.length} ${todas.length===1?'herramienta':'herramientas'}
      ${nBajas?` · <label class="check inline"><input type="checkbox" id="verBajas" ${S.verBajas?'checked':''}> Mostrar las ${nBajas} dadas de baja</label>`:''}</p>
    ${lista.length?`<div class="tabla-wrap"><table><thead><tr><th class="col-foto"></th><th>Código</th><th>Herramienta</th><th>Dónde está</th><th>Descripción</th></tr></thead><tbody>
      ${lista.map(h=>`<tr class="click ${h.de_baja?'baja':''}" data-herr="${esc(h.id)}" tabindex="0"><td class="col-foto">${miniatura(h.foto, h.nombre)}</td><td class="mono">${esc(h.codigo)}</td><td>${esc(h.nombre)}</td>
        <td>${h.de_baja?'<span class="chip c-sale">De baja</span>':esc(nomUbic(h.ubicacion_id))}</td><td class="muted">${esc(h.descripcion)}</td></tr>`).join('')}
    </tbody></table></div>`:`<div class="vacio"><strong>${q?'Sin resultados':'Sin herramientas todavía'}</strong>${q?'Probá con otra palabra.':(S.admin?'Cargalas desde una ubicación con "Cargar lo que ya hay".':'')}</div>`}`;
}

function renderMov(){
  const el = $('#listaMov');
  if(!S.loaded.movimientos){ el.innerHTML='<div class="vacio">Cargando…</div>'; return; }
  const q = norm($('#buscaMov').value), f = $('#filtroMov').value;
  let lista = S.movs.filter(m => f==='todos' || (f==='pendientes' ? sinFirma(m) : m.tipo===f))
    .map(m=>({k:'m', en:m.creado_en, m}));
  if(f==='todos') lista = lista.concat(S.evs.map(e=>({k:'e', en:e.en, e})));
  lista = lista.filter(x => !q || norm(x.k==='m'
      ? `${numRemito(x.m)} ${x.m.recibe} ${x.m.proveedor} ${x.m.numero_proveedor} ${descMov(x.m)} ${resumenItems(x.m.items, 999)} ${x.m.nota}`
      : x.e.texto).includes(q))
    .sort((a,b)=>String(b.en).localeCompare(String(a.en)));
  if(!lista.length){ el.innerHTML=`<div class="vacio"><strong>${q||f!=='todos'?'Sin resultados':'Sin movimientos todavía'}</strong>${q||f!=='todos'?'Probá con otro filtro.':'Cada alta, ingreso, remito y consumo queda registrado acá.'}</div>`; return; }
  let dia='', html='';
  for(const x of lista.slice(0,300)){
    const d = new Date(x.en);
    const ds = d.toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    if(ds!==dia){ dia=ds; html+=`<h3 class="dia">${esc(ds)}</h3>`; }
    const hora = d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
    if(x.k==='e'){
      html += `<div class="mov"><span class="hora">${hora}</span><span class="txt">${esc(x.e.texto)}</span><span class="por">por ${esc(quien(x.e.por))}</span></div>`;
    }else{
      const m = x.m;
      html += `<div class="mov click" data-mov="${esc(m.id)}" role="button" tabindex="0"><span class="hora">${hora}</span>
        <span class="txt"><span class="r-chips">${chipsMov(m)}</span> ${esc(descMov(m))}${m.tipo==='traslado' && m.recibe?` · recibe ${esc(m.recibe)}`:''}</span>
        <span class="antes">${esc(resumenItems(m.items))}</span>
        <span class="por">por ${esc(quien(m.creado_por))}</span></div>`;
    }
  }
  el.innerHTML = html;
}

function renderDatalists(){
  const uniq = arr => [...new Set(arr.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  $('#dlMat').innerHTML = uniq(S.mats.map(m=>m.nombre)).map(v=>`<option value="${esc(v)}">`).join('');
  $('#dlHerr').innerHTML = uniq(S.herr.map(h=>h.nombre.replace(/\s+\d+$/,''))).map(v=>`<option value="${esc(v)}">`).join('');
  $('#dlProv').innerHTML = uniq(S.movs.map(m=>m.proveedor)).map(v=>`<option value="${esc(v)}">`).join('');
}

/* =====================================================================
   4) FORMULARIO DE MOVIMIENTO
   ===================================================================== */
const dlgM = $('#dlgMov');
const tipoMov = () => document.querySelector('input[name=mtipo]:checked').value;
const usaOrigen = t => t==='traslado' || t==='consumo';

function opcionesUbic(sel, valor){
  sel.innerHTML = ubicActivas().map(u=>`<option value="${esc(u.id)}" ${u.id===valor?'selected':''}>${esc(u.nombre)}${u.tipo==='deposito'?' (depósito)':''}</option>`).join('');
  if(valor && sel.value!==valor) sel.value = ubicActivas()[0]?.id || '';
}
const filaHerrHTML = () => `<div class="fh">
  <input class="hn" list="dlHerr" placeholder="Nombre completo (ej. Trompo hormigonero)" aria-label="Nombre de la herramienta" autocomplete="off">
  <input class="hd" placeholder="Marca / modelo (opcional)" aria-label="Descripción" autocomplete="off">
  <input class="hc" type="number" min="1" step="1" value="1" inputmode="numeric" aria-label="Unidades" title="Unidades">
  <button type="button" class="x" data-act="quitarFila" aria-label="Quitar">×</button></div>`;
const filaMatHTML = () => `<div class="fm">
  <input class="mn" list="dlMat" placeholder="Material (ej. Cemento 50 kg)" aria-label="Material" autocomplete="off">
  <input class="mc" type="number" min="0" step="any" inputmode="decimal" placeholder="Cant." aria-label="Cantidad">
  <select class="mu" aria-label="Unidad">${UNIDADES.map(u=>`<option>${u}</option>`).join('')}</select>
  <button type="button" class="x" data-act="quitarFila" aria-label="Quitar">×</button></div>`;

function abrirMov({tipo='traslado', origen, destino, todo=false, nota=''}={}){
  S.mov = {sel:new Set(), qty:{}};
  if(todo && origen){
    herrEn(origen).forEach(h=>S.mov.sel.add(h.id));
    matsEn(origen).forEach(m=>S.mov.qty[m.id] = m.cantidad);
  }
  S.fotosNuevas.forEach(f=>URL.revokeObjectURL(f.url)); S.fotosNuevas = [];
  document.querySelector(`input[name=mtipo][value=${tipo}]`).checked = true;
  opcionesUbic($('#mOrigen'), origen || S.sel);
  opcionesUbic($('#mDestino'), destino || S.sel);
  ['#mProv','#mNumProv','#mEntrega','#mNota','#mFiltroHerr'].forEach(s=>$(s).value='');
  $('#mFecha').value = hoy(); $('#mFoto').value = '';
  if(nota) $('#mNota').value = nota;
  $('#filasHerr').innerHTML = filaHerrHTML();
  $('#filasMat').innerHTML = filaMatHTML();
  $('#mError').hidden = true;
  $('#mGuardar').disabled = false;
  renderPreviews();
  aplicarTipo();
  dlgM.showModal();
}

function aplicarTipo(){
  const t = tipoMov(), info = TIPOS[t];
  $('#mTitulo').textContent = info.titulo;
  $('#mAyuda').textContent = info.ayuda;
  $('#mGuardar').textContent = info.boton;
  $('#wOrigen').hidden = !usaOrigen(t);
  $('#wDestino').hidden = t==='consumo';
  $('#lDestino').textContent = t==='traslado' ? 'Va a' : 'Se carga en';
  $('#wProv').hidden = $('#wNumProv').hidden = $('#wFoto').hidden = t!=='proveedor';
  $('#wEntrega').hidden = t!=='traslado';
  $('#bHerrSel').hidden = $('#bMatSel').hidden = !usaOrigen(t);
  $('#bHerrNew').hidden = $('#bMatNew').hidden = usaOrigen(t);
  $('#lNota').textContent = t==='consumo' ? 'Motivo (ej. usado en la platea, se rompió, se perdió)' : 'Observaciones';
  $('#lHerrSel').textContent = t==='consumo' ? 'Herramientas a dar de baja' : 'Herramientas a mover';
  if(t==='traslado' && $('#mDestino').value===$('#mOrigen').value){
    const otra = ubicActivas().find(u=>u.id!==$('#mOrigen').value);
    if(otra) $('#mDestino').value = otra.id;
  }
  renderSeleccion();
}

// Lista de lo que hay en el origen, para tildar herramientas y poner cantidades de materiales
function renderSeleccion(){
  if(!S.mov || !usaOrigen(tipoMov())) return;
  const o = $('#mOrigen').value, q = norm($('#mFiltroHerr').value);
  const herrs = herrEn(o);
  for(const id of [...S.mov.sel]) if(!herrs.some(h=>h.id===id)) S.mov.sel.delete(id);
  const vis = herrs.filter(h=>!q || norm(`${h.codigo} ${h.nombre} ${h.descripcion}`).includes(q));
  $('#mFiltroHerr').hidden = herrs.length < 8;
  $('#listaHerrSel').innerHTML = !herrs.length ? `<div class="vacio chico">No hay herramientas en ${esc(nomUbic(o))}.</div>` :
    `<div class="ck-todas"><button type="button" class="link" data-act="todasHerr">Seleccionar ${q?'las filtradas':'todas'}</button> · <button type="button" class="link" data-act="ningunaHerr">Ninguna</button></div>` +
    vis.map(h=>`<label class="ck"><input type="checkbox" data-h="${esc(h.id)}" ${S.mov.sel.has(h.id)?'checked':''}>
      <span class="mono">${esc(h.codigo)}</span><span class="ck-nom">${esc(h.nombre)}${h.descripcion?` <small class="muted">${esc(h.descripcion)}</small>`:''}</span></label>`).join('');
  $('#cHerrSel').textContent = herrs.length ? `${S.mov.sel.size} de ${herrs.length}` : '';
  const mats = matsEn(o);
  $('#listaMatSel').innerHTML = !mats.length ? `<div class="vacio chico">No hay materiales en ${esc(nomUbic(o))}.</div>` :
    mats.map(m=>`<div class="ms">
      <span class="ms-nom">${esc(m.nombre)}<small class="muted">Hay ${fmt(m.cantidad)} ${esc(m.unidad)}</small></span>
      <input type="number" min="0" max="${m.cantidad}" step="any" inputmode="decimal" data-m="${esc(m.id)}" value="${S.mov.qty[m.id] ?? ''}" placeholder="0" aria-label="Cantidad de ${esc(m.nombre)}">
      <span class="ms-u">${esc(m.unidad)}</span>
      <button type="button" class="btn ghost sm" data-act="todoMat" data-m="${esc(m.id)}" data-max="${m.cantidad}">Todo</button></div>`).join('');
}

function renderPreviews(){
  $('#previews').innerHTML = S.fotosNuevas.map((f,i)=>`<span class="prev">${f.file.type==='application/pdf'?'<span class="pdf">PDF</span>':`<img src="${esc(f.url)}" alt="Remito adjunto">`}
    <button type="button" data-act="quitarFoto" data-n="${i}" aria-label="Quitar">×</button></span>`).join('');
}
function errorMov(msg){ const e=$('#mError'); e.textContent=msg; e.hidden=false; e.scrollIntoView({block:'nearest'}); }

async function guardarMov(ev){
  ev.preventDefault();
  $('#mError').hidden = true;
  const t = tipoMov();
  const p = {tipo:t, fecha:$('#mFecha').value || hoy(), nota:$('#mNota').value.trim()};

  if(usaOrigen(t)){
    p.origen_id = $('#mOrigen').value;
    p.herramientas = [...S.mov.sel].map(id=>({id}));
    const disponibles = Object.fromEntries(matsEn(p.origen_id).map(m=>[m.id, m]));
    p.materiales = [];
    for(const [id, c] of Object.entries(S.mov.qty)){
      const cant = Number(c); if(!(cant>0)) continue;
      const m = disponibles[id];
      if(!m) continue;
      if(cant > m.cantidad + 1e-9) return errorMov(`En ${nomUbic(p.origen_id)} hay ${fmt(m.cantidad)} ${m.unidad} de ${m.nombre}. Corregí la cantidad.`);
      p.materiales.push({id, cantidad:cant});
    }
  }else{
    p.destino_id = $('#mDestino').value;
    p.herramientas = []; p.materiales = [];
    for(const f of $$('#filasHerr .fh')){
      const nombre = f.querySelector('.hn').value.trim(), descripcion = f.querySelector('.hd').value.trim();
      const cantidad = parseInt(f.querySelector('.hc').value, 10);
      if(!nombre && !descripcion) continue;
      if(!nombre) return errorMov('Hay una herramienta sin nombre.');
      if(!(cantidad>=1)) return errorMov(`Poné cuántas unidades de "${nombre}" son (mínimo 1).`);
      p.herramientas.push({nombre, descripcion, cantidad});
    }
    for(const f of $$('#filasMat .fm')){
      const nombre = f.querySelector('.mn').value.trim(), cantidad = Number(f.querySelector('.mc').value), unidad = f.querySelector('.mu').value;
      if(!nombre && !f.querySelector('.mc').value) continue;
      if(!nombre) return errorMov('Hay un material con cantidad pero sin nombre.');
      if(!(cantidad>0)) return errorMov(`Poné una cantidad mayor a cero para "${nombre}".`);
      p.materiales.push({nombre, cantidad, unidad});
    }
  }
  if(t==='traslado'){
    p.destino_id = $('#mDestino').value;
    p.entrega = $('#mEntrega').value.trim();   // quien recibe firma a mano en el remito impreso (aclaración y DNI)
    if(p.destino_id===p.origen_id) return errorMov('El origen y el destino tienen que ser distintos.');
  }
  if(t==='proveedor'){ p.proveedor = $('#mProv').value.trim(); p.numero_proveedor = $('#mNumProv').value.trim(); }
  if(!p.herramientas.length && !p.materiales.length){
    return errorMov(usaOrigen(t) ? 'Tildá al menos una herramienta o poné la cantidad de algún material.' : 'Agregá al menos una herramienta o un material.');
  }
  // Las herramientas nuevas (alta/proveedor) se mostrarán con aviso si el nombre ya existe en otro lugar
  const btn = $('#mGuardar'); btn.disabled = true;
  try{
    if(t==='proveedor' && S.fotosNuevas.length){
      p.fotos = await subirArchivos(S.fotosNuevas.map(f=>f.file), (i,n)=>btn.textContent=`Subiendo foto ${i} de ${n}…`);
    }
    btn.textContent = 'Guardando…';
    const {data, error} = await sb.rpc('registrar_movimiento', {p});
    if(error) throw new Error(error.message);
    S.fotosNuevas.forEach(f=>URL.revokeObjectURL(f.url)); S.fotosNuevas = [];
    dlgM.close();
    await Promise.all(['herramientas','materiales','stock_materiales','movimientos'].map(cargar));
    if(t==='traslado') abrirVer(data.id, false, true);
  }catch(e){
    btn.disabled = false; btn.textContent = TIPOS[t].boton;
    errorMov(e.message || 'No se pudo guardar. Revisá la conexión y probá de nuevo.');
  }
}

/* ---------- Ver un movimiento / remito ---------- */
const dlgV = $('#dlgVer');
function abrirVer(id, soloRepintar, recienCreado){
  const m = S.movs.find(x=>x.id===id); if(!m) return;
  S.verId = id;
  firmar(m.fotos||[]);
  const t = TIPOS[m.tipo];
  $('#vTitulo').textContent = m.tipo==='traslado' ? `Remito ${numRemito(m)}` : t.titulo;
  const herrs = (m.items||[]).filter(i=>i.clase==='herramienta'), mats = (m.items||[]).filter(i=>i.clase==='material');
  $('#vBody').innerHTML = `
    ${recienCreado?`<p class="ok">Remito generado. Los ítems ya figuran en ${esc(nomUbic(m.destino_id))}. Imprimilo para que lo firme quien recibe.</p>`:''}
    <div class="r-top"><span class="r-chips">${chipsMov(m)}</span><span class="mono muted">${fFecha(m.fecha)}</span></div>
    <dl class="kv">
      ${m.origen_id?`<dt>Sale de</dt><dd>${esc(nomUbic(m.origen_id))}</dd>`:''}
      ${m.destino_id?`<dt>${m.tipo==='traslado'?'Va a':'Se cargó en'}</dt><dd>${esc(nomUbic(m.destino_id))}</dd>`:''}
      ${m.tipo==='proveedor'?`<dt>Proveedor</dt><dd>${esc(m.proveedor||'—')}</dd>${m.numero_proveedor?`<dt>N° remito prov.</dt><dd class="mono">${esc(m.numero_proveedor)}</dd>`:''}`:''}
      ${m.tipo==='traslado'?`${m.recibe?`<dt>Recibe</dt><dd><strong>${esc(m.recibe)}</strong></dd>`:''}${m.entrega?`<dt>Entrega</dt><dd>${esc(m.entrega)}</dd>`:''}`:''}
      <dt>Registrado</dt><dd>por ${esc(quien(m.creado_por))}, ${fHora(m.creado_en)}</dd>
    </dl>
    ${herrs.length?`<div class="tabla-wrap"><table><thead><tr><th>Código</th><th>Herramienta</th></tr></thead><tbody>
      ${herrs.map(i=>`<tr><td class="mono">${esc(i.codigo)}</td><td>${esc(i.nombre)}</td></tr>`).join('')}</tbody></table></div>`:''}
    ${mats.length?`<div class="tabla-wrap"><table><thead><tr><th>Material</th><th class="num">Cantidad</th><th>Unidad</th></tr></thead><tbody>
      ${mats.map(i=>`<tr><td>${esc(i.nombre)}</td><td class="num">${fmt(i.cantidad)}</td><td>${esc(i.unidad)}</td></tr>`).join('')}</tbody></table></div>`:''}
    ${m.nota?`<p style="margin:0"><span class="lbl">${m.tipo==='consumo'?'Motivo':'Observaciones'}</span>${esc(m.nota)}</p>`:''}
    <div class="ver-fotos"><span class="lbl">${m.tipo==='traslado'?'Remito firmado':'Fotos adjuntas'}</span>
      ${(m.fotos||[]).length ? m.fotos.map(p=>{ const u=S.urls[p];
          if(!u) return '<span class="muted">Cargando archivo…</span>';
          return esPdf(p) ? `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">Abrir PDF</a>`
                          : `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Foto del remito"></a>`; }).join('')
        : `<p class="nota-ro">${m.tipo==='traslado'?'Todavía no se cargó la foto del remito firmado.':'Sin fotos.'}</p>`}
    </div>`;
  $('#vFoot').innerHTML = `
    <button type="button" class="btn ${m.tipo==='traslado'&&!(m.fotos||[]).length?'':'primary'}" data-act="imprimir">${m.tipo==='traslado'?'Imprimir remito':'Imprimir comprobante'}</button>
    ${S.admin?`<button type="button" class="btn ${m.tipo==='traslado'&&!(m.fotos||[]).length?'primary':''}" data-act="subirFirmado">${m.tipo==='traslado'?'Subir remito firmado':'Agregar foto'}</button>`:''}
    <button type="button" class="btn ghost" data-close>Cerrar</button>`;
  if(!dlgV.open) dlgV.showModal();
}

async function subirFirmado(files){
  const m = S.movs.find(x=>x.id===S.verId); if(!m || !files.length) return;
  const btn = document.querySelector('[data-act="subirFirmado"]');
  if(btn){ btn.disabled = true; }
  try{
    const nuevas = await subirArchivos(files, (i,n)=>{ if(btn) btn.textContent=`Subiendo ${i} de ${n}…`; });
    const {error} = await sb.from('movimientos').update({fotos:[...(m.fotos||[]), ...nuevas]}).eq('id', m.id);
    if(error) throw new Error('No se pudo adjuntar la foto. Probá de nuevo.');
    await cargar('movimientos');
    abrirVer(m.id, true);
  }catch(e){
    if(btn){ btn.disabled=false; btn.textContent='Subir remito firmado'; }
    $('#vBody').insertAdjacentHTML('afterbegin', `<p class="error">${esc(e.message)}</p>`);
  }
}

/* ---------- Herramienta: ficha, historial y renombrar ---------- */
const dlgH = $('#dlgHerr');
let herrAbierta = null;
function abrirHerr(id){
  const h = S.herr.find(x=>x.id===id); if(!h) return;
  herrAbierta = id; S.fichaTipo = 'herr'; S.fichaId = id;
  const hist = S.movs.filter(m=>(m.items||[]).some(i=>i.clase==='herramienta' && i.id===id));
  const borrador = dlgH.open && $('#hNombre') ? {n:$('#hNombre').value, d:$('#hDesc').value} : null;
  $('#hTitulo').textContent = h.codigo;
  $('#hBody').innerHTML = `
    <div class="ficha-top">
      <dl class="kv">
        <dt>Código</dt><dd class="mono">${esc(h.codigo)}</dd>
        <dt>Dónde está</dt><dd>${h.de_baja?'<span class="chip c-sale">Dada de baja</span>':`<strong>${esc(nomUbic(h.ubicacion_id))}</strong>`}</dd>
      </dl>
      ${bloqueFoto(h.foto, h.nombre)}
    </div>
    ${S.admin?`<label><span>Nombre</span><input id="hNombre" value="${esc(h.nombre)}" autocomplete="off"></label>
      <label><span>Marca / modelo / descripción</span><input id="hDesc" value="${esc(h.descripcion)}" autocomplete="off"></label>
      <p id="hError" class="error" hidden></p>`
      :`<dl class="kv"><dt>Nombre</dt><dd>${esc(h.nombre)}</dd>${h.descripcion?`<dt>Descripción</dt><dd>${esc(h.descripcion)}</dd>`:''}</dl>`}
    <div class="seccion"><h3>Historial (${hist.length})</h3>
      ${hist.length?`<div class="remitos">${hist.map(m=>tarjetaMov(m)).join('')}</div>`:'<div class="vacio chico">Sin movimientos.</div>'}</div>`;
  if(borrador){ $('#hNombre').value = borrador.n; $('#hDesc').value = borrador.d; }
  $('#hFoot').innerHTML = S.admin
    ? `<button type="button" class="btn" data-close>Cerrar</button><button type="button" class="btn primary" data-act="guardarHerr">Guardar cambios</button>`
    : `<button type="button" class="btn primary" data-close>Cerrar</button>`;
  if(!dlgH.open) dlgH.showModal();
}
async function guardarHerr(){
  const h = S.herr.find(x=>x.id===herrAbierta); if(!h) return;
  const nombre = $('#hNombre').value.trim(), descripcion = $('#hDesc').value.trim();
  if(!nombre){ $('#hError').textContent='El nombre no puede quedar vacío.'; $('#hError').hidden=false; return; }
  if(nombre===h.nombre && descripcion===h.descripcion){ dlgH.close(); return; }
  const {error} = await sb.from('herramientas').update({nombre, descripcion}).eq('id', h.id);
  if(error){ $('#hError').textContent='No se pudo guardar. Probá de nuevo.'; $('#hError').hidden=false; return; }
  if(nombre!==h.nombre) await registrarEvento(`Renombró ${h.codigo}: “${h.nombre}” → “${nombre}”`);
  dlgH.close(); cargar('herramientas'); cargar('eventos');
}

/* ---------- Material: ficha con foto, dónde hay y historial ---------- */
function abrirMat(id){
  const m = matPor(id); if(!m) return;
  S.fichaTipo = 'mat'; S.fichaId = id;
  const donde = S.stock.filter(s=>s.material_id===id && Number(s.cantidad)>0);
  const hist = S.movs.filter(x=>(x.items||[]).some(i=>i.clase==='material' && i.id===id));
  const borrador = dlgH.open && $('#mNombreF') ? $('#mNombreF').value : null;
  $('#hTitulo').textContent = m.nombre;
  $('#hBody').innerHTML = `
    <div class="ficha-top">
      <dl class="kv"><dt>Unidad</dt><dd>${esc(m.unidad)}</dd>
        <dt>Total</dt><dd><strong>${fmt(donde.reduce((t,s)=>t+Number(s.cantidad),0))} ${esc(m.unidad)}</strong></dd></dl>
      ${bloqueFoto(m.foto, m.nombre)}
    </div>
    ${S.admin?`<label><span>Nombre</span><input id="mNombreF" value="${esc(m.nombre)}" autocomplete="off"></label><p id="hError" class="error" hidden></p>`:''}
    <div class="seccion"><h3>Dónde hay</h3>
      ${donde.length?`<div class="tabla-wrap"><table><tbody>${donde.map(s=>`<tr><td>${esc(nomUbic(s.ubicacion_id))}</td><td class="num">${fmt(s.cantidad)} ${esc(m.unidad)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="vacio chico">No hay stock en ninguna ubicación.</div>'}</div>
    <div class="seccion"><h3>Historial (${hist.length})</h3>
      ${hist.length?`<div class="remitos">${hist.slice(0,30).map(x=>tarjetaMov(x)).join('')}</div>`:'<div class="vacio chico">Sin movimientos.</div>'}</div>`;
  if(borrador!=null) $('#mNombreF').value = borrador;
  $('#hFoot').innerHTML = S.admin
    ? `<button type="button" class="btn" data-close>Cerrar</button><button type="button" class="btn primary" data-act="guardarMat">Guardar cambios</button>`
    : `<button type="button" class="btn primary" data-close>Cerrar</button>`;
  if(!dlgH.open) dlgH.showModal();
}
async function guardarMat(){
  const m = matPor(S.fichaId); if(!m) return;
  const nombre = $('#mNombreF').value.trim();
  if(!nombre){ $('#hError').textContent='El nombre no puede quedar vacío.'; $('#hError').hidden=false; return; }
  if(nombre===m.nombre){ dlgH.close(); return; }
  const {error} = await sb.from('materiales').update({nombre}).eq('id', m.id);
  if(error){ $('#hError').textContent = /duplicate/i.test(error.message) ? 'Ya hay un material con ese nombre y unidad.' : 'No se pudo guardar.'; $('#hError').hidden=false; return; }
  await registrarEvento(`Renombró el material “${m.nombre}” → “${nombre}”`);
  dlgH.close(); cargar('materiales'); cargar('eventos');
}

/* ---------- Ubicaciones (obras y depósito) ---------- */
const dlgU = $('#dlgUbic');
let ubicEdit = null;
function abrirUbic(id){
  const u = id ? ubicPor(id) : null; ubicEdit = u?.id || null;
  $('#uTitulo').textContent = u ? 'Editar ubicación' : 'Nueva obra';
  $('#uNombre').value = u?.nombre || ''; $('#uDir').value = u?.direccion || '';
  document.querySelector(`input[name=utipo][value=${u?.tipo||'obra'}]`).checked = true;
  $('#wrapActiva').hidden = !u; $('#uActiva').checked = u?.activa !== false;
  $('#uError').hidden = true; $('#uGuardar').disabled = false;
  dlgU.showModal(); $('#uNombre').focus();
}
async function guardarUbic(ev){
  ev.preventDefault();
  const nombre = $('#uNombre').value.trim();
  const err = m => { $('#uError').textContent=m; $('#uError').hidden=false; };
  if(!nombre) return err('Poné un nombre para la obra o el depósito.');
  if(S.ubic.some(u=>u.id!==ubicEdit && norm(u.nombre)===norm(nombre))) return err('Ya existe una ubicación con ese nombre.');
  const previo = ubicEdit ? ubicPor(ubicEdit) : null;
  const fila = {nombre, tipo:document.querySelector('input[name=utipo]:checked').value, direccion:$('#uDir').value.trim(), activa: previo ? $('#uActiva').checked : true};
  if(previo && previo.activa!==false && !fila.activa && (herrEn(previo.id).length || matsEn(previo.id).length))
    return err('Esta obra todavía tiene herramientas o materiales. Movelos con un remito antes de marcarla como terminada.');
  $('#uGuardar').disabled = true;
  const {data, error} = previo ? await sb.from('ubicaciones').update(fila).eq('id',previo.id).select().single()
                               : await sb.from('ubicaciones').insert(fila).select().single();
  if(error){ $('#uGuardar').disabled=false; return err('No se pudo guardar. Probá de nuevo.'); }
  let texto = previo ? (previo.nombre!==nombre ? `Renombró “${previo.nombre}” a “${nombre}”` : `Editó la ubicación ${nombre}`) : `Agregó ${fila.tipo==='deposito'?'el depósito':'la obra'} ${nombre}`;
  if(previo && previo.activa!==false && !fila.activa) texto = `Finalizó la obra ${nombre}`;
  if(previo && previo.activa===false && fila.activa) texto = `Reabrió la obra ${nombre}`;
  await registrarEvento(texto);
  S.sel = data.id; guardarSel(); dlgU.close();
  cargar('ubicaciones'); cargar('eventos');
}
function guardarSel(){ try{ localStorage.setItem('inv.sel', S.sel||''); }catch(e){} }

/* =====================================================================
   5) REMITO IMPRESO — mismo formato que el remito en papel de LSG
   Los datos fijos de la empresa están en EMPRESA: si cambia algo
   (dirección, teléfono), se edita solo acá.
   ===================================================================== */
const EMPRESA = {
  razon:      'LSG ARGENTINA SRL',
  codigo:     '931',                       // código de cliente interno que figura en el papel
  domicilio:  'JOSE E. RODO 7237',
  localidad:  'MATADEROS, Ciudad de Buenos Aires',
  ubicacion:  'Ciudad de Buenos Aires',
  telefono:   '11-41715215',
  iva:        'Responsable Inscripto',
  cuit:       '30715751441',
  iibb:       '5702578',
  inicio:     '31/08/2017',
  letra:      '',                          // en blanco. "R" es el remito fiscal (Cód. 91): consultá con el contador antes de usarla
  leyendaLetra: ''                         // texto chico debajo del recuadro de la letra (vacío = no se muestra)
};
const TITULOS = {traslado:'Remito interno', proveedor:'Ingreso de proveedor', alta:'Alta de inventario', consumo:'Consumo / baja'};

// SOLO PARA EL PAPEL: las herramientas iguales se agrupan en una línea.
// "BALDE DE ALBAÑIL 1" … "BALDE DE ALBAÑIL 5" (misma descripción) → 5 · BAL-005 a 009 · BALDE DE ALBAÑIL.
// En el sistema cada una sigue siendo una unidad con su código; esto no cambia nada guardado.
const nombreBase = n => String(n||'').replace(/\s*(n[°º]\s*)?#?\d+\s*$/i, '').trim() || String(n||'');
function rangoCodigos(cods){
  // Junta los códigos por prefijo y comprime los números seguidos: BAL-005, BAL-006, BAL-007 → "BAL-005 a 007"
  const por = {};
  for(const c of cods){ const mm = /^(.*?)(\d+)$/.exec(c||''); if(!mm){ (por[c] ??= []); continue; } (por[mm[1]] ??= []).push(mm[2]); }
  return Object.entries(por).map(([pre, nums])=>{
    if(!nums.length) return pre;
    nums.sort((a,b)=>a-b);
    const tramos = []; let ini = nums[0], ant = nums[0];
    for(const n of nums.slice(1).concat([null])){
      if(n!==null && Number(n)===Number(ant)+1){ ant = n; continue; }
      tramos.push(ini===ant ? ini : Number(ant)===Number(ini)+1 ? `${ini}, ${ant}` : `${ini} a ${ant}`);
      if(n!==null){ ini = ant = n; }
    }
    return pre + tramos.join(', ');
  }).join(', ');
}
function agruparParaRemito(items, descDe){
  const grupos = [], porClave = {};
  for(const i of items){
    if(i.clase!=='herramienta'){ grupos.push({cantidad:i.cantidad, unidad:i.unidad, codigos:'', nombre:i.nombre, desc:''}); continue; }
    const base = nombreBase(i.nombre), desc = descDe(i), clave = (base+'|'+desc).toLowerCase();
    const g = porClave[clave];
    if(g){ g.cantidad += 1; g.cods.push(i.codigo); continue; }
    grupos.push(porClave[clave] = {cantidad:1, unidad:'un', cods:[i.codigo], nombreOrig:i.nombre, base, desc});
  }
  // Si quedó una sola, se muestra con su nombre completo ("CANDADO 1"); si son varias, el nombre sin número
  for(const g of grupos) if(g.cods){ g.codigos = g.cods.length===1 ? g.cods[0] : rangoCodigos(g.cods); g.nombre = g.cods.length===1 ? g.nombreOrig : g.base; }
  return grupos;
}
function htmlComprobante(m, copia){
  const items = m.items||[];
  const nH = items.filter(i=>i.clase==='herramienta').length, nM = items.length - nH;
  const dest = ubicPor(m.destino_id), orig = ubicPor(m.origen_id);
  // La descripción (marca/modelo) sale de la foto del movimiento; si es un remito viejo, de la herramienta actual
  const descDe = i => i.clase!=='herramienta' ? '' : (i.descripcion ?? S.herr.find(h=>h.id===i.id)?.descripcion ?? '');
  const filas = agruparParaRemito(items, descDe).map(g=>`<tr><td class="num">${fmt(g.cantidad)} ${esc(g.unidad==='un'?'':g.unidad)}</td>
    <td class="mono">${esc(g.codigos)}</td><td>${esc(g.nombre)}${g.desc?` <span class="rp-desc">— ${esc(g.desc)}</span>`:''}</td></tr>`).join('');
  return `<section class="rp">
    <header class="rp-top">
      <div class="rp-emp">
        <div class="rp-logo"><img src="logo.png" alt="LSG Obras de Ingeniería" onerror="this.parentElement.classList.add('sin-img');this.remove()">
          <span class="rp-logo-txt">LSG</span><span class="rp-logo-sub">OBRAS DE INGENIERÍA</span></div>
        <div>${EMPRESA.razon}<br>${EMPRESA.domicilio}<br>${EMPRESA.localidad}<br>Tel.: ${EMPRESA.telefono}<br>${EMPRESA.iva}</div>
      </div>
      <div class="rp-letra"><span class="rp-L">${EMPRESA.letra}</span>${EMPRESA.leyendaLetra?`<span class="rp-Lley">${EMPRESA.leyendaLetra}</span>`:''}</div>
      <div class="rp-der">
        <div class="rp-tit">${TITULOS[m.tipo]}</div><div class="rp-copia">${copia || ''}</div>
        <div class="rp-nf"><span>N°: <strong>${m.tipo==='traslado'?numRemito(m):'—'}</strong></span><span>Fecha: <strong>${fFecha(m.fecha)}</strong></span></div>
        <div class="rp-fis">CUIT: ${EMPRESA.cuit}<br>Ingresos brutos: ${EMPRESA.iibb}<br>Inicio de actividades: ${EMPRESA.inicio}</div>
      </div>
    </header>
    <div class="rp-cli">
      <div>Razón social: ${EMPRESA.codigo} ${EMPRESA.razon}</div>
      <div>Domicilio: ${esc(dest?.direccion || orig?.direccion || '')}</div>
      <div>Ubicación: ${esc(dest?.nombre || orig?.nombre || EMPRESA.ubicacion)}</div>
      <div class="rp-cli-fila"><span>Condición de venta: ${m.tipo==='traslado'?'Traslado interno':''}</span><span>Condición de IVA: Consumidor final</span></div>
    </div>
    <div class="rp-tabla"><span class="rp-col c1"></span><span class="rp-col c2"></span>
      <table class="rp-items">
        <colgroup><col style="width:11%"><col style="width:23%"><col style="width:66%"></colgroup>
        <thead><tr><th>Cantidad</th><th>Código</th><th>Descripción</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>
    <div class="rp-pie">
      <div>Cantidad total: ${[nH?`${nH} ${nH===1?'herramienta':'herramientas'}`:'', nM?`${nM} ${nM===1?'material':'materiales'}`:''].filter(Boolean).join(' y ') || '—'}</div>
      <div>VPS: $ 0,00. Transporte: </div>
      <div class="rp-ref">${m.tipo==='proveedor'
        ? `PROVEEDOR: ${esc(m.proveedor)}${m.numero_proveedor?' — Remito N° '+esc(m.numero_proveedor):''}`
        : `ORIGEN: ${esc(orig?.nombre || '')}`}</div>
      <div class="rp-ref">DESTINO: ${esc(dest?.nombre || '')}</div>
      <div class="rp-ref">NOTA: ${esc(m.nota)}</div>
      ${m.tipo==='traslado'?`
      <div class="rp-firma">
        <div class="rp-recibi">Recibí conforme <span class="rp-raya"></span></div>
        <div class="rp-acl">Aclaración: <span class="rp-raya"></span></div>
        <div class="rp-acl">DNI: <span class="rp-raya"></span></div>
        <div class="rp-leg">Quien firma declara haber recibido lo detallado y queda a cargo de ello en el destino hasta su devolución o traslado con un nuevo remito.</div>
      </div>`:''}
    </div>
    <div class="rp-meta">Generado por ${esc(m.creado_por||'')} el ${fHora(m.creado_en)}${m.entrega?' · Entrega: '+esc(m.entrega):''}</div>
  </section>`;
}
function imprimir(){
  const m = S.movs.find(x=>x.id===S.verId); if(!m) return;
  $('#printArea').innerHTML = m.tipo==='traslado'
    ? htmlComprobante(m,'Original') + htmlComprobante(m,'Duplicado')
    : htmlComprobante(m,'');
  window.print();
}

/* =====================================================================
   5b) CIERRE DE OBRA E INFORME
   Finalizar = marcar la obra como inactiva (activa = false). No se borra
   nada: el informe se arma con los movimientos que ya están guardados.
   ===================================================================== */
function fechaFinal(u){
  if(u.activa!==false) return null;
  const ev = S.evs.find(e=>/Finalizó la obra|Marcó como terminada la obra/.test(e.texto) && e.texto.includes(u.nombre));
  return ev ? ev.en : (movsDe(u.id)[0]?.creado_en || null);
}

const dlgF = $('#dlgFin');
function abrirFinalizar(){
  const u = ubicPor(S.sel); if(!u) return;
  const herrs = herrEn(u.id), mats = matsEn(u.id);
  const pend = movsDe(u.id).filter(m=>m.destino_id===u.id && sinFirma(m));
  const dep = S.ubic.find(x=>x.tipo==='deposito' && x.activa!==false);
  $('#fTitulo2').textContent = `Finalizar ${u.nombre}`;
  if(herrs.length || mats.length){
    $('#fBody').innerHTML = `
      <p class="aviso">Para finalizar la obra no puede quedar nada adentro. Todavía tiene:</p>
      <ul class="lista-fin">
        ${herrs.length?`<li><strong>${herrs.length}</strong> ${herrs.length===1?'herramienta':'herramientas'}: ${esc(herrs.slice(0,6).map(h=>h.codigo).join(', '))}${herrs.length>6?'…':''}</li>`:''}
        ${mats.length?`<li><strong>${mats.length}</strong> ${mats.length===1?'material':'materiales'}: ${esc(mats.slice(0,4).map(m=>`${fmt(m.cantidad)} ${m.unidad} ${m.nombre}`).join(', '))}${mats.length>4?'…':''}</li>`:''}
      </ul>
      <p class="muted">Podés devolver todo al depósito con un remito (queda todo tildado; revisalo antes de confirmar), o mover cada cosa a otra obra. Los materiales que se usaron se descuentan con <strong>Consumo o baja</strong>.</p>`;
    $('#fFoot').innerHTML = `<button type="button" class="btn" data-close>Cancelar</button>
      ${mats.length?'<button type="button" class="btn" data-act="consumoTodo">Registrar consumo</button>':''}
      ${dep?`<button type="button" class="btn primary" data-act="devolverTodo" data-dep="${esc(dep.id)}">Devolver todo a ${esc(dep.nombre)}</button>`:''}`;
  }else{
    $('#fBody').innerHTML = `
      <p>La obra está vacía. Al finalizarla:</p>
      <ul class="lista-fin">
        <li>Pasa a la sección <strong>Obras finalizadas</strong> y ya no aparece como destino de remitos.</li>
        <li><strong>Todo su historial queda guardado</strong>: remitos, fotos firmadas, ingresos y consumos.</li>
        <li>Se abre el <strong>informe de obra</strong> para que lo guardes en PDF.</li>
        <li>Si hace falta, se puede reabrir desde <strong>Editar</strong>.</li>
      </ul>
      ${pend.length?`<p class="aviso">Ojo: ${pend.length===1?'hay 1 remito':'hay '+pend.length+' remitos'} sin la foto firmada (${pend.map(m=>numRemito(m)).join(', ')}). Podés finalizar igual y cargarla después.</p>`:''}
      <p id="finError" class="error" hidden></p>`;
    $('#fFoot').innerHTML = `<button type="button" class="btn" data-close>Cancelar</button>
      <button type="button" class="btn primary" data-act="confirmarFin">Finalizar obra</button>`;
  }
  if(!dlgF.open) dlgF.showModal();
}
async function confirmarFinalizar(btn){
  const u = ubicPor(S.sel); if(!u) return;
  if(herrEn(u.id).length || matsEn(u.id).length) return abrirFinalizar();
  btn.disabled = true;
  const {error} = await sb.from('ubicaciones').update({activa:false}).eq('id', u.id);
  if(error){ btn.disabled = false; $('#finError').textContent='No se pudo finalizar. Probá de nuevo.'; $('#finError').hidden=false; return; }
  await registrarEvento(`Finalizó la obra ${u.nombre}`);
  dlgF.close();
  await Promise.all([cargar('ubicaciones'), cargar('eventos')]);
  imprimirInforme(u.id);
}

function htmlInforme(u){
  const movs = movsDe(u.id).slice().sort((a,b)=>String(a.creado_en).localeCompare(String(b.creado_en)));
  const ref = (m, lado) => {
    if(m.tipo==='traslado') return lado==='in' ? `${numRemito(m)} desde ${nomUbic(m.origen_id)}` : `${numRemito(m)} a ${nomUbic(m.destino_id)}`;
    if(m.tipo==='proveedor') return `Ingreso de ${m.proveedor||'proveedor'}${m.numero_proveedor?' (rem. '+m.numero_proveedor+')':''}`;
    if(m.tipo==='alta') return 'Alta de inventario';
    return 'Baja' + (m.nota ? `: ${m.nota}` : '');
  };
  // Herramientas: cada estadía en la obra (llegó / se fue)
  const est = {};
  for(const m of movs) for(const i of (m.items||[])) if(i.clase==='herramienta'){
    const e = est[i.id] ??= {codigo:i.codigo, nombre:i.nombre, tramos:[]};
    if(m.destino_id===u.id) e.tramos.push({in:m, out:null});
    else if(m.origen_id===u.id){
      const abierto = [...e.tramos].reverse().find(t=>!t.out);
      if(abierto) abierto.out = m; else e.tramos.push({in:null, out:m});
    }
  }
  const filasH = Object.values(est).sort(porCodigo).flatMap(e=>e.tramos.map(t=>`<tr>
    <td class="mono">${esc(e.codigo)}</td><td>${esc(e.nombre)}</td>
    <td>${t.in?`${fFecha(t.in.fecha)} · ${esc(ref(t.in,'in'))}`:'—'}</td>
    <td>${t.out?`${fFecha(t.out.fecha)} · ${esc(ref(t.out,'out'))}`:'<strong>Sigue en la obra</strong>'}</td></tr>`)).join('');
  // Materiales: recibido, enviado, consumido y saldo
  const mat = {};
  for(const m of movs) for(const i of (m.items||[])) if(i.clase==='material'){
    const r = mat[i.id] ??= {nombre:i.nombre, unidad:i.unidad, rec:0, env:0, con:0};
    const c = Number(i.cantidad);
    if(m.destino_id===u.id) r.rec += c;
    else if(m.origen_id===u.id) (m.tipo==='consumo' ? r.con += c : r.env += c);
  }
  const saldo = Object.fromEntries(matsEn(u.id).map(m=>[m.id, m.cantidad]));
  const filasM = Object.entries(mat).sort((a,b)=>porNombre(a[1],b[1])).map(([id,r])=>`<tr><td>${esc(r.nombre)}</td><td>${esc(r.unidad)}</td>
    <td class="num">${fmt(r.rec)}</td><td class="num">${fmt(r.env)}</td><td class="num">${fmt(r.con)}</td><td class="num"><strong>${fmt(saldo[id]||0)}</strong></td></tr>`).join('');
  const remitos = movs.filter(m=>m.tipo==='traslado');
  const filasR = remitos.map(m=>`<tr><td class="mono">${numRemito(m)}</td><td>${fFecha(m.fecha)}</td>
    <td>${m.destino_id===u.id?'Recibido de '+esc(nomUbic(m.origen_id)):'Enviado a '+esc(nomUbic(m.destino_id))}</td>
    <td>${esc(m.recibe) || 'A mano (ver foto)'}</td><td>${(m.fotos||[]).length?'Sí':'<strong>No</strong>'}</td></tr>`).join('');
  const provs = movs.filter(m=>m.tipo==='proveedor' || m.tipo==='alta');
  const filasP = provs.map(m=>`<tr><td>${fFecha(m.fecha)}</td><td>${m.tipo==='alta'?'Alta de inventario':esc(m.proveedor||'—')}</td>
    <td class="mono">${esc(m.numero_proveedor)}</td><td>${esc(resumenItems(m.items, 999))}</td></tr>`).join('');
  const cons = movs.filter(m=>m.tipo==='consumo');
  const filasC = cons.map(m=>`<tr><td>${fFecha(m.fecha)}</td><td>${esc(resumenItems(m.items, 999))}</td><td>${esc(m.nota)}</td></tr>`).join('');
  const inicio = movs[0]?.fecha, fin = fechaFinal(u);
  const tabla = (titulo, cab, filas, vacio) => `<h2 class="inf-h">${titulo}</h2>${filas
    ? `<table class="inf-t"><thead><tr>${cab.map(c=>`<th${c.startsWith('#')?' class="num"':''}>${c.replace('#','')}</th>`).join('')}</tr></thead><tbody>${filas}</tbody></table>`
    : `<p class="inf-v">${vacio}</p>`}`;
  return `<section class="inf">
    <header class="inf-top">
      <div><strong>${EMPRESA.razon}</strong><br>${EMPRESA.domicilio} · ${EMPRESA.localidad}<br>CUIT ${EMPRESA.cuit}</div>
      <div class="inf-tit">Informe de ${u.tipo==='deposito'?'depósito':'obra'}${u.activa===false?' — cierre':''}</div>
    </header>
    <div class="inf-obra">
      <div class="inf-nom">${esc(u.nombre)}</div>
      ${u.direccion?`<div>${esc(u.direccion)}</div>`:''}
      <div class="inf-datos">
        <span>Estado: <strong>${u.activa===false?'Finalizada':'En curso'}</strong></span>
        <span>Primer movimiento: <strong>${inicio?fFecha(inicio):'—'}</strong></span>
        ${fin?`<span>Finalizada: <strong>${fFecha(fin)}</strong></span>`:''}
        <span>Remitos: <strong>${remitos.length}</strong></span>
        <span>Herramientas que pasaron: <strong>${Object.keys(est).length}</strong></span>
      </div>
    </div>
    ${tabla('Herramientas y equipos', ['Código','Herramienta','Llegó','Se fue'], filasH, 'No pasaron herramientas por esta ubicación.')}
    ${tabla('Materiales', ['Material','Unidad','#Recibido','#Enviado','#Consumido','#Saldo'], filasM, 'No hubo materiales.')}
    ${tabla('Remitos', ['N°','Fecha','Movimiento','Recibió','Firmado'], filasR, 'No hubo remitos.')}
    ${tabla('Ingresos y altas', ['Fecha','Proveedor','N° remito prov.','Detalle'], filasP, 'No hubo ingresos de proveedor ni altas.')}
    ${tabla('Consumos y bajas', ['Fecha','Detalle','Motivo'], filasC, 'No hubo consumos ni bajas.')}
    <footer class="inf-pie">Generado por ${esc(S.me||'')} el ${fHora(new Date().toISOString())} · Inventario de Obra LSG</footer>
  </section>`;
}
function imprimirInforme(id){
  const u = ubicPor(id || S.sel); if(!u) return;
  $('#printArea').innerHTML = htmlInforme(u);
  window.print();
}

/* =====================================================================
   6) EVENTOS (clics y formularios)
   ===================================================================== */
document.addEventListener('click', async ev=>{
  const c = ev.target.closest('[data-close]'); if(c){ c.closest('dialog').close(); return; }
  const tab = ev.target.closest('[data-tab]');
  if(tab){
    S.tab = tab.dataset.tab;
    $$('.tab').forEach(t=>t.classList.toggle('on', t===tab));
    $('#vUbic').hidden = S.tab!=='ubic'; $('#vHerr').hidden = S.tab!=='herr'; $('#vMov').hidden = S.tab!=='mov'; $('#vFlota').hidden = S.tab!=='flota';
    if(S.tab==='flota') window.flotaRender?.();
    return;
  }
  const ub = ev.target.closest('[data-ubic]');
  if(ub){ S.sel=ub.dataset.ubic; guardarSel(); render(); if(innerWidth<880) $('#detalle').scrollIntoView({behavior:'smooth',block:'start'}); return; }
  const hr = ev.target.closest('[data-herr]');
  if(hr){ if(dlgV.open) dlgV.close(); abrirHerr(hr.dataset.herr); return; }
  const mt = ev.target.closest('[data-mat]');
  if(mt){ abrirMat(mt.dataset.mat); return; }
  const mv = ev.target.closest('[data-mov]');
  if(mv){ if(dlgH.open) dlgH.close(); abrirVer(mv.dataset.mov); return; }
  const a = ev.target.closest('[data-act]'); if(!a) return;
  switch(a.dataset.act){
    case 'salir': await sb.auth.signOut(); break;
    case 'respaldo': descargarRespaldo(a); break;
    case 'miClave':
      $('#fClave').reset(); $('#cError').hidden=true; $('#cOk').hidden=true; $('#cGuardar').disabled=false;
      $('#dlgClave').showModal(); $('#cNueva').focus(); break;
    case 'nuevoMov': abrirMov({tipo:a.dataset.tipo, origen:S.sel, destino:S.sel}); break;
    case 'nuevaUbic': abrirUbic(null); break;
    case 'editarUbic': abrirUbic(S.sel); break;
    case 'informe': imprimirInforme(S.sel); break;
    case 'finalizar': abrirFinalizar(); break;
    case 'confirmarFin': confirmarFinalizar(a); break;
    case 'devolverTodo': dlgF.close(); abrirMov({tipo:'traslado', origen:S.sel, destino:a.dataset.dep, todo:true, nota:'Devolución por cierre de obra'}); break;
    case 'consumoTodo': dlgF.close(); abrirMov({tipo:'consumo', origen:S.sel, nota:'Consumido en obra'}); break;
    case 'filaHerr': $('#filasHerr').insertAdjacentHTML('beforeend', filaHerrHTML()); $('#filasHerr .fh:last-child .hn').focus(); break;
    case 'filaMat':  $('#filasMat').insertAdjacentHTML('beforeend', filaMatHTML());  $('#filasMat .fm:last-child .mn').focus(); break;
    case 'quitarFila': {
      const cont = a.closest('.filas'); a.parentElement.remove();
      if(!cont.children.length) cont.innerHTML = cont.id==='filasHerr' ? filaHerrHTML() : filaMatHTML();
      break; }
    case 'todasHerr': $$('#listaHerrSel input[data-h]').forEach(i=>S.mov.sel.add(i.dataset.h)); renderSeleccion(); break;
    case 'ningunaHerr': S.mov.sel.clear(); renderSeleccion(); break;
    case 'todoMat': S.mov.qty[a.dataset.m] = Number(a.dataset.max); renderSeleccion(); break;
    case 'quitarFoto': { const n=Number(a.dataset.n); URL.revokeObjectURL(S.fotosNuevas[n].url); S.fotosNuevas.splice(n,1); renderPreviews(); break; }
    case 'imprimir': imprimir(); break;
    case 'subirFirmado': $('#fFirmado').value=''; $('#fFirmado').click(); break;
    case 'guardarHerr': guardarHerr(); break;
    case 'guardarMat': guardarMat(); break;
    case 'verFoto': $('#fotoGrande').src = S.urls[a.dataset.path]; $('#dlgFoto').showModal(); break;
    case 'cambiarFoto': $('#fFotoItem').value=''; $('#fFotoItem').click(); break;
    case 'quitarFotoItem': quitarFotoItem(a); break;
  }
});
document.addEventListener('keydown', ev=>{
  if(ev.key!=='Enter') return;
  if(ev.target.matches('[data-mov][tabindex]')) abrirVer(ev.target.dataset.mov);
  if(ev.target.matches('tr[data-herr]')) abrirHerr(ev.target.dataset.herr);
  if(ev.target.matches('tr[data-mat]')) abrirMat(ev.target.dataset.mat);
});
document.addEventListener('change', ev=>{
  if(ev.target.id==='verBajas'){ S.verBajas = ev.target.checked; renderHerr(); }
});
$$('input[name=mtipo]').forEach(r=>r.addEventListener('change', ()=>{ S.mov.sel.clear(); S.mov.qty={}; aplicarTipo(); }));
$('#mOrigen').addEventListener('change', ()=>{ S.mov.sel.clear(); S.mov.qty={}; aplicarTipo(); });
$('#mFiltroHerr').addEventListener('input', renderSeleccion);
$('#listaHerrSel').addEventListener('change', ev=>{
  const id = ev.target.dataset.h; if(!id) return;
  ev.target.checked ? S.mov.sel.add(id) : S.mov.sel.delete(id);
  $('#cHerrSel').textContent = `${S.mov.sel.size} de ${herrEn($('#mOrigen').value).length}`;
});
$('#listaMatSel').addEventListener('input', ev=>{ const id = ev.target.dataset.m; if(id) S.mov.qty[id] = ev.target.value; });
$('#mFoto').addEventListener('change', ev=>{
  for(const file of ev.target.files) S.fotosNuevas.push({file, url:URL.createObjectURL(file)});
  ev.target.value=''; renderPreviews();
});
$('#fFirmado').addEventListener('change', ev=>subirFirmado([...ev.target.files]));
$('#fFotoItem').addEventListener('change', ev=>{ const f = ev.target.files[0]; if(f) subirFotoItem(f); });
$('#dlgFoto').addEventListener('click', ()=>$('#dlgFoto').close());
$('#fMov').addEventListener('submit', guardarMov);
$('#fUbic').addEventListener('submit', guardarUbic);
$('#buscaHerr').addEventListener('input', renderHerr);
$('#buscaMov').addEventListener('input', renderMov);
$('#filtroMov').addEventListener('change', renderMov);

/* ---------- Respaldo: descarga TODOS los datos en un Excel (una hoja por tabla) ----------
   El plan gratis de Supabase no guarda copias descargables, así que conviene bajar esto cada tanto
   (por ejemplo, una vez por semana). Las fotos no van en el Excel: quedan en Supabase Storage. */
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const TABLAS_RESPALDO = [
  ['ubicaciones','Obras y depósitos'], ['herramientas','Herramientas'], ['materiales','Materiales'],
  ['stock_materiales','Stock de materiales'], ['movimientos','Remitos y movimientos'], ['eventos','Eventos'],
  ['vehiculos','Vehículos'], ['vencimientos','Vencimientos'], ['services_vehiculo','Services'],
  ['cargas_combustible','Cargas de combustible'], ['lecturas_vehiculo','Lecturas km-horas'],
  ['documentos_vehiculo','Documentos vehículos'], ['distancias_obra','Distancias de obras']
];
// Supabase devuelve como máximo 1000 filas por pedido: pedimos de a 1000 hasta traer todo
async function leerTodo(tabla){
  const filas = [];
  for(let desde=0; ; desde+=1000){
    const {data, error} = await sb.from(tabla).select('*').range(desde, desde+999);
    if(error) return /does not exist|schema cache|Could not find/i.test(error.message||'') ? null : Promise.reject(error);
    filas.push(...data);
    if(data.length < 1000) return filas;
  }
}
// Las celdas de Excel solo aceptan texto o números: las listas y objetos (ítems de un remito, fotos) van como texto
const celda = x => x==null ? '' : Array.isArray(x) || typeof x==='object' ? JSON.stringify(x) : x;
async function descargarRespaldo(btn){
  const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Armando respaldo…';
  try{
    if(!window.XLSX) await new Promise((ok, mal)=>{ const s = document.createElement('script'); s.src = XLSX_URL; s.onload = ok;
      s.onerror = ()=>mal(new Error('No se pudo cargar el generador de Excel. Revisá la conexión.')); document.head.appendChild(s); });
    const libro = XLSX.utils.book_new(), resumen = [['Hoja','Filas']];
    for(const [tabla, nombre] of TABLAS_RESPALDO){
      const filas = await leerTodo(tabla);
      if(filas===null) continue;                      // tabla que todavía no existe (ej. sin vehiculos.sql)
      const hoja = filas.length ? XLSX.utils.json_to_sheet(filas.map(f=>Object.fromEntries(Object.entries(f).map(([k,v])=>[k, celda(v)]))))
                                : XLSX.utils.aoa_to_sheet([['(sin datos)']]);
      XLSX.utils.book_append_sheet(libro, hoja, nombre.slice(0,31));
      resumen.push([nombre, filas.length]);
    }
    resumen.push([], ['Generado', new Date().toLocaleString('es-AR')], ['Por', S.me||''], ['Las fotos no van en este archivo: quedan guardadas en Supabase (Storage → remitos).']);
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');
    libro.SheetNames.unshift(libro.SheetNames.pop());  // "Resumen" como primera hoja
    XLSX.writeFile(libro, `respaldo-inventario-lsg-${hoy()}.xlsx`);
  }catch(e){
    alert('No se pudo armar el respaldo: ' + (e.message || 'error de conexión') + '. Probá de nuevo.');
  }finally{ btn.disabled = false; btn.textContent = txt; }
}

/* ---------- Cambiar contraseña: cada usuario cambia la suya ---------- */
$('#fClave').addEventListener('submit', async ev=>{
  ev.preventDefault();
  const nueva = $('#cNueva').value, repite = $('#cRepite').value;
  const err = m => { $('#cError').textContent = m; $('#cError').hidden = false; $('#cOk').hidden = true; };
  if(nueva.length < 8) return err('La contraseña tiene que tener al menos 8 caracteres.');
  if(nueva !== repite) return err('Las dos contraseñas no coinciden.');
  $('#cGuardar').disabled = true; $('#cError').hidden = true;
  const {error} = await sb.auth.updateUser({password: nueva});
  $('#cGuardar').disabled = false;
  if(error) return err(error.message.includes('different') ? 'La nueva tiene que ser distinta de la actual.' : 'No se pudo cambiar. Probá con una contraseña más larga o distinta.');
  $('#cOk').hidden = false; $('#fClave').reset();
  setTimeout(()=>$('#dlgClave').close(), 1500);
});

/* =====================================================================
   7) LOGIN Y ARRANQUE
   ===================================================================== */
$('#fLogin').addEventListener('submit', async ev=>{
  ev.preventDefault();
  const btn = $('#lBtn'); btn.disabled = true; $('#lError').hidden = true;
  const {error} = await sb.auth.signInWithPassword({email:$('#lEmail').value.trim(), password:$('#lPass').value});
  btn.disabled = false;
  if(error){ $('#lError').textContent = 'Email o contraseña incorrectos.'; $('#lError').hidden = false; }
});

// El rol se lee de la tabla perfiles. La página lo usa para mostrar u ocultar botones;
// la base lo usa (RLS + registrar_movimiento) para aceptar o rechazar cada escritura.
async function cargarRol(userId){
  const {data} = await sb.from('perfiles').select('rol').eq('user_id', userId).maybeSingle();
  S.admin = data?.rol === 'admin';
  const b = $('#rolBadge');
  b.textContent = S.admin ? 'Admin' : 'Solo lectura';
  b.className = 'chip ' + (S.admin ? 'c-tras' : 'c-compra');
  b.hidden = false;
  $('#btnUbic').hidden = !S.admin;
  $('#btnRespaldo').hidden = !S.admin;
  window.flotaRender?.();
}
async function mostrarSesion(session){
  const dentro = !!session;
  $('#vLogin').hidden = dentro; $('#vApp').hidden = !dentro;
  if(!dentro){ S.me=null; S.admin=false; S.enVivo=false; clearInterval(S.respaldo); if(S.canal){ sb.removeChannel(S.canal); S.canal=null; } return; }
  if(S.me === session.user.email) return;
  S.me = session.user.email;
  $('#quienSoy').textContent = S.me;
  await cargarRol(session.user.id);
  render(); cargarTodo(); escucharCambios();
}
sb.auth.getSession().then(({data})=>mostrarSesion(data.session));
sb.auth.onAuthStateChange((_ev, session)=>mostrarSesion(session));
