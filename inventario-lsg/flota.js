/* =====================================================================
   Flota de vehículos y maquinaria LSG
   Pestaña "Vehículos": ficha, vencimientos, documentos, services, cargas de
   combustible, lecturas de km/horas, rendimiento, gasto por obra y PDF.
   Usa la conexión, los usuarios y las obras de app.js, pero sus propias
   tablas (ver vehiculos.sql).

   Idea central (igual que el inventario): el vehículo es una ENTIDAD y las
   cargas, services, lecturas y vencimientos son EVENTOS. Todo lo que se
   muestra (km actuales, próximo service, rendimiento, gasto por obra) se CALCULA.

   Vehículos por KM (camionetas) o por HORAS (máquinas con horómetro):
   las columnas de la base se llaman "km" pero guardan horas si unidad='horas'.
   ===================================================================== */
const F = {
  veh:[], venc:[], serv:[], cargas:[], dist:[], lect:[], docs:[], loaded:{}, falta:false, iniciado:false,
  sel:null, vista:'flota', mes: hoy().slice(0,7), canal:null, urls:{}, vence:{}, firmando:{},
  form:null, fotos:[]
};
try{ F.sel = localStorage.getItem('flota.sel'); }catch(e){}

const TIPOS_VEH = {camioneta:'Camioneta', camion:'Camión', utilitario:'Utilitario', auto:'Auto', maquina:'Máquina', otro:'Otro'};
const COMB = {gasoil:'Gasoil', nafta:'Nafta', gnc:'GNC', otro:'Otro'};
const TIPOS_VENC = {vtv:'VTV', seguro:'Seguro', matafuegos:'Matafuegos', patente:'Patente', ruta:'RUTA', registro:'Registro del chofer', otro:'Otro'};
const VENC_BASICOS_KM = ['vtv','seguro','matafuegos','registro'];   // si faltan, se avisa (las máquinas no tienen VTV ni registro)
const TIPOS_SERV = {service:'Service', reparacion:'Reparación', cubiertas:'Cubiertas', otro:'Otro'};
const TIPOS_DOC = {poliza:'Póliza de seguro', vtv:'VTV', cedula:'Cédula', titulo:'Título', registro:'Registro', ruta:'RUTA', matafuegos:'Matafuegos', otro:'Otro'};
const DESVIO_ALERTA = 0.15;                                 // 15 % peor que la referencia = alerta
const DIAS_SIN_LECTURA = 30;                                // avisar si hace más de 30 días que no se actualiza el km
const fmtPlata = n => n==null || n==='' ? '—' : '$ ' + Math.round(Number(n)).toLocaleString('es-AR');
const normPatente = p => String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');

// Todo lo que cambia según si el vehículo se mide por km o por horas
const U = v => v?.unidad==='horas'
  ? {horas:true,  u:'h',  largo:'horas', lectura:'Horómetro', rend:'l/h',  margen:50,   ejemplo:'Ej. 1250'}
  : {horas:false, u:'km', largo:'km',    lectura:'Odómetro',  rend:'km/l', margen:1000, ejemplo:'Ej. 85000'};
const fmtU = (n, v) => n==null || isNaN(n) ? '—' : Math.round(Number(n)).toLocaleString('es-AR') + ' ' + U(v).u;

/* ---------------- 1) Datos ---------------- */
const FT = {
  vehiculos:           ['veh',    () => sb.from('vehiculos').select('*')],
  vencimientos:        ['venc',   () => sb.from('vencimientos').select('*')],
  services_vehiculo:   ['serv',   () => sb.from('services_vehiculo').select('*')],
  cargas_combustible:  ['cargas', () => sb.from('cargas_combustible').select('*').order('fecha',{ascending:false}).limit(5000)],
  distancias_obra:     ['dist',   () => sb.from('distancias_obra').select('*')],
  lecturas_vehiculo:   ['lect',   () => sb.from('lecturas_vehiculo').select('*').order('fecha',{ascending:false}).limit(5000)],
  documentos_vehiculo: ['docs',   () => sb.from('documentos_vehiculo').select('*')]
};
async function fCargar(t){
  const [k, q] = FT[t];
  const {data, error} = await q();
  if(error){
    console.error('Flota: error al leer', t, error);
    if(/does not exist|schema cache|Could not find/i.test(error.message||'')) F.falta = true;
    fRender(); return;
  }
  F[k] = data; F.loaded[t] = true; fRender();
}
const fCargarTodo = () => Promise.all(Object.keys(FT).map(fCargar));
function fEscuchar(){
  if(F.canal) return;
  let ch = sb.channel('flota-lsg');
  for(const t of Object.keys(FT)) ch = ch.on('postgres_changes', {event:'*', schema:'public', table:t}, ()=>{
    clearTimeout(F['t_'+t]); F['t_'+t] = setTimeout(()=>fCargar(t), 250);
  });
  F.canal = ch.subscribe(()=>{});
  setInterval(()=>{ if(F.iniciado && !document.hidden && !S.enVivo) fCargarTodo(); }, 30000);
}
async function fFirmar(paths){
  if(await pedirFirmas(F.urls, F.vence, F.firmando, paths, 86400)) fRender();
}
// Lo llama renovarFotos (app.js): si algún link de la flota venció, repinta y fRender los pide de nuevo.
window.flotaRenovar = () => {
  if(F.iniciado && Object.keys(F.urls).some(p=>!vigente(F.urls, F.vence, p))) fRender();
};
sb.auth.onAuthStateChange((_e, s)=>{
  if(s && !F.iniciado){ F.iniciado = true; fCargarTodo(); fEscuchar(); }
  if(!s){ F.iniciado = false; }
});

/* ---------------- 2) Cálculos ---------------- */
const vehPor = id => F.veh.find(v=>v.id===id);
const vehNom = v => v ? `${v.patente} · ${[v.marca, v.modelo].filter(Boolean).join(' ')}`.replace(/ · $/,'') : '—';
const diasHasta = f => Math.round((new Date(String(f).slice(0,10)+'T12:00:00') - new Date(hoy()+'T12:00:00')) / 86400000);
const estadoDias = d => d < 0 ? 'rojo' : d <= 30 ? 'amarillo' : 'verde';
const cargasDe = vid => F.cargas.filter(c=>c.vehiculo_id===vid);
const servDe = vid => F.serv.filter(s=>s.vehiculo_id===vid).sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha)) || b.km-a.km);
const lectDe = vid => F.lect.filter(l=>l.vehiculo_id===vid);
const docsDe = vid => F.docs.filter(d=>d.vehiculo_id===vid).sort((a,b)=>String(b.creado_en).localeCompare(String(a.creado_en)));
const vencBasicos = v => U(v).horas ? ['seguro','matafuegos'] : VENC_BASICOS_KM;

// Fecha de alta del vehículo (si faltara, se toma hoy para no romper los cálculos)
const fechaAlta = v => /^\d{4}-\d{2}-\d{2}/.test(String(v.creado_en||'')) ? String(v.creado_en).slice(0,10) : hoy();
// Lectura actual = el mayor valor conocido (alta, cargas, services o lecturas) y su fecha
function lecturaActual(v){
  const puntos = [{valor:Number(v.km_inicial)||0, fecha:fechaAlta(v)},
    ...cargasDe(v.id).map(c=>({valor:Number(c.odometro), fecha:c.fecha})),
    ...servDe(v.id).map(s=>({valor:Number(s.km), fecha:s.fecha})),
    ...lectDe(v.id).map(l=>({valor:Number(l.valor), fecha:l.fecha}))];
  const max = puntos.reduce((a,b)=> b.valor>a.valor || (b.valor===a.valor && b.fecha>a.fecha) ? b : a);
  const ultFecha = puntos.reduce((a,b)=> b.fecha>a ? b.fecha : a, '');
  return {valor:max.valor, fecha:ultFecha, dias:-diasHasta(ultFecha)};
}
const kmActual = v => lecturaActual(v).valor;
// Vencimiento vigente de cada tipo = el de fecha más lejana
function vencVigentes(vid){
  const por = {};
  for(const x of F.venc.filter(x=>x.vehiculo_id===vid)) if(!por[x.tipo] || x.vence > por[x.tipo].vence) por[x.tipo] = x;
  return por;
}
function proxService(v){
  const ult = servDe(v.id).find(s=>s.tipo==='service');
  const base = ult ? Number(ult.km) : Number(v.km_inicial)||0;
  const baseFecha = ult ? ult.fecha : fechaAlta(v);
  const f = new Date(baseFecha+'T12:00:00'); f.setMonth(f.getMonth() + Number(v.service_cada_meses||6));
  const km = base + Number(v.service_cada_km||10000);
  const fecha = f.toISOString().slice(0,10);
  const falta = km - kmActual(v), dias = diasHasta(fecha);
  const estado = (falta <= 0 || dias < 0) ? 'rojo' : (falta <= U(v).margen || dias <= 30) ? 'amarillo' : 'verde';
  return {km, fecha, falta, dias, estado, ult};
}
// Tramos: entre una carga y la anterior (por odómetro/horómetro). Los litros de una carga
// reponen lo que se gastó desde la carga anterior.
function tramos(vid){
  const cs = cargasDe(vid).slice().sort((a,b)=>a.odometro-b.odometro || String(a.fecha).localeCompare(String(b.fecha)));
  const out = [];
  for(let i=1;i<cs.length;i++){
    const uds = cs[i].odometro - cs[i-1].odometro;
    if(uds > 0) out.push({carga:cs[i], uds, litros:Number(cs[i].litros)});
  }
  return out;
}
// Referencia de consumo: la que cargaste a mano o, si está vacía, el PROMEDIO PROPIO del vehículo
// (últimos 6 meses sin contar el mes actual; hacen falta al menos 3 tramos entre cargas).
function referencia(v){
  const manual = Number(v.km_l_ref)||null;
  if(manual) return {valor:manual, auto:false};
  const d = new Date(hoy()+'T12:00:00'); d.setMonth(d.getMonth()-6);
  const desde = d.toISOString().slice(0,10), mesAct = hoy().slice(0,7);
  const ts = tramos(v.id).filter(t=>t.carga.fecha>=desde && !String(t.carga.fecha).startsWith(mesAct));
  if(ts.length < 3) return {valor:null, auto:true, faltan:3-ts.length};
  const uds = ts.reduce((s,t)=>s+t.uds,0), lts = ts.reduce((s,t)=>s+t.litros,0);
  return {valor: U(v).horas ? lts/uds : uds/lts, auto:true, n:ts.length};
}
// Rendimiento: km/l (más es mejor) o l/h (menos es mejor). "desvio" negativo = peor que la referencia.
function rendimiento(v, mes){
  const ts = tramos(v.id).filter(t=>!mes || String(t.carga.fecha).startsWith(mes));
  const uds = ts.reduce((s,t)=>s+t.uds,0), litros = ts.reduce((s,t)=>s+t.litros,0);
  const h = U(v).horas;
  const valor = !litros || !uds ? null : h ? litros/uds : uds/litros;
  const ref = referencia(v).valor;
  const desvio = valor && ref ? (h ? (ref-valor)/ref : (valor-ref)/ref) : null;
  const minimo = h ? 20 : 300;                              // con pocos km u horas no se evalúa
  const estado = desvio==null || uds < minimo ? 'gris' : desvio < -DESVIO_ALERTA ? 'rojo' : desvio < -DESVIO_ALERTA/2 ? 'amarillo' : 'verde';
  return {uds, litros, valor, ref, desvio, estado};
}
const valorTramo = (t, v) => U(v).horas ? t.litros/t.uds : t.uds/t.litros;
const ultimos6Meses = () => { const out=[], d=new Date(hoy()+'T12:00:00'); d.setDate(1);
  for(let i=0;i<6;i++){ out.push(d.toISOString().slice(0,7)); d.setMonth(d.getMonth()-1); } return out; };
