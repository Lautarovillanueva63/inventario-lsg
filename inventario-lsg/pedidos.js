/* =====================================================================
   Pedidos de materiales — LSG
   Ciclo de un pedido:
     1) PRESUPUESTO: se arma (materiales y herramientas) y queda guardado en la obra.
        Se puede descargar el PDF con el formato de la planilla (Anexo III · PG-850.01).
     2) EN ESPERA: se confirmó con el proveedor; ya no se edita.
     3) RECIBIDO (o PARCIAL): llegó a la obra. Se sube la factura y el remito y lo que
        llegó se carga solo en el stock de esa obra (un "ingreso de proveedor").
   Usa cosas de app.js (sb, S, $, esc, fmt, hoy, fFecha, nomUbic, subirArchivos, cargar…)
   y de flota.js (cargarScript, LIBS_PDF, compartirDoc).
   ===================================================================== */
const PED_ESTADOS = {
  presupuesto: {txt:'Presupuesto',      chip:'c-compra'},
  en_espera:   {txt:'En espera',        chip:'c-pend'},
  parcial:     {txt:'Recibido parcial', chip:'c-prov'},
  recibido:    {txt:'Recibido',         chip:'c-ok'},
  anulado:     {txt:'Anulado',          chip:'c-sale'}
};
const ACTIVOS = ['presupuesto','en_espera','parcial'];
const PDOC = {anexo:'ANEXO III', codigo:'PG-850.01', version:'VERSIÓN: 1', filas:20};   // datos fijos de la planilla
const P = {estado:'activos', obra:'', q:'', id:null, modo:'ver', archivos:[], msg:''};
const pedPor = id => S.peds.find(p=>p.id===id);
const numPed = p => String(p.numero).padStart(2,'0');
const pedEditable = p => S.admin && (!p || p.estado==='presupuesto');
const recibidos = p => (p.items||[]).filter(i=>i.recibido).length;
const chipPed = p => `<span class="chip ${PED_ESTADOS[p.estado].chip}">${PED_ESTADOS[p.estado].txt}</span>`;
const resumenPed = (p, max=3) => { const t = (p.items||[]).map(i=>`${fmt(i.cantidad)} ${i.unidad==='un'?'':i.unidad+' '}${i.descripcion}`);
  return t.length>max ? t.slice(0,max).join(' · ') + ` y ${t.length-max} más` : t.join(' · '); };
const obrasActivas = () => S.ubic.filter(u=>u.tipo==='obra' && u.activa!==false).sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));

/* ---------------- Listados ---------------- */
function filaPed(p, conObra){
  const n = (p.items||[]).length, r = recibidos(p);
  return `<tr class="click" data-ped="${esc(p.id)}" tabindex="0"><td class="mono">${numPed(p)}</td>${conObra?`<td>${esc(nomUbic(p.obra_id))}</td>`:''}
    <td>${fFecha(p.fecha)}</td><td>${chipPed(p)}</td><td class="muted">${esc(resumenPed(p))}</td>
    <td class="num">${p.estado==='parcial'||p.estado==='recibido'?`${r}/${n}`:n}</td></tr>`;
}
function tablaPeds(lista, conObra){
  return `<div class="tabla-wrap"><table><thead><tr><th>N°</th>${conObra?'<th>Obra</th>':''}<th>Fecha</th><th>Estado</th><th>Detalle</th><th class="num">Ítems</th></tr></thead>
    <tbody>${lista.map(p=>filaPed(p, conObra)).join('')}</tbody></table></div>`;
}
window.pedidosRender = function(){
  const el = $('#vPed'); if(!el) return;
  if(S.faltaPedidos){ el.innerHTML = `<div class="vacio"><strong>Falta actualizar la base de datos</strong>En Supabase → SQL Editor, corré el <span class="mono">supabase.sql</span> nuevo y recargá la página.</div>`; return; }
  if(!S.loaded.pedidos){ el.innerHTML = '<div class="vacio">Cargando pedidos…</div>'; return; }
  const q = norm(P.q);
  const lista = S.peds.filter(p=>(P.estado==='todos' || (P.estado==='activos' ? ACTIVOS.includes(p.estado) : p.estado===P.estado))
    && (!P.obra || p.obra_id===P.obra)
    && (!q || norm(`${numPed(p)} ${nomUbic(p.obra_id)} ${(p.items||[]).map(i=>`${i.descripcion} ${i.proveedor||''} ${i.numero_remito||''}`).join(' ')} ${p.nota}`).includes(q)));
  const cuenta = e => S.peds.filter(p=>p.estado===e).length;
  el.innerHTML = `
    <div class="mov-head"><h2>Pedidos de materiales</h2>
      <div class="filtros">
        <select id="pedEstado" aria-label="Filtrar por estado">
          <option value="activos">Pendientes (${ACTIVOS.reduce((t,e)=>t+cuenta(e),0)})</option>
          ${Object.entries(PED_ESTADOS).map(([k,v])=>`<option value="${k}">${v.txt} (${cuenta(k)})</option>`).join('')}
          <option value="todos">Todos (${S.peds.length})</option></select>
        <select id="pedObra" aria-label="Filtrar por obra"><option value="">Todas las obras</option>
          ${[...new Set(S.peds.map(p=>p.obra_id))].map(id=>`<option value="${esc(id)}">${esc(nomUbic(id))}</option>`).join('')}</select>
        <input id="pedBusca" type="search" placeholder="Buscar material, proveedor, remito…" aria-label="Buscar pedidos">
        ${S.admin?'<button class="btn primary sm" data-pact="nuevo">+ Nuevo pedido</button>':''}
      </div></div>
    ${lista.length ? tablaPeds(lista, true) : `<div class="vacio"><strong>${S.peds.length?'Sin pedidos con ese filtro':'Todavía no hay pedidos'}</strong>${S.peds.length?'Probá con "Todos".':(S.admin?'Creá uno con "+ Nuevo pedido" o desde una obra.':'')}</div>`}`;
  $('#pedEstado').value = P.estado; $('#pedObra').value = P.obra; $('#pedBusca').value = P.q;
};
// Sección "Pedidos" dentro de cada obra
window.pedidosDeObra = function(obraId){
  if(S.faltaPedidos || !S.loaded.pedidos) return '';
  const u = ubicPor(obraId); if(!u || u.tipo!=='obra') return '';
  const lista = S.peds.filter(p=>p.obra_id===obraId);
  return `<div class="seccion"><div class="sec-head"><h3>Pedidos de materiales (${lista.length})</h3>
      ${S.admin && u.activa!==false ? '<button class="btn ghost sm" data-act="nuevoPedido">+ Pedido</button>' : ''}</div>
    ${lista.length ? tablaPeds(lista.slice(0,15), false) : '<div class="vacio chico">Sin pedidos para esta obra.</div>'}</div>`;
};

/* ---------------- Ventana del pedido ---------------- */
const dlgP = $('#dlgPed');
const filaItem = (i={clase:'material', unidad:'un'}) => `<div class="pi">
  <select class="pi-clase" aria-label="Tipo"><option value="material" ${i.clase!=='herramienta'?'selected':''}>Material</option><option value="herramienta" ${i.clase==='herramienta'?'selected':''}>Herramienta</option></select>
  <input class="pi-cant" type="number" min="0" step="any" inputmode="decimal" placeholder="Cant." value="${i.cantidad??''}" aria-label="Cantidad">
  <select class="pi-uni" aria-label="Unidad" ${i.clase==='herramienta'?'disabled':''}>${UNIDADES.map(u=>`<option ${u===(i.unidad||'un')?'selected':''}>${u}</option>`).join('')}</select>
  <input class="pi-desc" list="${i.clase==='herramienta'?'dlHerr':'dlMat'}" placeholder="Descripción (ej. Bolsa de cemento 25kg - Loma Negra)" value="${esc(i.descripcion||'')}" aria-label="Descripción" autocomplete="off">
  <input class="pi-obs" placeholder="Observaciones" value="${esc(i.observaciones||'')}" aria-label="Observaciones" autocomplete="off">
  <button type="button" class="x" data-pact="quitarItem" aria-label="Quitar">×</button></div>`;