const nombreMes = m => new Date(m+'-15T12:00:00').toLocaleDateString('es-AR',{month:'long',year:'numeric'});
const fmtRend = (x, v) => x==null ? '—' : fmt(x.toFixed(1)) + ' ' + U(v).rend;

const promedioPropio = x => x?.id ? referencia({...x, km_l_ref:null}).valor : null;
function textoRef(v){
  const rf = referencia(v), u = U(v);
  if(rf.valor && !rf.auto) return `referencia ${fmt(rf.valor.toFixed(1))} ${u.rend}`;
  if(rf.valor) return `su promedio: ${fmt(rf.valor.toFixed(1))} ${u.rend}`;
  return `faltan ${rf.faltan} ${rf.faltan===1?'carga':'cargas'} para calcular su promedio`;
}
function alertasDe(v){
  const out = [];
  const vig = vencVigentes(v.id);
  for(const t of Object.keys(vig)){
    const d = diasHasta(vig[t].vence), e = estadoDias(d);
    if(e!=='verde') out.push({v, nivel:e, txt: d<0 ? `${TIPOS_VENC[t]} vencido hace ${-d} ${-d===1?'día':'días'}` : `${TIPOS_VENC[t]} vence en ${d} ${d===1?'día':'días'} (${fFecha(vig[t].vence)})`});
  }
  for(const t of vencBasicos(v)) if(!vig[t]) out.push({v, nivel:'amarillo', txt:`Sin ${TIPOS_VENC[t]} cargado`});
  const ps = proxService(v);
  if(ps.estado!=='verde') out.push({v, nivel:ps.estado, txt: ps.falta<=0 ? `Service pasado por ${fmtU(-ps.falta, v)}` : ps.dias<0 ? `Service vencido por fecha (${fFecha(ps.fecha)})` : `Service en ${fmtU(ps.falta, v)} o el ${fFecha(ps.fecha)}`});
  const r = rendimiento(v, hoy().slice(0,7));
  if(r.estado==='rojo') out.push({v, nivel:'rojo', txt:`Consume ${fmtRend(r.valor, v)} este mes (${referencia(v).auto?'su promedio':'referencia'} ${fmt(r.ref.toFixed(1))} ${U(v).rend}): ${Math.round(-r.desvio*100)} % peor`});
  const la = lecturaActual(v);
  if(la.dias > DIAS_SIN_LECTURA) out.push({v, nivel:'amarillo', txt:`${U(v).lectura} sin actualizar hace ${la.dias} días`});
  return out;
}
const alertas = () => F.veh.filter(v=>v.activo!==false).flatMap(alertasDe).sort((a,b)=>(a.nivel==='rojo'?0:1)-(b.nivel==='rojo'?0:1));
function estadoVehiculo(v){
  const vig = vencVigentes(v.id);
  const venc = Object.values(vig).map(x=>estadoDias(diasHasta(x.vence)));
  if(vencBasicos(v).some(t=>!vig[t])) venc.push('amarillo');
  const peor = arr => arr.includes('rojo') ? 'rojo' : arr.includes('amarillo') ? 'amarillo' : arr.length ? 'verde' : 'gris';
  return {venc: peor(venc), serv: proxService(v).estado, rend: rendimiento(v, hoy().slice(0,7)).estado};
}

/* ---------------- 3) Pantallas ---------------- */
const punto = (e, t) => `<span class="sem ${e}" title="${esc(t)}"></span>`;
const chipEstado = (e, txt) => `<span class="chip sem-${e}">${esc(txt)}</span>`;
const esImagen = p => /\.(jpe?g|png|webp|gif)$/i.test(p||'');
const archivoLink = (p, i, n) => F.urls[p]
  ? (esImagen(p) ? `<a class="doc-mini" href="${esc(F.urls[p])}" target="_blank" rel="noopener"><img src="${esc(F.urls[p])}" alt="Archivo ${i+1}"></a>`
                 : `<a class="doc-mini pdf" href="${esc(F.urls[p])}" target="_blank" rel="noopener">PDF${n>1?' '+(i+1):''}</a>`)
  : '<span class="doc-mini cargando">…</span>';

function fRender(){
  const el = $('#vFlota'); if(!el) return;
  if(F.falta){ el.innerHTML = `<div class="vacio"><strong>Falta actualizar las tablas de vehículos</strong>En Supabase → SQL Editor, corré el archivo <span class="mono">vehiculos.sql</span> y recargá la página.</div>`; return; }
  if(!Object.keys(FT).every(t=>F.loaded[t])){ el.innerHTML = '<div class="vacio">Cargando vehículos…</div>'; return; }
  el.innerHTML = `
    <div class="mov-head">
      <div class="seg-mini" role="tablist">
        <button class="${F.vista==='flota'?'on':''}" data-fvista="flota">Vehículos</button>
        <button class="${F.vista==='obras'?'on':''}" data-fvista="obras">Gasto por obra</button>
      </div>
      <div class="det-actions">
        ${F.veh.length?'<button class="btn sm" data-fact="pdfFlota">Toda la flota (PDF)</button>':''}
        ${S.admin?`<button class="btn sm" data-fact="lecturas">Actualizar km / horas</button>
          <button class="btn sm" data-fact="tarjeta">Cargar resumen de tarjeta</button>
          <button class="btn sm" data-fact="cargarFlota">Cargar flota</button>
          <button class="btn primary sm" data-fact="nuevoVeh">+ Vehículo</button>`:''}
      </div>
    </div>
    ${F.vista==='flota' ? vistaFlota() : vistaObras()}`;
}

function vistaFlota(){
  const al = alertas();
  const lista = F.veh.slice().sort((a,b)=>(a.activo===false)-(b.activo===false) || a.patente.localeCompare(b.patente));
  if(!lista.length) return `<div class="vacio"><strong>Todavía no hay vehículos</strong>${S.admin?'Cargalos de a uno con "+ Vehículo" o varios juntos con "Cargar flota".':'Cuando un administrador los cargue, aparecen acá.'}</div>`;
  if(F.sel && !vehPor(F.sel)) F.sel = null;
  if(!F.sel) F.sel = lista[0].id;
  return `
    ${al.length?`<div class="alertas">
      <h3>Para atender (${al.length})</h3>
      <ul>${al.slice(0,14).map(a=>`<li class="al-${a.nivel}"><button class="link" data-veh="${esc(a.v.id)}">${esc(a.v.patente)}</button> ${esc(a.txt)}</li>`).join('')}</ul>
      ${al.length>14?`<p class="muted">Y ${al.length-14} más.</p>`:''}</div>`:`<p class="ok">Todo en orden: sin vencimientos ni services pendientes.</p>`}
    <section class="v-ubic">
      <aside><div class="lista-veh">${lista.map(v=>{ const e = estadoVehiculo(v); return `
        <button class="ubic veh ${v.id===F.sel?'on':''} ${v.activo===false?'archivada':''}" data-veh="${esc(v.id)}">
          <span class="patente">${esc(v.patente)}</span>
          <span class="u-nom">${esc([v.marca, v.modelo].filter(Boolean).join(' ') || TIPOS_VEH[v.tipo])}</span>
          <span class="u-meta">${v.activo===false?'Fuera de servicio':esc(v.obra_id?nomUbic(v.obra_id):'Sin obra asignada')} · ${fmtU(kmActual(v), v)}</span>
          <span class="sems">${punto(e.venc,'Vencimientos')}<small>Venc.</small>${punto(e.serv,'Service')}<small>Service</small>${punto(e.rend,'Rendimiento')}<small>Rend.</small></span>
        </button>`; }).join('')}</div></aside>
      <section>${fichaVeh(vehPor(F.sel))}</section>
    </section>`;
}