window.abrirPedido = function(id, obraId){
  P.id = id; P.modo = 'ver'; P.archivos = []; P.msg = '';
  pintarPedido(obraId);
  if(!dlgP.open) dlgP.showModal();
};
function pintarPedido(obraNueva){
  const p = P.id ? pedPor(P.id) : null;
  if(P.id && !p){ dlgP.close(); return; }
  const editable = pedEditable(p);
  const obraId = p?.obra_id || obraNueva || S.sel;
  $('#pTitulo').textContent = p ? `Pedido N° ${numPed(p)} · ${nomUbic(p.obra_id)}` : 'Nuevo pedido de materiales';
  if(P.modo==='recibir') return pintarRecepcion(p);
  const msg = P.msg ? `<p class="ok">${P.msg}</p>` : '';
  if(editable){
    const obras = obrasActivas();
    $('#pBody').innerHTML = `${msg}
      <div class="grid2">
        <label><span>Obra</span>${p ? `<input value="${esc(nomUbic(p.obra_id))}" disabled>`
          : `<select id="pObra">${obras.map(u=>`<option value="${esc(u.id)}" ${u.id===obraId?'selected':''}>${esc(u.nombre)}</option>`).join('')}</select>`}</label>
        <label><span>Fecha de emisión</span><input type="date" id="pFecha" value="${esc(p?.fecha || hoy())}"></label>
      </div>
      <div class="bloque"><div class="items-head"><span class="lbl">Ítems del pedido</span><button type="button" class="btn ghost sm" data-pact="filaItem">+ Ítem</button></div>
        <div class="pi-cab"><span>Tipo</span><span>Cant.</span><span>Unidad</span><span>Descripción</span><span>Observaciones</span><span></span></div>
        <div id="pItems" class="filas">${(p?.items?.length ? p.items : [{clase:'material', unidad:'un'}]).map(filaItem).join('')}</div>
        <p class="ayuda chica">Elegí <strong>Material</strong> para lo que se cuenta por cantidad (bolsas, kg, barras) y <strong>Herramienta</strong> para lo que lleva código propio. Cuando llegue el pedido, todo se carga solo en esta obra.</p></div>
      <label><span>Nota interna (no sale en el PDF)</span><textarea id="pNota" rows="2">${esc(p?.nota||'')}</textarea></label>
      <p id="pError" class="error" hidden></p>`;
    $('#pFoot').innerHTML = `${p?'<button type="button" class="btn danger" data-pact="borrar" style="margin-right:auto">Eliminar</button>':''}
      <button type="button" class="btn" data-pact="pdf">Descargar PDF</button>
      <button type="button" class="btn" data-pact="guardar">Guardar presupuesto</button>
      <button type="button" class="btn primary" data-pact="confirmar">Confirmar pedido</button>`;
    if(!obras.length && !p) $('#pBody').insertAdjacentHTML('afterbegin', '<p class="aviso">No hay obras activas. Creá una obra primero.</p>');
    return;
  }
  // Solo lectura (en espera, recibido, anulado, o lector)
  const items = p.items||[], conEntrega = items.some(i=>i.recibido);
  firmar(p.fotos||[]);
  $('#pBody').innerHTML = `${msg}
    <div class="r-top">${chipPed(p)}<span class="muted">Emitido el ${fFecha(p.fecha)}${p.confirmado_en?` · confirmado el ${fFecha(p.confirmado_en)}`:''}</span></div>
    <div class="tabla-wrap"><table><thead><tr><th>Ítem</th><th class="num">Cant.</th><th>Unidad</th><th>Descripción</th><th>Observaciones</th>${conEntrega?'<th>Proveedor</th><th>N° remito</th><th>Entrega</th>':''}<th>Estado</th></tr></thead><tbody>
      ${items.map((i,k)=>`<tr><td>${k+1}</td><td class="num">${fmt(i.cantidad)}</td><td>${esc(i.unidad)}</td><td>${esc(i.descripcion)}${i.clase==='herramienta'?' <span class="chip c-alta">Herramienta</span>':''}</td>
        <td class="muted">${esc(i.observaciones||'')}</td>${conEntrega?`<td>${esc(i.proveedor||'')}</td><td class="mono">${esc(i.numero_remito||'')}</td><td>${fFecha(i.fecha_entrega)}</td>`:''}
        <td>${i.recibido?'<span class="chip c-ok">Llegó</span>':p.estado==='anulado'?'—':'<span class="chip c-pend">Pendiente</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    ${p.nota?`<p style="margin:0"><span class="lbl">Nota</span>${esc(p.nota)}</p>`:''}
    ${(p.fotos||[]).length?`<div class="ver-fotos"><span class="lbl">Facturas y remitos recibidos</span>${p.fotos.map(f=>{ const u=S.urls[f];
        if(!u) return '<span class="muted">Cargando…</span>';
        return esPdf(f) ? `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">Abrir PDF</a>` : `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Factura o remito"></a>`; }).join('')}</div>`:''}
    ${(p.movimientos||[]).length?`<p class="muted" style="margin:0">Se cargó en el stock de la obra con ${p.movimientos.length===1?'1 ingreso de proveedor':p.movimientos.length+' ingresos de proveedor'}: ${p.movimientos.map(id=>`<button class="link" data-mov="${esc(id)}">ver</button>`).join(' · ')}</p>`:''}`;
  const b = [];
  if(S.admin && p.estado==='en_espera') b.push('<button type="button" class="btn danger" data-pact="anular" style="margin-right:auto">Anular</button>', '<button type="button" class="btn" data-pact="volver">Volver a presupuesto</button>');
  if(S.admin && p.estado==='anulado') b.push('<button type="button" class="btn danger" data-pact="borrar" style="margin-right:auto">Eliminar</button>');
  b.push('<button type="button" class="btn" data-pact="pdf">Descargar PDF</button>');
  if(S.admin && (p.estado==='en_espera' || p.estado==='parcial')) b.push('<button type="button" class="btn primary" data-pact="recibir">Registrar recepción</button>');
  else b.push('<button type="button" class="btn primary" data-close>Cerrar</button>');
  $('#pFoot').innerHTML = b.join('');
}
function errPed(m){ const e=$('#pError'); if(!e) return alert(m); e.textContent=m; e.hidden=false; e.scrollIntoView({block:'nearest'}); }

// Lee el formulario y valida
function leerItems(){
  const items = [];
  for(const [n, f] of $$('#pItems .pi').entries()){
    const clase = f.querySelector('.pi-clase').value, descripcion = f.querySelector('.pi-desc').value.trim();
    const cantTxt = f.querySelector('.pi-cant').value, cantidad = Number(cantTxt), observaciones = f.querySelector('.pi-obs').value.trim();
    if(!descripcion && !cantTxt && !observaciones) continue;
    if(!descripcion) throw new Error(`Ítem ${n+1}: falta la descripción.`);
    if(!(cantidad>0)) throw new Error(`"${descripcion}": poné una cantidad mayor a cero.`);
    if(clase==='herramienta' && (!Number.isInteger(cantidad) || cantidad>200)) throw new Error(`"${descripcion}": las herramientas van por unidad (número entero, máximo 200).`);
    items.push({clase, descripcion, cantidad, unidad: clase==='herramienta' ? 'un' : f.querySelector('.pi-uni').value, observaciones});
  }
  if(!items.length) throw new Error('Agregá al menos un ítem.');
  return items;
}
async function guardarPedido(btn, confirmar){
  btn.disabled = true;
  try{
    const items = leerItems(), fecha = $('#pFecha').value || hoy(), nota = $('#pNota').value.trim();
    let p = P.id ? pedPor(P.id) : null, res;
    if(p) res = await sb.from('pedidos').update({items, fecha, nota}).eq('id', p.id).select().single();
    else {
      const obra_id = $('#pObra')?.value; if(!obra_id) throw new Error('Elegí la obra.');
      res = await sb.from('pedidos').insert({obra_id, items, fecha, nota, creado_por:S.me}).select().single();
    }
    if(res.error) throw new Error(/policy|permission/i.test(res.error.message) ? 'No tenés permiso para guardar pedidos.' : 'No se pudo guardar. Revisá la conexión.');
    P.id = res.data.id;
    if(confirmar){
      const r2 = await sb.from('pedidos').update({estado:'en_espera', confirmado_en:new Date().toISOString()}).eq('id', P.id).select().single();
      if(r2.error) throw new Error('Se guardó, pero no se pudo confirmar. Probá de nuevo.');
      res = r2;
    }
    upsertLocal(res.data);
    P.msg = confirmar ? `Pedido N° ${numPed(res.data)} confirmado: queda <strong>en espera</strong> hasta que llegue. Cuando llegue, tocá "Registrar recepción".`
                      : `Presupuesto N° ${numPed(res.data)} guardado en ${esc(nomUbic(res.data.obra_id))}.`;
    pintarPedido();
  }catch(e){ btn.disabled = false; errPed(e.message); }
}
function upsertLocal(p){ const i = S.peds.findIndex(x=>x.id===p.id); i>=0 ? S.peds[i]=p : S.peds.unshift(p); render(); window.pedidosRender(); }
async function cambiarEstado(estado, btn){
  const extra = estado==='presupuesto' ? {confirmado_en:null} : {};
  if(estado==='anulado' && btn.dataset.ok!=='1'){ btn.dataset.ok='1'; btn.textContent='¿Anular el pedido?'; return; }
  btn.disabled = true;
  const {data, error} = await sb.from('pedidos').update({estado, ...extra}).eq('id', P.id).select().single();
  if(error){ btn.disabled=false; return alert('No se pudo cambiar el estado. Probá de nuevo.'); }
  P.msg = estado==='anulado' ? 'Pedido anulado.' : 'Volvió a presupuesto: ya lo podés editar.';
  upsertLocal(data); pintarPedido();
}
async function borrarPedido(btn){
  if(btn.dataset.ok!=='1'){ btn.dataset.ok='1'; btn.textContent='¿Seguro? Tocá de nuevo'; return; }
  btn.disabled = true;
  const {error} = await sb.from('pedidos').delete().eq('id', P.id);
  if(error){ btn.disabled=false; return alert('No se pudo eliminar.'); }
  S.peds = S.peds.filter(x=>x.id!==P.id); dlgP.close(); render(); window.pedidosRender();
}

/* ---------------- Recepción: llegó el pedido a la obra ---------------- */
function pintarRecepcion(p){
  const pend = (p.items||[]).map((i,k)=>({...i, k})).filter(i=>!i.recibido);
  $('#pBody').innerHTML = `
    <p class="ayuda">Tildá lo que llegó y completá proveedor y N° de remito. Lo tildado se carga en el stock de <strong>${esc(nomUbic(p.obra_id))}</strong>. Lo que no tildes queda pendiente para otra entrega.</p>
    <div class="todos-rec grid3">
      <label><span>Proveedor (para todos)</span><input id="rProv" list="dlProv" autocomplete="off"></label>
      <label><span>N° de remito (para todos)</span><input id="rRem" autocomplete="off"></label>
      <label><span>Fecha de entrega</span><input type="date" id="rFecha" value="${hoy()}"></label>
    </div>
    <div class="tabla-wrap"><table class="rec"><thead><tr><th><input type="checkbox" id="rTodos" checked aria-label="Tildar todos"></th><th>Ítem</th><th>Proveedor</th><th>N° remito</th></tr></thead><tbody>
      ${pend.map(i=>`<tr><td><input type="checkbox" class="r-ok" data-k="${i.k}" checked aria-label="Llegó ${esc(i.descripcion)}"></td>
        <td><strong>${fmt(i.cantidad)} ${esc(i.unidad==='un'?'':i.unidad)}</strong> ${esc(i.descripcion)}</td>
        <td><input class="r-prov" data-k="${i.k}" list="dlProv" autocomplete="off" placeholder="Igual que arriba" aria-label="Proveedor"></td>
        <td><input class="r-rem" data-k="${i.k}" autocomplete="off" placeholder="Igual que arriba" aria-label="N° de remito"></td></tr>`).join('')}
    </tbody></table></div>
    <div class="foto-box"><span class="lbl">Factura y remito recibidos (fotos o PDF)</span>
      <div id="rPrev" class="previews"></div>
      <button type="button" class="btn sm" data-pact="archivos">Agregar factura / remito</button></div>
    <p id="pError" class="error" hidden></p>`;
  pintarArchivos();
  $('#pFoot').innerHTML = `<button type="button" class="btn" data-pact="cancelarRec">Cancelar</button>
    <button type="button" class="btn primary" data-pact="confirmarRec">Registrar recepción</button>`;
}
function pintarArchivos(){
  const el = $('#rPrev'); if(!el) return;
  el.innerHTML = P.archivos.map((f,n)=>`<span class="prev">${f.file.type==='application/pdf'?'<span class="pdf">PDF</span>':`<img src="${esc(f.url)}" alt="">`}
    <button type="button" data-pact="quitarArchivo" data-n="${n}" aria-label="Quitar">×</button></span>`).join('');
}
async function confirmarRecepcion(btn){
  const p = pedPor(P.id); if(!p) return;
  const fecha = $('#rFecha').value || hoy(), provTodos = $('#rProv').value.trim(), remTodos = $('#rRem').value.trim();
  const items = $$('.r-ok').filter(c=>c.checked).map(c=>{ const k = c.dataset.k;
    return {i:Number(k), proveedor: (document.querySelector(`.r-prov[data-k="${k}"]`).value.trim() || provTodos),
            numero_remito: (document.querySelector(`.r-rem[data-k="${k}"]`).value.trim() || remTodos), fecha_entrega: fecha}; });
  if(!items.length) return errPed('Tildá al menos un ítem que haya llegado.');
  const sinProv = items.find(i=>!i.proveedor);
  if(sinProv) return errPed(`Falta el proveedor de "${p.items[sinProv.i].descripcion}". Completalo en la fila o en "Proveedor (para todos)".`);
  if(!P.archivos.length) return errPed('Subí la foto de la factura y del remito del proveedor antes de registrar la recepción.');
  btn.disabled = true;
  try{
    const fotos = await subirArchivos(P.archivos.map(f=>f.file), (i,n)=>btn.textContent=`Subiendo ${i} de ${n}…`);
    btn.textContent = 'Cargando en la obra…';
    const {data, error} = await sb.rpc('recibir_pedido', {p:{id:p.id, fecha, fotos, items}});
    if(error) throw new Error(error.message);
    P.archivos.forEach(f=>URL.revokeObjectURL(f.url)); P.archivos = [];
    upsertLocal(data);
    await Promise.all(['herramientas','materiales','stock_materiales','movimientos'].map(cargar));
    P.modo = 'ver';
    P.msg = `Recepción registrada: ${items.length} ${items.length===1?'ítem cargado':'ítems cargados'} en ${esc(nomUbic(p.obra_id))}.${data.estado==='parcial'?' Quedan ítems pendientes.':''}`;
    pintarPedido();
  }catch(e){ btn.disabled = false; btn.textContent = 'Registrar recepción'; errPed(e.message || 'No se pudo registrar. Probá de nuevo.'); }
}

/* ---------------- PDF con el formato de la planilla ---------------- */
let logoPDF = null;
async function cargarLogo(){
  if(logoPDF) return logoPDF;
  try{
    const blob = await (await fetch('logo.png')).blob();
    const url = await new Promise(ok=>{ const r = new FileReader(); r.onload = ()=>ok(r.result); r.readAsDataURL(blob); });
    const img = await new Promise((ok, mal)=>{ const i = new Image(); i.onload = ()=>ok(i); i.onerror = mal; i.src = url; });
    // Se achica a lo que se imprime (≈44 mm) y se pasa a JPG sobre blanco: el PDF queda liviano para WhatsApp
    const w = 420, h = Math.round(w * img.naturalHeight / img.naturalWidth), c = document.createElement('canvas');
    c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
    logoPDF = {url:c.toDataURL('image/jpeg', 0.9), w, h};
  }catch(e){ logoPDF = {url:null}; }
  return logoPDF;
}
const uniPDF = u => ({un:'UNID.', kg:'Kg', l:'L'}[u] || u);
async function pdfPedido(p){
  for(const src of LIBS_PDF) await cargarScript(src);
  const logo = await cargarLogo();
  const doc = new window.jspdf.jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12, R = W - M;
  const obra = nomUbic(p.obra_id).toUpperCase();
  doc.setDrawColor(90); doc.setLineWidth(0.25);
  // Encabezado: logo | título | anexo / código / versión
  const y0 = 10, hTop = 20, xT = M + 52, xA = R - 48;
  doc.rect(M, y0, R - M, hTop); doc.line(xT, y0, xT, y0 + hTop); doc.line(xA, y0, xA, y0 + hTop);
  doc.line(xA, y0 + 7, R, y0 + 7); doc.line(xA, y0 + 14, R, y0 + 14);
  if(logo.url){   // el logo entra en una caja de 44 × 15 mm sin deformarse
    const k = Math.min(44 / logo.w, 15 / logo.h), wL = logo.w * k, hL = logo.h * k;
    doc.addImage(logo.url, 'JPEG', M + (52 - wL)/2, y0 + (hTop - hL)/2, wL, hL);
  }
  else { doc.setFont('helvetica','bold'); doc.setFontSize(22); doc.setTextColor(183,5,5); doc.text('LSG', M + 26, y0 + 13, {align:'center'}); doc.setTextColor(0); }
  doc.setFont('helvetica','bolditalic'); let fs = 15; doc.setFontSize(fs);
  const titulo = `PEDIDO DE MATERIALES – OBRA ${obra}`;
  while(doc.getTextWidth(titulo) > (xA - xT - 8) && fs > 9){ fs -= 0.5; doc.setFontSize(fs); }
  doc.text(titulo, (xT + xA)/2, y0 + hTop/2 + 2, {align:'center'});
  doc.setFont('helvetica','bold'); doc.setFontSize(9);
  doc.text(PDOC.anexo, (xA + R)/2, y0 + 4.8, {align:'center'}); doc.text(PDOC.codigo, (xA + R)/2, y0 + 11.8, {align:'center'});
  doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.text(PDOC.version, (xA + R)/2, y0 + 18.2, {align:'center'});
  // Pedido N° y fecha
  const y1 = 35, h1 = 7;
  doc.setFillColor(217,217,217); doc.rect(M, y1, 52, h1, 'FD'); doc.rect(M + 52, y1, 52, h1);
  doc.rect(R - 85, y1, 26, h1, 'FD'); doc.rect(R - 59, y1, 59, h1);
  doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
  doc.text('PEDIDO DE MATERIALES N°', M + 26, y1 + 4.7, {align:'center'}); doc.text('FECHA', R - 72, y1 + 4.7, {align:'center'});
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
  doc.text(numPed(p), M + 78, y1 + 4.8, {align:'center'}); doc.text(fFecha(p.fecha), R - 29.5, y1 + 4.8, {align:'center'});
  // Tabla de ítems (con renglones vacíos hasta completar la planilla)
  const items = p.items||[];
  const body = items.map((i,k)=>[k+1, fFecha(p.fecha), fmt(i.cantidad), uniPDF(i.unidad), i.descripcion, i.observaciones||'',
    i.proveedor||'', i.fecha_entrega?fFecha(i.fecha_entrega):'', i.numero_remito||'']);
  while(body.length < PDOC.filas) body.push(['','','','','','','','','']);
  doc.autoTable({
    startY: y1 + h1 + 4, margin:{left:M, right:M},
    head:[['ITEM','FECHA DE\nPEDIDO','CANT.','UNIDAD','DESCRIPCION','OBSERVACIONES','PROVEEDOR','FECHA DE\nENTREGA','N° REMITO']],
    body, theme:'grid',
    styles:{font:'helvetica', fontSize:8, cellPadding:{top:0.9, bottom:0.9, left:1.2, right:1.2}, halign:'center', valign:'middle', lineColor:[110,110,110], lineWidth:0.15, textColor:20, minCellHeight:6.2},
    headStyles:{fillColor:[217,217,217], textColor:0, fontStyle:'bold', fontSize:7.5},
    columnStyles:{0:{cellWidth:16},1:{cellWidth:24},2:{cellWidth:17},3:{cellWidth:16},4:{cellWidth:'auto'},5:{cellWidth:33},6:{cellWidth:40},7:{cellWidth:20},8:{cellWidth:23}},
  });
  // Pie en todas las páginas (igual que la planilla)
  const n = doc.internal.getNumberOfPages(), t1 = 'Prohibido reproducir o ceder a terceros sin autorización de ';
  for(let i=1;i<=n;i++){
    doc.setPage(i); doc.setDrawColor(90); doc.line(M, H - 11, R, H - 11);
    doc.setFontSize(7); doc.setTextColor(60); doc.setFont('helvetica','normal'); doc.text(t1, M, H - 7);
    doc.setFont('helvetica','bold'); doc.text(EMPRESA.razon, M + doc.getTextWidth(t1), H - 7);
    doc.setFont('helvetica','normal'); doc.text(`Pág. ${i}/${n}`, R, H - 7, {align:'right'}); doc.setTextColor(0);
  }
  return doc;
}
async function descargarPDF(btn){
  const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Armando PDF…';
  try{
    let p = P.id ? pedPor(P.id) : null;
    // Si se está editando, el PDF sale con lo que está en pantalla (aunque no se haya guardado)
    if(pedEditable(p) && $('#pItems')){
      const items = leerItems();
      p = {...(p||{numero: S.peds.filter(x=>x.obra_id===$('#pObra')?.value).reduce((m,x)=>Math.max(m,x.numero),0)+1, obra_id: $('#pObra')?.value}),
           items, fecha: $('#pFecha').value || hoy()};
    }
    const doc = await pdfPedido(p);
    // Nombre de archivo sin acentos ni espacios (algunos navegadores los rechazan y lo bajan como "download")
    const obraArchivo = nomUbic(p.obra_id).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9-]+/g,'_').replace(/^_|_$/g,'');
    await compartirDoc(doc, `Pedido-${numPed(p)}-${obraArchivo}.pdf`, `Pedido de materiales N° ${numPed(p)}`);
  }catch(e){ errPed(e.message || 'No se pudo armar el PDF.'); }
  finally{ btn.disabled = false; btn.textContent = txt; }
}

/* ---------------- Eventos ---------------- */
document.addEventListener('click', ev=>{
  const fila = ev.target.closest('[data-ped]');
  if(fila){ window.abrirPedido(fila.dataset.ped); return; }
  const a = ev.target.closest('[data-pact]'); if(!a) return;
  switch(a.dataset.pact){
    case 'nuevo': window.abrirPedido(null, P.obra || obrasActivas()[0]?.id); break;
    case 'filaItem': $('#pItems').insertAdjacentHTML('beforeend', filaItem()); $('#pItems .pi:last-child .pi-cant').focus(); break;
    case 'quitarItem': { const cont = $('#pItems'); a.parentElement.remove(); if(!cont.children.length) cont.innerHTML = filaItem(); break; }
    case 'guardar': guardarPedido(a, false); break;
    case 'confirmar': guardarPedido(a, true); break;
    case 'pdf': descargarPDF(a); break;
    case 'volver': cambiarEstado('presupuesto', a); break;
    case 'anular': cambiarEstado('anulado', a); break;
    case 'borrar': borrarPedido(a); break;
    case 'recibir': P.modo = 'recibir'; P.msg = ''; pintarPedido(); break;
    case 'cancelarRec': P.modo = 'ver'; P.archivos.forEach(f=>URL.revokeObjectURL(f.url)); P.archivos = []; pintarPedido(); break;
    case 'confirmarRec': confirmarRecepcion(a); break;
    case 'archivos': $('#pArchivos').value=''; $('#pArchivos').click(); break;
    case 'quitarArchivo': { const n = Number(a.dataset.n); URL.revokeObjectURL(P.archivos[n].url); P.archivos.splice(n,1); pintarArchivos(); break; }
  }
});
document.addEventListener('keydown', ev=>{ if(ev.key==='Enter' && ev.target.matches('tr[data-ped]')) window.abrirPedido(ev.target.dataset.ped); });
document.addEventListener('change', ev=>{
  const t = ev.target;
  if(t.id==='pedEstado'){ P.estado = t.value; window.pedidosRender(); }
  if(t.id==='pedObra'){ P.obra = t.value; window.pedidosRender(); }
  if(t.classList.contains('pi-clase')){   // herramienta = por unidad; material = elegís la unidad
    const f = t.closest('.pi'), u = f.querySelector('.pi-uni'), d = f.querySelector('.pi-desc');
    u.disabled = t.value==='herramienta'; if(u.disabled) u.value = 'un';
    d.setAttribute('list', t.value==='herramienta' ? 'dlHerr' : 'dlMat');
  }
  if(t.id==='rTodos') $$('.r-ok').forEach(c=>c.checked = t.checked);
  if(t.id==='pArchivos'){ for(const file of t.files) P.archivos.push({file, url:URL.createObjectURL(file)}); t.value=''; pintarArchivos(); }
});
document.addEventListener('input', ev=>{
  if(ev.target.id==='pedBusca'){ P.q = ev.target.value; const pos = ev.target.selectionStart; window.pedidosRender(); const b = $('#pedBusca'); b.focus(); b.setSelectionRange(pos, pos); }
});