function fichaVeh(v){
  if(!v) return '';
  const u = U(v);
  const vig = vencVigentes(v.id), ps = proxService(v), la = lecturaActual(v), r = rendimiento(v, hoy().slice(0,7));
  const cs = cargasDe(v.id).slice().sort((a,b)=>b.odometro-a.odometro);
  const valPorCarga = Object.fromEntries(tramos(v.id).map(t=>[t.carga.id, valorTramo(t, v)]));
  const servs = servDe(v.id), docs = docsDe(v.id);
  const vencsV = F.venc.filter(x=>x.vehiculo_id===v.id);
  fFirmar([...cs.slice(0,15), ...servs.slice(0,10), ...vencsV].flatMap(x=>x.fotos||[]).concat(docs.flatMap(d=>d.archivos||[])));
  const fotos = arr => (arr||[]).map((p,i)=>archivoLink(p, i, arr.length)).join(' ');
  const tiposVenc = [...new Set([...vencBasicos(v), ...Object.keys(vig)])];
  const rf = referencia(v).valor;
  const malRend = val => val!=null && rf && (u.horas ? (rf-val)/rf : (val-rf)/rf) < -DESVIO_ALERTA;
  return `<div class="det">
    <div class="det-head">
      <div><span class="u-tipo">${TIPOS_VEH[v.tipo]} · ${COMB[v.combustible]}${v.anio?' · '+v.anio:''} · se controla por ${u.largo}${v.activo===false?' · Fuera de servicio':''}</span>
        <h2><span class="patente grande">${esc(v.patente)}</span> ${esc([v.marca,v.modelo].filter(Boolean).join(' '))}</h2>
        <p class="a-cargo">${u.horas?'Operador':'Chofer'}: <strong>${esc(v.chofer||'—')}</strong> · Obra: <strong>${esc(v.obra_id?nomUbic(v.obra_id):'sin asignar')}</strong></p>
      </div>
      <div class="det-actions">
        ${S.admin?`<button class="btn primary sm" data-fact="carga">Cargar combustible</button>
        <button class="btn sm" data-fact="lectura">Actualizar ${u.largo}</button>
        <button class="btn sm" data-fact="service">Registrar service</button>
        <button class="btn sm" data-fact="venc">Cargar vencimiento</button>
        <button class="btn sm" data-fact="doc">Subir documento</button>`:''}
        <button class="btn sm" data-fact="pdfVeh">Ficha en PDF</button>
        ${S.admin?'<button class="btn ghost sm" data-fact="editarVeh">Editar</button>':''}
      </div>
    </div>

    <div class="kpis">
      <div class="kpi ${la.dias>DIAS_SIN_LECTURA?'sem-borde-amarillo':''}"><span class="k-lbl">${u.horas?'Horas de uso':'Kilometraje'}</span><span class="k-val">${fmtU(la.valor, v)}</span>
        <span class="k-sub">actualizado ${la.dias<=0?'hoy':la.dias===1?'ayer':`hace ${la.dias} días`}</span></div>
      <div class="kpi sem-borde-${ps.estado}"><span class="k-lbl">Próximo service</span><span class="k-val">${fmtU(ps.km, v)}</span>
        <span class="k-sub">${ps.falta>0?`faltan ${fmtU(ps.falta, v)}`:`pasado por ${fmtU(-ps.falta, v)}`} · o el ${fFecha(ps.fecha)}</span></div>
      <div class="kpi sem-borde-${r.estado}"><span class="k-lbl">Consumo ${nombreMes(hoy().slice(0,7)).split(' ')[0]}</span>
        <span class="k-val">${fmtRend(r.valor, v)}</span>
        <span class="k-sub">${textoRef(v)}${r.estado!=='gris'?` · ${r.desvio>=0?'+':''}${Math.round(r.desvio*100)} %`:''}</span></div>
    </div>

    <div class="seccion"><h3>Vencimientos</h3>
      <div class="tabla-wrap"><table><thead><tr><th>Qué</th><th>Detalle</th><th>Vence</th><th>Estado</th><th></th></tr></thead><tbody>
      ${tiposVenc.map(t=>{ const x = vig[t]; if(!x) return `<tr><td>${TIPOS_VENC[t]}</td><td class="muted">—</td><td>—</td><td>${chipEstado('amarillo','Sin cargar')}</td><td>${S.admin?`<button class="link" data-fact="venc" data-tipo="${t}">Cargar</button>`:''}</td></tr>`;
        const d = diasHasta(x.vence), e = estadoDias(d);
        return `<tr><td>${TIPOS_VENC[t]}</td><td>${esc(x.detalle)} ${fotos(x.fotos)}</td><td>${fFecha(x.vence)}</td>
          <td>${chipEstado(e, d<0?`Vencido (${-d} d)`:d<=30?`Vence en ${d} d`:'Al día')}</td>
          <td>${S.admin?`<button class="link" data-fact="venc" data-tipo="${t}">Renovar</button>`:''}</td></tr>`; }).join('')}
      </tbody></table></div></div>

    <div class="seccion"><h3>Documentos (${docs.length})</h3>
      ${docs.length?`<div class="docs">${docs.map(d=>`<div class="doc">
          <div class="doc-cab"><strong>${TIPOS_DOC[d.tipo]}</strong>${S.admin?`<button class="icono peligro" data-fact="borrarDoc" data-id="${esc(d.id)}" title="Eliminar documento" aria-label="Eliminar documento">${ICONO.tacho}</button>`:''}</div>
          ${d.detalle?`<span class="muted">${esc(d.detalle)}</span>`:''}
          <div class="doc-archivos">${(d.archivos||[]).map((p,i)=>archivoLink(p, i, d.archivos.length)).join('')}</div>
          <span class="doc-fecha">Subido ${fFecha(String(d.creado_en).slice(0,10))}</span></div>`).join('')}</div>`
        :`<div class="vacio chico">Sin documentos. ${S.admin?'Subí la póliza, la cédula, el título o la VTV con "Subir documento".':''}</div>`}</div>

    <div class="seccion"><h3>Consumo por mes</h3>
      <div class="tabla-wrap"><table><thead><tr><th>Mes</th><th class="num">${u.horas?'Horas':'Km'}</th><th class="num">Litros</th><th class="num">${u.rend}</th><th class="num">Gasto</th><th>Estado</th></tr></thead><tbody>
      ${ultimos6Meses().map(m=>{ const rm = rendimiento(v, m); const delMes = cargasDe(v.id).filter(c=>String(c.fecha).startsWith(m));
        const gasto = delMes.reduce((s,c)=>s+(Number(c.monto)||0),0), lts = delMes.reduce((s,c)=>s+Number(c.litros),0);
        return `<tr><td>${nombreMes(m)}</td><td class="num">${rm.uds?fmt(rm.uds):'—'}</td><td class="num">${lts?fmt(lts.toFixed(1)):'—'}</td>
          <td class="num">${rm.valor!=null?fmt(rm.valor.toFixed(1)):'—'}</td><td class="num">${gasto?fmtPlata(gasto):'—'}</td>
          <td>${rm.estado==='gris'?'<span class="muted">—</span>':chipEstado(rm.estado, `${rm.desvio>=0?'+':''}${Math.round(rm.desvio*100)} %`)}</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="ayuda chica">${u.horas?'Litros por hora = litros cargados ÷ horas de uso entre una carga y la anterior.':'Km por litro = km entre una carga y la anterior ÷ litros cargados.'} Se marca en rojo si da más de ${DESVIO_ALERTA*100} % peor que la referencia.</p></div>

    <div class="seccion"><h3>Cargas de combustible (${cs.length})</h3>
      ${cs.length?`<div class="tabla-wrap"><table><thead><tr><th>Fecha</th><th class="num">${u.lectura}</th><th class="num">Litros</th><th class="num">Monto</th><th class="num">${u.rend}</th><th>Obra</th><th></th></tr></thead><tbody>
      ${cs.slice(0,40).map(c=>{ const k = valPorCarga[c.id];
        return `<tr class="${S.admin?'click':''}" ${S.admin?`data-fedit="carga" data-id="${esc(c.id)}" tabindex="0"`:''}><td>${fFecha(c.fecha)}</td><td class="num">${fmt(c.odometro)}</td><td class="num">${fmt(c.litros)}</td>
          <td class="num">${fmtPlata(c.monto)}</td><td class="num ${malRend(k)?'txt-rojo':''}">${k!=null?fmt(k.toFixed(1)):'—'}</td><td>${esc(c.obra_id?nomUbic(c.obra_id):'—')}</td><td>${fotos(c.fotos)}</td></tr>`; }).join('')}
      </tbody></table></div>`:'<div class="vacio chico">Sin cargas todavía.</div>'}</div>

    <div class="seccion"><h3>Services y reparaciones (${servs.length})</h3>
      ${servs.length?`<div class="tabla-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th class="num">${u.horas?'Horas':'Km'}</th><th>Taller</th><th>Detalle</th><th class="num">Costo</th><th></th></tr></thead><tbody>
      ${servs.map(s=>`<tr class="${S.admin?'click':''}" ${S.admin?`data-fedit="service" data-id="${esc(s.id)}" tabindex="0"`:''}><td>${fFecha(s.fecha)}</td><td>${TIPOS_SERV[s.tipo]}</td><td class="num">${fmt(s.km)}</td><td>${esc(s.taller)}</td><td>${esc(s.detalle)}</td><td class="num">${fmtPlata(s.costo)}</td><td>${fotos(s.fotos)}</td></tr>`).join('')}
      </tbody></table></div>`:'<div class="vacio chico">Sin services registrados.</div>'}
      <p class="ayuda chica">Service cada ${fmtU(v.service_cada_km, v)} o ${v.service_cada_meses} meses, lo que llegue primero. Solo los de tipo "Service" reinician el contador.</p></div>
    ${v.nota?`<p class="muted">${esc(v.nota)}</p>`:''}
  </div>`;
}

function vistaObras(){
  const m = F.mes;
  const cs = F.cargas.filter(c=>String(c.fecha).startsWith(m));
  const udsPorCarga = {};
  for(const v of F.veh) for(const t of tramos(v.id)) udsPorCarga[t.carga.id] = t.uds;
  const grupos = {};
  for(const c of cs){
    const v = vehPor(c.vehiculo_id);
    const g = grupos[c.obra_id||'—'] ??= {litros:0, monto:0, km:0, horas:0, veh:new Set(), cargas:0};
    g.litros += Number(c.litros); g.monto += Number(c.monto)||0; g.veh.add(c.vehiculo_id); g.cargas++;
    if(U(v).horas) g.horas += udsPorCarga[c.id]||0; else g.km += udsPorCarga[c.id]||0;
  }
  const distDe = id => F.dist.find(d=>d.obra_id===id)?.km_ida;
  const obras = Object.keys(grupos).sort((a,b)=>grupos[b].monto-grupos[a].monto);
  const tot = Object.values(grupos).reduce((t,g)=>({litros:t.litros+g.litros, monto:t.monto+g.monto, km:t.km+g.km, horas:t.horas+g.horas}), {litros:0,monto:0,km:0,horas:0});
  const todasObras = S.ubic.filter(u=>u.tipo==='obra').sort(porNombre);
  return `
    <div class="filtros-mes"><label><span>Mes</span><input type="month" id="fMes" value="${esc(m)}"></label></div>
    ${obras.length?`<div class="tabla-wrap"><table><thead><tr><th>Obra</th><th class="num">Cargas</th><th class="num">Litros</th><th class="num">Gasto</th><th class="num">Km</th><th class="num">Horas máq.</th><th class="num">Distancia (ida)</th><th class="num">Viajes equiv.</th><th>Vehículos</th></tr></thead><tbody>
      ${obras.map(id=>{ const g = grupos[id], d = id==='—' ? null : distDe(id);
        const viajes = d && g.km ? g.km/(2*d) : null;
        return `<tr><td>${id==='—'?'<span class="muted">Sin obra imputada</span>':esc(nomUbic(id))}</td><td class="num">${g.cargas}</td><td class="num">${fmt(g.litros.toFixed(1))}</td><td class="num">${fmtPlata(g.monto)}</td>
          <td class="num">${g.km?fmt(g.km):'—'}</td><td class="num">${g.horas?fmt(g.horas):'—'}</td>
          <td class="num">${d?fmt(d)+' km':(id!=='—'&&S.admin?'<button class="link" data-fact="dist" data-obra="'+esc(id)+'">Cargar</button>':'—')}</td>
          <td class="num">${viajes!=null?fmt(viajes.toFixed(1)):'—'}</td><td>${[...g.veh].map(x=>esc(vehPor(x)?.patente||'?')).join(', ')}</td></tr>`; }).join('')}
      <tr class="total"><td>Total</td><td class="num">${cs.length}</td><td class="num">${fmt(tot.litros.toFixed(1))}</td><td class="num">${fmtPlata(tot.monto)}</td><td class="num">${fmt(tot.km)}</td><td class="num">${tot.horas?fmt(tot.horas):'—'}</td><td></td><td></td><td></td></tr>
    </tbody></table></div>`:`<div class="vacio">No hay cargas de combustible en ${nombreMes(m)}.</div>`}
    <p class="ayuda chica"><strong>Viajes equivalentes</strong> = km imputados a la obra ÷ (2 × distancia de ida). Si una obra está a 60 km y dio 3.600 km, equivale a 30 viajes de ida y vuelta: compará con los días que realmente se trabajó para detectar km de más. Las máquinas suman en "Horas máq.".</p>
    ${S.admin&&todasObras.length?`<details class="dist-edit"><summary>Distancias de las obras</summary>
      <div class="tabla-wrap"><table><thead><tr><th>Obra</th><th class="num">Km de ida desde la base</th></tr></thead><tbody>
      ${todasObras.map(u=>`<tr><td>${esc(u.nombre)}</td><td class="num"><input class="dist-in" type="number" min="0" step="1" data-obra="${esc(u.id)}" value="${distDe(u.id) ?? ''}" placeholder="—" aria-label="Distancia a ${esc(u.nombre)}"></td></tr>`).join('')}
      </tbody></table></div><p class="ayuda chica">Se guarda al salir de cada casillero.</p></details>`:''}`;
}

/* ---------------- 4) Formularios ---------------- */
const dlgFl = $('#dlgFlota');
const obrasOpts = (sel, vacio='Sin obra') => `<option value="">${vacio}</option>` +
  S.ubic.filter(u=>u.tipo==='obra' && (u.activa!==false || u.id===sel)).sort(porNombre).map(u=>`<option value="${esc(u.id)}" ${u.id===sel?'selected':''}>${esc(u.nombre)}</option>`).join('');
const opts = (obj, sel) => Object.entries(obj).map(([k,v])=>`<option value="${k}" ${k===sel?'selected':''}>${v}</option>`).join('');
const vehOpts = sel => F.veh.filter(v=>v.activo!==false).sort((a,b)=>a.patente.localeCompare(b.patente)).map(v=>`<option value="${esc(v.id)}" ${v.id===sel?'selected':''}>${esc(vehNom(v))}</option>`).join('');
const campo = (lbl, html, cls='') => `<label class="${cls}"><span>${lbl}</span>${html}</label>`;
const val = id => $('#'+id)?.value.trim() ?? '';
const num = id => { const x = val(id).replace(/\./g,'').replace(',','.'); return x==='' ? null : Number(x); };
const fotoInput = (lbl, accept='image/*,application/pdf') => `<div class="foto-box"><span class="lbl">${lbl}</span><div id="flPrev" class="previews"></div><input type="file" id="flFoto" accept="${accept}" multiple></div>`;

function abrirForm(tipo, id, extra={}){
  F.form = {tipo, id, extra}; F.fotos = [];
  const v = vehPor(F.sel), u = U(v);
  let titulo='', body='', boton='Guardar', borrar=false;
  if(tipo==='veh'){
    const x = id ? vehPor(id) : {};
    titulo = id ? `Editar ${x.patente}` : 'Nuevo vehículo o máquina';
    body = `<div class="grid2">
      ${campo('Patente o identificación', `<input id="fv_pat" value="${esc(x.patente||'')}" placeholder="AB123CD o MAQ01" autocomplete="off">`)}
      ${campo('Tipo', `<select id="fv_tipo">${opts(TIPOS_VEH, x.tipo||'camioneta')}</select>`)}
      ${campo('Se controla por', `<select id="fv_uni"><option value="km" ${x.unidad!=='horas'?'selected':''}>Kilómetros (odómetro)</option><option value="horas" ${x.unidad==='horas'?'selected':''}>Horas de uso (horómetro)</option></select>`)}
      ${campo('Marca', `<input id="fv_marca" value="${esc(x.marca||'')}" placeholder="Toyota" autocomplete="off">`)}
      ${campo('Modelo', `<input id="fv_modelo" value="${esc(x.modelo||'')}" placeholder="Hilux 2.8" autocomplete="off">`)}
      ${campo('Año', `<input id="fv_anio" type="number" min="1950" max="2100" value="${x.anio??''}">`)}
      ${campo('Combustible', `<select id="fv_comb">${opts(COMB, x.combustible||'gasoil')}</select>`)}
      ${campo('<span id="lv_ref">Consumo de referencia</span>', `<input id="fv_ref" type="number" step="0.1" min="0" value="${x.km_l_ref??''}"><small class="muted">Dejalo vacío y el sistema usa el promedio propio del vehículo.${promedioPropio(x) ? ` Su promedio hoy: ${fmt(promedioPropio(x).toFixed(1))}.` : ''}</small>`)}
      ${campo(`<span id="lv_kmi">${id?'Valor al darlo de alta':'Km u horas actuales'}</span>`, `<input id="fv_kmi" type="number" min="0" value="${x.km_inicial??''}">`)}
      ${campo('<span id="lv_skm">Service cada</span>', `<input id="fv_skm" type="number" min="1" value="${x.service_cada_km??''}">`)}
      ${campo('Service cada (meses)', `<input id="fv_sm" type="number" min="1" value="${x.service_cada_meses??6}">`)}
      ${campo('Chofer / operador', `<input id="fv_chofer" value="${esc(x.chofer||'')}" autocomplete="off">`)}
      ${campo('Obra donde trabaja', `<select id="fv_obra">${obrasOpts(x.obra_id,'Sin asignar')}</select>`)}
    </div>
    ${campo('Notas', `<textarea id="fv_nota" rows="2">${esc(x.nota||'')}</textarea>`)}
    ${id?`<label class="check"><input type="checkbox" id="fv_activo" ${x.activo!==false?'checked':''}> En servicio (desmarcalo si se vendió o quedó fuera de uso; el historial se conserva)</label>`:''}`;
  }
  if(tipo==='cargarFlota'){
    titulo = 'Cargar flota'; boton = 'Guardar todos';
    body = `<p class="ayuda">Una fila por vehículo o máquina. Después podés completar el resto de cada ficha (rendimiento, service, vencimientos) con "Editar".</p>
      <div class="ff-cab"><span>Patente / ID</span><span>Marca</span><span>Modelo</span><span>Tipo</span><span>Por</span><span>Km/horas actuales</span><span>Chofer</span><span>Obra</span><span></span></div>
      <div id="filasFlota" class="filas"></div>
      <button type="button" class="btn ghost sm" data-fact="filaFlota">+ Fila</button>`;
  }
  if(tipo==='lecturas'){
    titulo = 'Actualizar km / horas'; boton = 'Guardar lecturas';
    const act = F.veh.filter(x=>x.activo!==false).sort((a,b)=>a.patente.localeCompare(b.patente));
    body = `<p class="ayuda">Anotá lo que marca hoy el odómetro u horómetro de cada uno. Dejá vacío lo que no sepas. Así el próximo service se calcula con el dato real aunque no haya cargado combustible.</p>
      ${campo('Fecha de la lectura', `<input id="fl_fecha" type="date" value="${hoy()}">`)}
      <div class="tabla-wrap"><table><thead><tr><th>Vehículo</th><th class="num">Último dato</th><th class="num">Hoy marca</th></tr></thead><tbody>
      ${act.map(x=>{ const la = lecturaActual(x); return `<tr><td>${esc(vehNom(x))}</td><td class="num">${fmtU(la.valor, x)}<br><small class="muted">${la.dias<=0?'hoy':`hace ${la.dias} d`}</small></td>
        <td class="num"><input class="lec-in" type="number" min="0" data-veh="${esc(x.id)}" placeholder="${U(x).u}" aria-label="Lectura de ${esc(x.patente)}"></td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  if(tipo==='lectura'){
    titulo = `Actualizar ${u.largo} · ${v?.patente||''}`;
    body = `<div class="grid2">
      ${campo(`${u.lectura} hoy (${u.u})`, `<input id="fl_valor" type="number" min="0" placeholder="Último: ${fmt(kmActual(v))}">`)}
      ${campo('Fecha', `<input id="fl_fecha" type="date" value="${hoy()}">`)}
    </div>${campo('Nota', `<input id="fl_nota" placeholder="Opcional" autocomplete="off">`)}`;
  }
  if(tipo==='carga'){
    const x = id ? F.cargas.find(c=>c.id===id) : {};
    const vid = x.vehiculo_id || v?.id, vv = vehPor(vid), uu = U(vv);
    titulo = id ? 'Editar carga' : `Cargar combustible · ${vv?.patente||''}`;
    borrar = !!id;
    body = `<div class="grid2">
      ${campo('Vehículo', `<select id="fc_veh">${vehOpts(vid)}</select>`)}
      ${campo('Fecha', `<input id="fc_fecha" type="date" value="${esc(x.fecha||hoy())}">`)}
      ${campo(`<span id="lc_odo">${uu.lectura} (${uu.u})</span>`, `<input id="fc_odo" type="number" min="0" value="${x.odometro??''}" placeholder="Último: ${vv?fmt(kmActual(vv)):'—'}">`)}
      ${campo('Litros', `<input id="fc_lts" type="number" step="0.01" min="0" value="${x.litros??''}">`)}
      ${campo('Monto ($)', `<input id="fc_monto" type="number" step="0.01" min="0" value="${x.monto??''}">`)}
      ${campo('Imputar a la obra', `<select id="fc_obra">${obrasOpts(id ? x.obra_id : vv?.obra_id)}</select>`)}
      ${campo('Estación', `<input id="fc_est" value="${esc(x.estacion||'')}" placeholder="Opcional" autocomplete="off">`)}
    </div>${campo('Nota', `<input id="fc_nota" value="${esc(x.nota||'')}" autocomplete="off">`)}${fotoInput('Foto del ticket (opcional)')}`;
  }
  if(tipo==='service'){
    const x = id ? F.serv.find(s=>s.id===id) : {};
    titulo = id ? 'Editar service' : `Registrar service · ${v?.patente||''}`;
    borrar = !!id;
    body = `<div class="grid2">
      ${campo('Tipo', `<select id="fs_tipo">${opts(TIPOS_SERV, x.tipo||'service')}</select>`)}
      ${campo('Fecha', `<input id="fs_fecha" type="date" value="${esc(x.fecha||hoy())}">`)}
      ${campo(`${u.horas?'Horas':'Km'} al momento del service`, `<input id="fs_km" type="number" min="0" value="${x.km ?? (v?kmActual(v):'')}">`)}
      ${campo('Taller', `<input id="fs_taller" value="${esc(x.taller||'')}" autocomplete="off">`)}
      ${campo('Costo ($)', `<input id="fs_costo" type="number" step="0.01" min="0" value="${x.costo??''}">`)}
    </div>${campo('Qué se hizo', `<textarea id="fs_det" rows="2" placeholder="Ej. aceite, filtros de aire y combustible">${esc(x.detalle||'')}</textarea>`)}${fotoInput('Foto de la factura (opcional)')}`;
  }
  if(tipo==='venc'){
    const t = extra.tipo || (u.horas ? 'seguro' : 'vtv');
    const prev = vencVigentes(v?.id)[t];
    titulo = `${prev ? 'Renovar' : 'Cargar'} vencimiento · ${v?.patente||''}`;
    body = `<div class="grid2">
      ${campo('Qué vence', `<select id="fe_tipo">${opts(TIPOS_VENC, t)}</select>`)}
      ${campo('Fecha de vencimiento', `<input id="fe_vence" type="date">`)}
    </div>${campo('Detalle', `<input id="fe_det" value="${esc(prev?.detalle || '')}" placeholder="${t==='registro'?'Nombre del chofer y categoría':t==='seguro'?'Compañía y N° de póliza':t==='matafuegos'?'Ej. 5 kg ABC · N° de serie · empresa que lo recargó':'Opcional'}" autocomplete="off">`)}
    ${prev?`<p class="ayuda chica">El anterior vencía el ${fFecha(prev.vence)}. Queda en el historial.</p>`:''}${fotoInput('Foto o PDF del comprobante (opcional)')}`;
  }
  if(tipo==='doc'){
    titulo = `Subir documento · ${v?.patente||''}`; boton = 'Subir';
    body = `<div class="grid2">
      ${campo('Tipo de documento', `<select id="fd_tipo">${opts(TIPOS_DOC, 'poliza')}</select>`)}
      ${campo('Detalle', `<input id="fd_det" placeholder="Ej. La Segunda · Póliza 123456 · 2026-2027" autocomplete="off">`)}
    </div>${fotoInput('Archivos (PDF o fotos, podés elegir varios)')}
    <p class="ayuda chica">Si el documento tiene vencimiento (póliza, VTV), cargalo también en "Cargar vencimiento" para que el sistema te avise.</p>`;
  }
  if(tipo==='dist'){
    titulo = `Distancia a ${nomUbic(extra.obra)}`;
    body = campo('Km de ida desde la base', `<input id="fd_km" type="number" min="0" step="1">`);
  }
  if(tipo==='tarjeta'){
    titulo = 'Cargar resumen de tarjeta'; boton = 'Guardar todas las cargas';
    body = `<p class="ayuda">Pasá el resumen mensual de la tarjeta de flota: una fila por carga. La obra se completa con la que tiene asignada el vehículo; cambiala si la carga fue para otra.</p>
      <div id="filasTarj" class="filas tarj"></div>
      <button type="button" class="btn ghost sm" data-fact="filaTarj">+ Fila</button>`;
  }
  $('#flTitulo').textContent = titulo;
  $('#flBody').innerHTML = body + '<p id="flError" class="error" hidden></p>';
  $('#flFoot').innerHTML = `${borrar?'<button type="button" class="btn danger" data-fact="borrar" style="margin-right:auto">Eliminar</button>':''}
    <button type="button" class="btn" data-close>Cancelar</button><button type="button" class="btn primary" data-fact="guardar">${boton}</button>`;
  if(tipo==='tarjeta'){ for(let i=0;i<4;i++) filaTarj(); }
  if(tipo==='cargarFlota'){ for(let i=0;i<4;i++) filaFlota(); }
  if(tipo==='veh') etiquetasUnidad();
  if(tipo==='dist') $('#fd_km').value = F.dist.find(d=>d.obra_id===extra.obra)?.km_ida ?? '';
  if(!dlgFl.open) dlgFl.showModal();
}
// En el formulario de vehículo, los textos cambian según km u horas
function etiquetasUnidad(){
  const h = $('#fv_uni')?.value==='horas';
  $('#lv_ref').textContent = h ? 'Consumo de referencia (litros por hora)' : 'Rendimiento de referencia (km por litro)';
  $('#fv_ref').placeholder = h ? 'Ej. 12' : 'Ej. 9';
  $('#lv_skm').textContent = h ? 'Service cada (horas)' : 'Service cada (km)';
  if(!F.form.id || !$('#fv_skm').value) $('#fv_skm').value = $('#fv_skm').value || (h ? 250 : 10000);
  if(!F.form.id) $('#lv_kmi').textContent = h ? 'Horas actuales (horómetro)' : 'Kilometraje actual';
}
function filaTarj(){
  const ult = [...document.querySelectorAll('#filasTarj .ft')].pop();
  const vid = ult?.querySelector('.t_veh').value || F.sel;
  $('#filasTarj').insertAdjacentHTML('beforeend', `<div class="ft">
    <select class="t_veh" aria-label="Vehículo">${vehOpts(vid)}</select>
    <input class="t_fecha" type="date" value="${ult?.querySelector('.t_fecha').value || hoy()}" aria-label="Fecha">
    <input class="t_odo" type="number" min="0" placeholder="Km / horas" aria-label="Odómetro u horómetro">
    <input class="t_lts" type="number" step="0.01" min="0" placeholder="Litros" aria-label="Litros">
    <input class="t_monto" type="number" step="0.01" min="0" placeholder="$" aria-label="Monto">
    <select class="t_obra" aria-label="Obra">${obrasOpts(vehPor(vid)?.obra_id)}</select>
    <button type="button" class="x" data-fact="quitarFila" aria-label="Quitar">×</button></div>`);
}
function filaFlota(){
  $('#filasFlota').insertAdjacentHTML('beforeend', `<div class="ff">
    <input class="v_pat" placeholder="AB123CD" aria-label="Patente" autocomplete="off">
    <input class="v_marca" placeholder="Marca" aria-label="Marca" autocomplete="off">
    <input class="v_modelo" placeholder="Modelo" aria-label="Modelo" autocomplete="off">
    <select class="v_tipo" aria-label="Tipo">${opts(TIPOS_VEH,'camioneta')}</select>
    <select class="v_uni" aria-label="Se controla por"><option value="km">Km</option><option value="horas">Horas</option></select>
    <input class="v_km" type="number" min="0" placeholder="Km / horas" aria-label="Km u horas actuales">
    <input class="v_chofer" placeholder="Chofer" aria-label="Chofer" autocomplete="off">
    <select class="v_obra" aria-label="Obra">${obrasOpts(null,'Sin obra')}</select>
    <button type="button" class="x" data-fact="quitarFila" aria-label="Quitar">×</button></div>`);
}
function errForm(m){ const e=$('#flError'); e.textContent=m; e.hidden=false; e.scrollIntoView({block:'nearest'}); }
// El odómetro/horómetro de una carga no puede ir para atrás respecto de otras cargas
function chequearOdometro(vid, odo, fecha, idExcluir){
  const v = vehPor(vid), u = U(v);
  const otras = cargasDe(vid).filter(c=>c.id!==idExcluir);
  const antes = otras.filter(c=>c.fecha<=fecha).sort((a,b)=>b.odometro-a.odometro)[0];
  const despues = otras.filter(c=>c.fecha>fecha).sort((a,b)=>a.odometro-b.odometro)[0];
  if(antes && odo < antes.odometro) return `El ${u.lectura.toLowerCase()} (${fmt(odo)}) es menor que el de una carga anterior (${fmt(antes.odometro)} el ${fFecha(antes.fecha)}). Revisalo.`;
  if(despues && odo > despues.odometro) return `El ${u.lectura.toLowerCase()} (${fmt(odo)}) es mayor que el de una carga posterior (${fmt(despues.odometro)} el ${fFecha(despues.fecha)}). Revisá la fecha.`;
  if(v && odo < Number(v.km_inicial)) return `El valor es menor que el que tenía al darlo de alta (${fmtU(v.km_inicial, v)}).`;
  return null;
}

async function guardarForm(btn){
  const {tipo, id, extra} = F.form;
  const conFotos = async (prev=[]) => F.fotos.length ? [...prev, ...await subirArchivos(F.fotos.map(f=>f.file))] : prev;
  let res;
  btn.disabled = true;
  try{
    if(tipo==='veh'){
      const patente = normPatente(val('fv_pat'));
      if(patente.length < 3) throw new Error('Poné la patente o un identificador (ej. AB123CD o MAQ01).');
      if(F.veh.some(v=>v.patente===patente && v.id!==id)) throw new Error('Ya hay un vehículo con esa patente.');
      const h = val('fv_uni')==='horas';
      const fila = {patente, tipo:val('fv_tipo'), unidad:h?'horas':'km', marca:val('fv_marca'), modelo:val('fv_modelo'), anio:num('fv_anio'),
        combustible:val('fv_comb'), km_l_ref:num('fv_ref'), km_inicial:num('fv_kmi') ?? 0, service_cada_km:num('fv_skm')||(h?250:10000),
        service_cada_meses:num('fv_sm')||6, chofer:val('fv_chofer'), obra_id:val('fv_obra')||null, nota:val('fv_nota')};
      if(id) fila.activo = $('#fv_activo').checked;
      res = id ? await sb.from('vehiculos').update(fila).eq('id',id).select().single() : await sb.from('vehiculos').insert(fila).select().single();
      if(!res.error){ F.sel = res.data.id; guardarSelVeh(); }
    }
    if(tipo==='cargarFlota'){
      const filas = [], vistas = new Set();
      for(const [n, f] of [...document.querySelectorAll('#filasFlota .ff')].entries()){
        const patente = normPatente(f.querySelector('.v_pat').value);
        const resto = ['.v_marca','.v_modelo','.v_km','.v_chofer'].some(s=>f.querySelector(s).value.trim());
        if(!patente && !resto) continue;
        if(patente.length < 3) throw new Error(`Fila ${n+1}: falta la patente o identificador.`);
        if(vistas.has(patente) || F.veh.some(v=>v.patente===patente)) throw new Error(`Fila ${n+1}: la patente ${patente} ya está cargada.`);
        vistas.add(patente);
        const h = f.querySelector('.v_uni').value==='horas';
        filas.push({patente, marca:f.querySelector('.v_marca').value.trim(), modelo:f.querySelector('.v_modelo').value.trim(),
          tipo:f.querySelector('.v_tipo').value, unidad:h?'horas':'km', km_inicial:Number(f.querySelector('.v_km').value)||0,
          service_cada_km: h?250:10000, chofer:f.querySelector('.v_chofer').value.trim(), obra_id:f.querySelector('.v_obra').value||null});
      }
      if(!filas.length) throw new Error('Completá al menos una fila.');
      res = await sb.from('vehiculos').insert(filas);
    }
    if(tipo==='lecturas' || tipo==='lectura'){
      const fecha = val('fl_fecha') || hoy();
      const pares = tipo==='lectura' ? [[F.sel, num('fl_valor')]] : [...document.querySelectorAll('.lec-in')].map(i=>[i.dataset.veh, i.value===''?null:Number(i.value)]);
      const filas = [];
      for(const [vid, valor] of pares){
        if(valor==null) continue;
        const v = vehPor(vid), ant = kmActual(v);
        if(valor < ant) throw new Error(`${v.patente}: ${fmtU(valor, v)} es menos que el último dato (${fmtU(ant, v)}). Revisalo.`);
        if(!U(v).horas && valor - ant > 20000) throw new Error(`${v.patente}: son ${fmtU(valor-ant, v)} más que el último dato. ¿Está bien escrito?`);
        filas.push({vehiculo_id:vid, fecha, valor, nota: tipo==='lectura' ? val('fl_nota') : '', creado_por:S.me});
      }
      if(!filas.length) throw new Error('Anotá al menos una lectura.');
      res = await sb.from('lecturas_vehiculo').insert(filas);
    }
    if(tipo==='carga'){
      const vid = val('fc_veh'), odo = num('fc_odo'), lts = num('fc_lts'), fecha = val('fc_fecha');
      if(!vid) throw new Error('Elegí el vehículo.');
      if(odo==null) throw new Error(`Poné el ${U(vehPor(vid)).lectura.toLowerCase()}: sin él no se puede calcular el consumo.`);
      if(!(lts>0)) throw new Error('Poné los litros cargados.');
      const malOdo = chequearOdometro(vid, odo, fecha, id); if(malOdo) throw new Error(malOdo);
      const prev = id ? F.cargas.find(c=>c.id===id).fotos : [];
      const fila = {vehiculo_id:vid, fecha, odometro:odo, litros:lts, monto:num('fc_monto'), obra_id:val('fc_obra')||null, estacion:val('fc_est'), nota:val('fc_nota'), fotos: await conFotos(prev)};
      if(!id) fila.creado_por = S.me;
      res = id ? await sb.from('cargas_combustible').update(fila).eq('id',id) : await sb.from('cargas_combustible').insert(fila);
    }
    if(tipo==='service'){
      const km = num('fs_km'); if(km==null) throw new Error('Poné los km u horas al momento del service.');
      const prev = id ? F.serv.find(s=>s.id===id).fotos : [];
      const fila = {vehiculo_id: id ? F.serv.find(s=>s.id===id).vehiculo_id : F.sel, tipo:val('fs_tipo'), fecha:val('fs_fecha')||hoy(), km,
        taller:val('fs_taller'), costo:num('fs_costo'), detalle:val('fs_det'), fotos: await conFotos(prev)};
      if(!id) fila.creado_por = S.me;
      res = id ? await sb.from('services_vehiculo').update(fila).eq('id',id) : await sb.from('services_vehiculo').insert(fila);
    }
    if(tipo==='venc'){
      if(!val('fe_vence')) throw new Error('Poné la fecha de vencimiento.');
      const fila = {vehiculo_id:F.sel, tipo:val('fe_tipo'), vence:val('fe_vence'), detalle:val('fe_det'), fotos: await conFotos(), creado_por:S.me};
      res = await sb.from('vencimientos').insert(fila);
    }
    if(tipo==='doc'){
      if(!F.fotos.length) throw new Error('Elegí al menos un archivo.');
      res = await sb.from('documentos_vehiculo').insert({vehiculo_id:F.sel, tipo:val('fd_tipo'), detalle:val('fd_det'), archivos: await conFotos(), creado_por:S.me});
    }
    if(tipo==='dist'){
      const km = num('fd_km');
      res = km==null ? await sb.from('distancias_obra').delete().eq('obra_id', extra.obra)
                     : await sb.from('distancias_obra').upsert({obra_id:extra.obra, km_ida:km});
    }
    if(tipo==='tarjeta'){
      const filas = [];
      for(const [n, f] of [...document.querySelectorAll('#filasTarj .ft')].entries()){
        const odo = f.querySelector('.t_odo').value, lts = f.querySelector('.t_lts').value, monto = f.querySelector('.t_monto').value;
        if(!odo && !lts && !monto) continue;
        const fila = {vehiculo_id:f.querySelector('.t_veh').value, fecha:f.querySelector('.t_fecha').value, odometro:Number(odo), litros:Number(lts),
          monto: monto===''?null:Number(monto), obra_id:f.querySelector('.t_obra').value||null, creado_por:S.me, nota:'Resumen de tarjeta'};
        if(!odo || !(fila.litros>0)) throw new Error(`Fila ${n+1}: faltan los km/horas o los litros.`);
        const mal = chequearOdometro(fila.vehiculo_id, fila.odometro, fila.fecha); if(mal) throw new Error(`Fila ${n+1} (${vehPor(fila.vehiculo_id).patente}): ${mal}`);
        filas.push(fila);
      }
      if(!filas.length) throw new Error('Completá al menos una fila.');
      res = await sb.from('cargas_combustible').insert(filas);
    }
    if(res?.error) throw new Error(/duplicate/i.test(res.error.message) ? 'Ya existe un registro igual (¿patente repetida?).' : 'No se pudo guardar. Revisá la conexión y probá de nuevo.');
    dlgFl.close();
    await fCargarTodo();
  }catch(e){
    btn.disabled = false;
    errForm(e.message);
  }
}
async function borrarForm(btn){
  const {tipo, id} = F.form;
  if(btn.dataset.ok!=='1'){ btn.dataset.ok='1'; btn.textContent='¿Seguro? Tocá de nuevo'; return; }
  btn.disabled = true;
  const tabla = tipo==='carga' ? 'cargas_combustible' : 'services_vehiculo';
  const {error} = await sb.from(tabla).delete().eq('id', id);
  if(error){ btn.disabled=false; return errForm('No se pudo eliminar.'); }
  dlgFl.close(); fCargarTodo();
}
async function borrarDoc(btn){
  if(btn.dataset.ok!=='1'){ btn.dataset.ok='1'; btn.classList.add('confirmar'); btn.innerHTML='¿Borrar?'; return; }
  const {error} = await sb.from('documentos_vehiculo').delete().eq('id', btn.dataset.id);
  if(!error) fCargar('documentos_vehiculo');
}
function guardarSelVeh(){ try{ localStorage.setItem('flota.sel', F.sel||''); }catch(e){} }

/* ---------------- 5) PDF del estado de la flota (para WhatsApp) ----------------
   Se arma con jsPDF (se descarga la primera vez que se usa). En el celular abre el
   menú de compartir del teléfono (WhatsApp, mail…); en la compu descarga el PDF. */
const LIBS_PDF = ['https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
                  'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js'];
function cargarScript(src){
  return new Promise((ok, mal)=>{ if(document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ()=>mal(new Error('No se pudo cargar el generador de PDF. Revisá la conexión.')); document.head.appendChild(s); });
}
const COLOR_PDF = {rojo:[253,236,234], amarillo:[251,241,220], verde:[227,243,234], gris:[245,245,245]};
// Ficha completa de UN vehículo (A4 vertical)
function pdfFicha(v){
  const u = U(v), doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const vig = vencVigentes(v.id), ps = proxService(v), la = lecturaActual(v), r = rendimiento(v, hoy().slice(0,7));
  const tabla = (titulo, head, body, opciones={}) => {
    let y = (doc.lastAutoTable?.finalY ?? 50) + 9;
    if(y > H-30){ doc.addPage(); y = 16; }
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(0); doc.text(titulo, 14, y);
    doc.autoTable({startY:y+2, head:[head], body: body.length?body:[[{content:'Sin datos', colSpan:head.length, styles:{textColor:120}}]], theme:'grid',
      styles:{fontSize:8.5, cellPadding:1.8}, headStyles:{fillColor:[60,60,60], textColor:255}, margin:{left:14, right:14}, ...opciones});
  };
  // Encabezado
  doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.text(v.patente, 14, 18);
  doc.setFontSize(12); doc.setFont('helvetica','normal');
  doc.text([v.marca, v.modelo, v.anio].filter(Boolean).join(' ') || TIPOS_VEH[v.tipo], 14, 25);
  doc.setFontSize(8.5); doc.setTextColor(90);
  doc.text(`${EMPRESA.razon} · Estado al ${fFecha(hoy())}`, W-14, 18, {align:'right'});
  doc.text(`${TIPOS_VEH[v.tipo]} · ${COMB[v.combustible]} · se controla por ${u.largo}`, W-14, 23, {align:'right'});
  doc.setTextColor(0); doc.setFontSize(9.5);
  doc.text(`${u.horas?'Operador':'Chofer'}: ${v.chofer||'—'}     Obra: ${v.obra_id?nomUbic(v.obra_id):'sin asignar'}`, 14, 31);
  // Resumen (3 recuadros)
  const cajas = [
    [u.horas?'Horas de uso':'Kilometraje', fmtU(la.valor, v), la.dias<=0?'actualizado hoy':`actualizado hace ${la.dias} días`, la.dias>DIAS_SIN_LECTURA?'amarillo':'gris'],
    ['Próximo service', fmtU(ps.km, v), `${ps.falta>0?'faltan '+fmtU(ps.falta, v):'PASADO por '+fmtU(-ps.falta, v)} · o el ${fFecha(ps.fecha)}`, ps.estado],
    [`Consumo ${nombreMes(hoy().slice(0,7))}`, fmtRend(r.valor, v), textoRef(v), r.estado]
  ];
  const ancho = (W-28-8)/3;
  cajas.forEach(([t, val, sub, e], i)=>{
    const x = 14 + i*(ancho+4);
    doc.setFillColor(...(COLOR_PDF[e]||COLOR_PDF.gris)); doc.roundedRect(x, 35, ancho, 20, 2, 2, 'F');
    doc.setFontSize(7.5); doc.setTextColor(90); doc.text(t.toUpperCase(), x+3, 40);
    doc.setFontSize(13); doc.setTextColor(0); doc.setFont('helvetica','bold'); doc.text(val, x+3, 47);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(70); doc.text(doc.splitTextToSize(sub, ancho-6), x+3, 52);
  });
  doc.setTextColor(0); doc.lastAutoTable = {finalY: 57};
  // Para atender
  const al = alertasDe(v);
  tabla(`Para atender (${al.length})`, ['Aviso'], al.map(a=>[a.txt]),
    {didParseCell: d=>{ if(d.section==='body' && al[d.row.index]) d.cell.styles.fillColor = COLOR_PDF[al[d.row.index].nivel]; }});
  // Vencimientos
  const tiposV = [...new Set([...vencBasicos(v), ...Object.keys(vig)])];
  const filasV = tiposV.map(t=>{ const x = vig[t]; if(!x) return [TIPOS_VENC[t], '—', '—', 'Sin cargar'];
    const d = diasHasta(x.vence); return [TIPOS_VENC[t], x.detalle||'', fFecha(x.vence), d<0?`Vencido hace ${-d} d`:d<=30?`Vence en ${d} d`:'Al día']; });
  tabla('Vencimientos', ['Qué','Detalle','Vence','Estado'], filasV,
    {didParseCell: d=>{ if(d.section!=='body') return; const t = tiposV[d.row.index], x = vig[t];
      d.cell.styles.fillColor = COLOR_PDF[x ? estadoDias(diasHasta(x.vence)) : 'amarillo']; }});
  // Consumo por mes
  const filasC = ultimos6Meses().map(m=>{ const rm = rendimiento(v, m), delMes = cargasDe(v.id).filter(c=>String(c.fecha).startsWith(m));
    return [nombreMes(m), rm.uds?fmt(rm.uds):'—', delMes.length?fmt(delMes.reduce((s,c)=>s+Number(c.litros),0).toFixed(1)):'—',
      rm.valor!=null?fmt(rm.valor.toFixed(1)):'—', delMes.length?fmtPlata(delMes.reduce((s,c)=>s+(Number(c.monto)||0),0)):'—']; });
  tabla('Consumo por mes', ['Mes', u.horas?'Horas':'Km', 'Litros', u.rend, 'Gasto'], filasC, {columnStyles:{1:{halign:'right'},2:{halign:'right'},3:{halign:'right'},4:{halign:'right'}}});
  // Últimas cargas
  const vals = Object.fromEntries(tramos(v.id).map(t=>[t.carga.id, valorTramo(t, v)]));
  const filasK = cargasDe(v.id).slice().sort((a,b)=>b.odometro-a.odometro).slice(0,12).map(c=>[fFecha(c.fecha), fmt(c.odometro), fmt(c.litros), fmtPlata(c.monto), vals[c.id]!=null?fmt(vals[c.id].toFixed(1)):'—', c.obra_id?nomUbic(c.obra_id):'—']);
  tabla('Últimas cargas de combustible', ['Fecha', u.lectura, 'Litros', 'Monto', u.rend, 'Obra'], filasK);
  // Services
  const filasS = servDe(v.id).slice(0,10).map(x=>[fFecha(x.fecha), TIPOS_SERV[x.tipo], fmt(x.km), x.taller||'', x.detalle||'', fmtPlata(x.costo)]);
  tabla('Services y reparaciones', ['Fecha','Tipo', u.horas?'Horas':'Km','Taller','Detalle','Costo'], filasS);
  // Pie en todas las páginas
  const n = doc.internal.getNumberOfPages();
  for(let i=1;i<=n;i++){ doc.setPage(i); doc.setFontSize(7); doc.setTextColor(120);
    doc.text(`Inventario de Obra LSG · ${v.patente} · página ${i} de ${n}`, W-14, H-6, {align:'right'}); }
  return doc;
}
async function compartirPDF(btn, soloUno){
  const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Armando PDF…';
  try{
    for(const src of LIBS_PDF) await cargarScript(src);
    const lista = soloUno ? [vehPor(F.sel)] : F.veh.filter(v=>v.activo!==false).sort((a,b)=>a.patente.localeCompare(b.patente));
    if(soloUno){ await compartirDoc(pdfFicha(lista[0]), `vehiculo-${lista[0].patente}-${hoy()}.pdf`, `Vehículo ${lista[0].patente}`); return; }
    const doc = new window.jspdf.jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
    const ancho = doc.internal.pageSize.getWidth();
    const COLOR = {rojo:[253,236,234], amarillo:[251,241,220], verde:[227,243,234], gris:[245,245,245]};
    doc.setFont('helvetica','bold'); doc.setFontSize(16);
    doc.text(soloUno ? `Estado del vehículo ${lista[0].patente}` : 'Estado de la flota', 14, 16);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(`${EMPRESA.razon} · ${fFecha(hoy())} · Generado por ${S.me||''}`, 14, 22);
    const est = {};
    const filas = lista.map(v=>{
      const vig = vencVigentes(v.id), ps = proxService(v), r = rendimiento(v, hoy().slice(0,7)), la = lecturaActual(v);
      const venc = t => { const x = vig[t]; if(!x) return {t: vencBasicos(v).includes(t)?'Sin cargar':'—', e: vencBasicos(v).includes(t)?'amarillo':'gris'};
        const d = diasHasta(x.vence); return {t: fFecha(x.vence) + (d<0?' (VENCIDO)':d<=30?` (${d} d)`:''), e: estadoDias(d)}; };
      const celdas = [
        {t: v.patente}, {t: [v.marca, v.modelo].filter(Boolean).join(' ')}, {t: `${v.chofer||'—'}\n${v.obra_id?nomUbic(v.obra_id):'Sin obra'}`},
        {t: `${fmtU(la.valor, v)}\n${la.dias<=0?'hoy':'hace '+la.dias+' d'}`, e: la.dias>DIAS_SIN_LECTURA?'amarillo':null},
        {t: `${fmtU(ps.km, v)}\n${ps.falta>0?'faltan '+fmtU(ps.falta, v):'PASADO'} · ${fFecha(ps.fecha)}`, e: ps.estado},
        venc('vtv'), venc('seguro'), venc('matafuegos'), venc('registro'),
        {t: r.valor!=null ? `${fmtRend(r.valor, v)}${r.ref?`\nref. ${fmt(r.ref)}`:''}` : '—', e: r.estado==='gris'?null:r.estado}
      ];
      est[v.patente] = celdas.map(c=>c.e||null);
      return celdas.map(c=>c.t);
    });
    doc.autoTable({
      startY: 27,
      head: [['Patente','Vehículo','Chofer / obra','Km / horas','Próximo service','VTV','Seguro','Matafuegos','Registro','Consumo del mes']],
      body: filas, theme:'grid',
      styles:{fontSize:8, cellPadding:2, valign:'middle'},
      headStyles:{fillColor:[60,60,60], textColor:255, fontStyle:'bold'},
      columnStyles:{0:{fontStyle:'bold', cellWidth:22}},
      didParseCell: data => { if(data.section!=='body') return;
        const e = est[filas[data.row.index][0]]?.[data.column.index]; if(e && COLOR[e]) data.cell.styles.fillColor = COLOR[e]; }
    });
    const al = lista.flatMap(alertasDe).sort((a,b)=>(a.nivel==='rojo'?0:1)-(b.nivel==='rojo'?0:1));
    let y = doc.lastAutoTable.finalY + 8;
    doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.text(al.length ? `Para atender (${al.length})` : 'Todo en orden: sin vencimientos ni services pendientes.', 14, y);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    for(const a of al){
      y += 5; if(y > doc.internal.pageSize.getHeight()-12){ doc.addPage(); y = 16; }
      doc.setTextColor(a.nivel==='rojo'?178:120, a.nivel==='rojo'?38:80, a.nivel==='rojo'?30:0);
      doc.text(`• ${a.v.patente}: ${a.txt}`, 16, y);
    }
    doc.setTextColor(0);
    doc.setFontSize(7); doc.text('Inventario de Obra LSG', ancho-14, doc.internal.pageSize.getHeight()-6, {align:'right'});
    await compartirDoc(doc, `estado-flota-${hoy()}.pdf`, 'Estado de la flota');
  }catch(e){
    alertaFlota(e.message);
  }finally{ btn.disabled = false; btn.textContent = txt; }
}
// En el celular abre el menú de compartir (WhatsApp, mail…); en la compu descarga el PDF
async function compartirDoc(doc, nombre, titulo){
  const archivo = new File([doc.output('blob')], nombre, {type:'application/pdf'});
  if(navigator.canShare?.({files:[archivo]})){
    try{ await navigator.share({files:[archivo], title: titulo}); }
    catch(e){ if(e.name!=='AbortError') doc.save(nombre); }
  } else doc.save(nombre);
}
function alertaFlota(msg){
  const el = $('#vFlota'); if(!el) return;
  el.insertAdjacentHTML('afterbegin', `<p class="error">${esc(msg)}</p>`);
}

/* ---------------- 6) Eventos ---------------- */
document.addEventListener('click', ev=>{
  const vista = ev.target.closest('[data-fvista]');
  if(vista){ F.vista = vista.dataset.fvista; fRender(); return; }
  const veh = ev.target.closest('[data-veh]');
  if(veh && !ev.target.closest('dialog')){ F.sel = veh.dataset.veh; F.vista='flota'; guardarSelVeh(); fRender(); if(innerWidth<880) $('#vFlota .det')?.scrollIntoView({behavior:'smooth',block:'start'}); return; }
  const ed = ev.target.closest('[data-fedit]');
  if(ed && !ev.target.closest('a')){ abrirForm(ed.dataset.fedit, ed.dataset.id); return; }
  const a = ev.target.closest('[data-fact]'); if(!a) return;
  switch(a.dataset.fact){
    case 'nuevoVeh': abrirForm('veh'); break;
    case 'editarVeh': abrirForm('veh', F.sel); break;
    case 'cargarFlota': abrirForm('cargarFlota'); break;
    case 'lecturas': abrirForm('lecturas'); break;
    case 'lectura': abrirForm('lectura'); break;
    case 'carga': abrirForm('carga'); break;
    case 'service': abrirForm('service'); break;
    case 'venc': abrirForm('venc', null, {tipo:a.dataset.tipo}); break;
    case 'doc': abrirForm('doc'); break;
    case 'borrarDoc': borrarDoc(a); break;
    case 'dist': abrirForm('dist', null, {obra:a.dataset.obra}); break;
    case 'tarjeta': abrirForm('tarjeta'); break;
    case 'filaTarj': filaTarj(); break;
    case 'filaFlota': filaFlota(); break;
    case 'quitarFila': { const cont = a.closest('.filas'); a.parentElement.remove();
      if(!cont.children.length) (cont.id==='filasTarj' ? filaTarj() : filaFlota()); break; }
    case 'guardar': guardarForm(a); break;
    case 'borrar': borrarForm(a); break;
    case 'pdfFlota': compartirPDF(a, false); break;
    case 'pdfVeh': compartirPDF(a, true); break;
  }
});
document.addEventListener('keydown', ev=>{ if(ev.key==='Enter' && ev.target.matches('tr[data-fedit]')) abrirForm(ev.target.dataset.fedit, ev.target.dataset.id); });
document.addEventListener('change', async ev=>{
  if(ev.target.id==='fMes'){ F.mes = ev.target.value || hoy().slice(0,7); fRender(); }
  if(ev.target.id==='fv_uni') etiquetasUnidad();
  if(ev.target.id==='fc_veh'){ const vv = vehPor(ev.target.value); $('#lc_odo').textContent = `${U(vv).lectura} (${U(vv).u})`; $('#fc_odo').placeholder = `Último: ${fmt(kmActual(vv))}`; $('#fc_obra').innerHTML = obrasOpts(vv?.obra_id); }
  if(ev.target.id==='flFoto'){
    for(const file of ev.target.files) F.fotos.push({file, url:URL.createObjectURL(file)});
    ev.target.value='';
    $('#flPrev').innerHTML = F.fotos.map(f=>`<span class="prev">${f.file.type==='application/pdf'?'<span class="pdf">PDF</span>':`<img src="${esc(f.url)}" alt="">`}</span>`).join('');
  }
  if(ev.target.matches('#filasTarj .t_veh')){
    ev.target.parentElement.querySelector('.t_obra').value = vehPor(ev.target.value)?.obra_id || '';
  }
  if(ev.target.matches('.dist-in')){
    const obra = ev.target.dataset.obra, v = ev.target.value;
    const {error} = v==='' ? await sb.from('distancias_obra').delete().eq('obra_id', obra)
                           : await sb.from('distancias_obra').upsert({obra_id:obra, km_ida:Number(v)});
    ev.target.classList.toggle('guardado', !error);
    if(!error) fCargar('distancias_obra');
  }
});
// app.js llama a esta función cuando ya sabe el rol del usuario
window.flotaRender = fRender;
