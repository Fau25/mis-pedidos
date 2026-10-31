'use strict';
const VERSION = 'v18';
const $ = s => document.querySelector(s);
const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};
let cfg = LS.get('mp-cfg', { url:'', clave:'' });
let datos = LS.get('mp-datos', { pedidos: [] });
let cargando = !!(cfg.url && !datos.t && !(datos.pedidos||[]).length);
let tab = 'camino', abierto = null, ocupado = false, transA = null, transDestino = null;

/* ---------- Estados ---------- */
const EST = {
  pending:{t:'Pendiente', c:'--st-pend', i:'i-reloj', p:0},
  info_received:{t:'Preparando', c:'--st-pend', i:'i-caja', p:1},
  in_transit:{t:'En tránsito', c:'--st-tran', i:'i-camion', p:2},
  out_for_delivery:{t:'En reparto', c:'--st-rep', i:'i-camion', p:3},
  failed_attempt:{t:'Intento fallido', c:'--st-err', i:'i-alerta', p:3},
  available_for_pickup:{t:'Para recoger', c:'--st-rec', i:'i-tienda', p:3},
  delivered:{t:'Entregado', c:'--st-ok', i:'i-ok', p:4},
  exception:{t:'Incidencia', c:'--st-err', i:'i-alerta', p:2}
};
const est = e => EST[e] || EST.pending;
const ERRORES = {
  clave:'Contraseña incorrecta.', bloqueado:'Demasiados intentos. Espera 10 minutos.',
  'sin-clave':'Falta la contraseña en el script: escríbela en la línea 9 (MI_CLAVE) y haz una implementación nueva.',
  'sin-ship24':'Falta la clave de Ship24 en el script: escríbela en la línea 10 (MI_SHIP24) y haz una implementación nueva.',
  courier:'Elige un transportista.', 'no-existe':'Ese pedido ya no existe.',
  'ship24-clave':'Ship24 no acepta la clave. Revísala en el script.',
  'ship24-cupo':'Se han acabado los envíos gratis de este mes en Ship24.',
  'ship24-espera':'Ship24 pide esperar un momento. Prueba en un minuto.',
  ship24:'Ship24 no ha podido buscar ese número.', numero:'Ese número no parece válido.',
  repetido:'Ese pedido ya está en la lista.', red:'Sin conexión a internet.', 'no-url':'Pon la dirección del script en Ajustes.',
  'no-responde':'El script no responde. Si sigue así, revisa en Ajustes que la dirección acabe en /exec y que el script esté implementado con acceso «Cualquier usuario».',
  'no-script':'Esa dirección no es la de tu script. Cópiala de Implementar › Gestionar implementaciones (acaba en /exec).',
  'url-mala':'La dirección debe empezar por https://script.google.com/macros/s/ y acabar en /exec.',
  lectura:'El script no ha podido leer tus pedidos en Drive. No se ha borrado nada; prueba en unos minutos.',
  servidor:'El script ha tenido un error. Prueba otra vez en un momento.'
};

/* ---------- Conexión ---------- */
async function api(accion, extra){
  if (!cfg.url) throw { error:'no-url' };
  let r, res;
  if (accion !== 'leer' && accion !== 'actualizar' && accion !== 'couriers') ultimaAccion = Date.now();
  try{
    res = await fetch(cfg.url, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify(Object.assign({ accion, clave: cfg.clave }, extra || {})) });
  }catch(e){
    // Sin red de verdad, o el script no deja entrar (dirección mal copiada o sin acceso «Cualquier usuario»)
    throw { error: navigator.onLine === false ? 'red' : 'no-responde' };
  }
  try{ r = await res.json(); }catch(e){ throw { error:'no-script' }; }
  if (!r || typeof r.ok !== 'boolean') throw { error:'no-script' };
  if (cargando) { cargando = false; if (!r.datos) pintar(); }
  if (r.datos) ponerDatos(r.datos);
  if (!r.ok) throw r;
  return r;
}
let ultimoJSON = JSON.stringify(datos), ultimaAccion = 0;
function ponerDatos(d){
  // Respuesta que salió antes que una acción tuya y llega después: no pisar los datos más nuevos.
  // Solo durante 15 s tras una acción, para que unos datos restaurados en el script no se ignoren para siempre.
  if (d.t && datos.t && d.t < datos.t && Date.now() - ultimaAccion < 15000) return;
  const j = JSON.stringify(d);
  if (j === ultimoJSON) { pintarCabecera(); return; }   // nada nuevo: no repintar (evita toques perdidos)
  ultimoJSON = j; datos = d; LS.set('mp-datos', d); pintar(); if (abierto) pintarFicha(); pintarAvisos();
}
function pintarCabecera(){
  $('#revTxt').textContent = datos.revisado ? hace(datos.revisado).replace('ahora mismo', 'Al día').replace('hace ', '') : 'Actualizar';
}
function punto(c){
  const r = $('#red'); $('#marcaAjus').hidden = c !== 'mal';
  if (c === 'mal') { r.textContent = !cfg.url ? 'App sin conectar: ve a Ajustes.' : navigator.onLine === false ? 'Sin conexión a internet. Ves los últimos datos guardados.' : 'No se puede hablar con tu script. Se reintenta solo.'; r.hidden = false; }
  else if (c === 'ok') r.hidden = true;
}
function errorTxt(e){ return (e && ERRORES[e.error]) || 'Algo ha fallado' + (e && e.detalle ? ': ' + e.detalle : '.'); }

let pausa = false, ultimoError = '';
async function sincronizar(){
  if (!cfg.url || ocupado || pausa) { if (!cfg.url) punto('mal'); return; }
  try{ await api('leer'); punto('ok'); ultimoError = ''; $('#sEstado').textContent = `Conectado · ${(datos.pedidos||[]).length} pedidos.`; }
  catch(e){
    punto('mal'); const t = errorTxt(e); $('#sEstado').textContent = t;
    // Con la contraseña mal no se reintenta solo (si no, acabaría bloqueando el script)
    if (['clave','bloqueado','sin-clave','no-script'].includes(e.error)) { pausa = true; $('#red').textContent = t; }
    if (e.error !== 'red' && t !== ultimoError) toast(t);
    ultimoError = t;
  }
}
async function actualizarAhora(silencioso){
  if (!cfg.url) { if (!silencioso) abrir('hAjus'); return; }
  if (silencioso && pausa) return;
  const b = $('#bAct'); if (b.classList.contains('girando')) return;
  b.classList.add('girando'); ocupado = true; ultimoRefresco = Date.now();
  try{ await api('actualizar'); punto('ok'); ultimoError = ''; if (!silencioso) toast('Actualizado'); }
  catch(e){
    punto('mal'); const t = errorTxt(e);
    if (['clave','bloqueado','sin-clave'].includes(e.error)) { pausa = true; $('#red').textContent = t + ' Revísalo en Ajustes.'; }
    if (e.error === 'no-script') { pausa = true; $('#red').textContent = t; }
    if (!silencioso || (e.error !== 'red' && t !== ultimoError)) toast(t);
    ultimoError = t;
  }
  finally{ b.classList.remove('girando'); ocupado = false; }
}
// Al abrir la app (o volver a ella) se pregunta a Ship24 por todos los pedidos al momento
let ultimoRefresco = 0;
function alAbrir(){ pintarCabecera(); if (Date.now() - ultimoRefresco > 30000) actualizarAhora(true); else sincronizar(); }

/* ---------- Utilidades ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const DIAS = ['dom','lun','mar','mié','jue','vie','sáb'];
function local(iso){
  if (!iso || !/(Z|[+-]\d\d:?\d\d)$/.test(iso)) return iso;   // con zona horaria → hora de aquí
  const d = new Date(iso); if (isNaN(d)) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fecha(iso){
  if (!iso) return '';
  iso = local(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const d = new Date(+m[1], +m[2]-1, +m[3]);
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const dif = Math.round((d - hoy) / 864e5);
  const dia = dif === 0 ? 'Hoy' : dif === -1 ? 'Ayer' : dif === 1 ? 'Mañana' : `${DIAS[d.getDay()]} ${+m[3]} ${MESES[+m[2]-1]}`;
  return dia + (m[4] ? ` · ${m[4]}:${m[5]}` : '');
}
function hace(ms){
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.round(s/60)} min`;
  if (s < 86400) return `hace ${Math.round(s/3600)} h`;
  return `hace ${Math.round(s/86400)} d`;
}
function courier(c){
  if (!c) return '';
  const fijos = { nacex:'Nacex', correos:'Correos', seur:'SEUR', gls:'GLS', mrw:'MRW', dhl:'DHL', ups:'UPS', ctt:'CTT', dpd:'DPD', tnt:'TNT', fedex:'FedEx', amazon:'Amazon', 'correos-express':'Correos Express', inpost:'InPost', celeritas:'Celeritas', 'tipsa':'Tipsa', 'envialia':'Envialia', cainiao:'Cainiao', 'zeleris':'Zeleris' };
  const k = c.toLowerCase();
  if (fijos[k]) return fijos[k];
  if (/correos-?express/.test(k)) return 'Correos Express';
  const partes = k.split(/[-_]/);
  for (const f in fijos) if (partes.includes(f)) return fijos[f];
  return k.split(/[-_]/).filter(w => !/^(es|eu|int|global|api)$/.test(w)).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || c;
}
const ico = (id, cls) => `<svg class="ico ${cls||''}"><use href="#${id}"/></svg>`;
function toast(t){ const el = $('#toast'); el.textContent = t; el.classList.toggle('arriba', typeof pila !== 'undefined' && pila.length > 0); el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2600); }
const terminado = p => p.archivado || p.estado === 'delivered';
function diaDe(iso){ const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(local(iso) || ''); return m ? new Date(+m[1], +m[2]-1, +m[3]) : null; }
function hoy0(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
/* ---------- Movimientos en español ----------
   Ship24 manda algunos movimientos en inglés («In transit», «Accepted»…): se traducen los habituales. */
const TRADUCCION = [
  [/^in transit$/i, 'En tránsito'], [/^accepted$/i, 'Aceptado'], [/^notified$/i, 'Notificado'],
  [/^info(rmation)? received$/i, 'Información recibida'], [/^shipment information received$/i, 'Información recibida'],
  [/^picked up$/i, 'Recogido'], [/^out for delivery$/i, 'En reparto'], [/^delivered$/i, 'Entregado'],
  [/^(delivery )?attempt(ed)?( failed)?$/i, 'Intento de entrega fallido'], [/^failed attempt$/i, 'Intento de entrega fallido'],
  [/^available for pick ?up$/i, 'Disponible para recoger'], [/^ready for pick ?up$/i, 'Disponible para recoger'],
  [/^arrived at (the )?(facility|hub|sorting center|depot)$/i, 'Llegada a la delegación'],
  [/^departed (from )?(the )?(facility|hub|sorting center|depot)$/i, 'Salida de la delegación'],
  [/^exception$/i, 'Incidencia'], [/^returned( to sender)?$/i, 'Devuelto al remitente'], [/^customs clearance$/i, 'En aduana'],
  [/^cleared customs$/i, 'Despachado en aduana'], [/^label created$/i, 'Etiqueta creada'], [/^pending$/i, 'Pendiente']
];
function traducir(t){ const s = String(t || '').trim(); for (const [re, es] of TRADUCCION) if (re.test(s)) return es; return s; }

/* ---------- Día de llegada ----------
   1) la fecha que pongas tú en Editar; 2) la que da Ship24; 3) la que venga escrita en un movimiento
   («entrega prevista 03/11», «fecha estimada de entrega: 03-11-2026», «se entregará el 3 de noviembre»…). */
const MESES_LARGOS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function fechaEnTexto(t, ref){
  // Solo cuenta la fecha que va DETRÁS de una frase de entrega prevista (no la de «llegada a delegación 28/10»)
  const clave = /(entrega\s+(prevista|estimada|programada)|(prevista|estimada|programada)\s+(de\s+)?entrega|fecha\s+(prevista|estimada)(\s+de\s+entrega)?|se\s+entregar[áa]|entregar[áa]\s+el|reparto\s+previsto|estimated\s+delivery|expected\s+delivery|delivery\s+date)/i;
  const k = clave.exec(t); if (!k) return '';
  const resto = t.slice(k.index + k[0].length, k.index + k[0].length + 45);
  const base = ref ? new Date(ref) : new Date();
  const iso = (a, m, d) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    let y = a ? (a < 100 ? 2000 + a : a) : base.getFullYear();
    if (!a && new Date(y, m - 1, d) < new Date(base.getFullYear(), base.getMonth(), base.getDate() - 7)) y++;  // «03/01» visto en diciembre → año siguiente
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  };
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(resto);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/.exec(resto);
  if (m) return iso(m[3] ? +m[3] : 0, +m[2], +m[1]);
  m = new RegExp('\\b(\\d{1,2})\\s+de\\s+(' + MESES_LARGOS.join('|') + ')(?:\\s+de\\s+(\\d{4}))?', 'i').exec(resto);
  if (m) return iso(m[3] ? +m[3] : 0, MESES_LARGOS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return '';
}
function diaMes(iso){ const d = diaDe(iso); return d ? `${d.getDate()} ${MESES[d.getMonth()]}` : ''; }
function textoLlegada(p){ const l = llegadaDe(p); return !l.iso ? '' : l.hasta ? `${diaMes(l.desde)} – ${diaMes(l.hasta)}` : corto(l.iso); }
function llegadaDe(p){
  if (p.llegadaManual) return { iso: p.llegadaManual, origen: 'tuya' };
  if (p.estimadaTransportista) return { iso: p.estimadaTransportista, origen: 'transportista', hora: p.horaMax || '' };
  if (p.estimada) return { iso: p.estimada, origen: 'ship24' };
  if (p.correo && p.correo.desde) return { iso: p.correo.hasta || p.correo.desde, desde: p.correo.desde, hasta: p.correo.hasta || '', hora: p.correo.hora || '', origen: 'correo' };
  for (const ev of (p.eventos || [])) { const f = fechaEnTexto(ev.texto || '', local(ev.fecha) || undefined); if (f) return { iso: f, origen: 'movimiento' }; }
  return { iso: '', origen: '' };
}
const llegada = p => llegadaDe(p).iso;
function retrasado(p){
  if (['delivered','available_for_pickup','exception'].includes(p.estado) || !llegada(p)) return false;
  const d = diaDe(llegada(p)); return !!d && d < hoy0();
}
function quieto(p){
  if (!['pending','info_received'].includes(p.estado) || p.archivado) return false;
  const ult = (p.eventos || [])[0], t = ult && Date.parse(ult.fecha);
  return Date.now() - Math.max(t || 0, p.creado || 0) > 48 * 3600e3;
}
function vista(p){
  const e = est(p.estado);
  return retrasado(p) ? Object.assign({}, e, { t:'Retrasado', c:'--st-err' }) : e;
}

/* ---------- Lista ---------- */
const PCT = [6, 25, 50, 75, 100];
function corto(iso){ const f = fecha(iso); return f.replace(/ · .*/, ''); }
function ciudad(l){ return String(l || '').split(/[,·\-–(]/)[0].trim(); }
function ruta(p, e, corta){
  const evs = p.eventos || [], ini = evs[evs.length-1], ult = evs[0];
  const fin = p.estado === 'delivered';
  const pct = fin ? 100 : PCT[e.p] || 6;
  const bolaIco = fin ? 'i-ok' : e.i;
  return `<div class="ruta">
      <div><small>${esc(ini ? corto(ini.fecha) : corto(new Date(p.creado||Date.now()).toISOString()))}</small><b>${esc(ciudad(ini && ini.lugar) || p.tienda || 'Origen')}</b></div>
      <div><small>${esc(corta ? (fin ? 'Entregado' : 'Llegada') : fin ? corto(ult && ult.fecha) : p.estado === 'available_for_pickup' ? 'Listo para recoger' : llegada(p) ? (retrasado(p) ? 'Debía llegar ' : llegadaDe(p).hasta ? 'Llega entre ' : 'Llega ') + textoLlegada(p).toLowerCase().replace(' – ', ' y ') : 'Sin fecha')}</small><b>${esc(fin ? (ciudad(ult && ult.lugar) || 'Entregado') : p.estado === 'available_for_pickup' ? 'Recoger' : 'Tu casa')}</b></div>
    </div>
    <div class="barra" style="--c:var(${e.c})">
      <i class="hecho" style="width:calc((100% - 16px) * ${pct/100})"></i>
      <i class="pt a on"></i><i class="pt b ${fin ? 'on' : ''}"></i>
      <span class="bola" style="left:calc(8px + (100% - 16px) * ${pct/100})">${ico(bolaIco)}</span>
    </div>`;
}
function estChip(p){
  const e = vista(p);
  if (retrasado(p) || ['failed_attempt','exception'].includes(p.estado)) return `<span class="est coral">${esc(e.t)}</span>`;
  if (p.estado === 'delivered') return `<span class="est lleno">${esc(e.t)}</span>`;
  const dot = { out_for_delivery:'var(--acc)', in_transit:'var(--acc-medio)', available_for_pickup:'var(--st-ok)' }[p.estado] || 'var(--st-pend)';
  return `<span class="est" style="--dot:${dot}"><i></i>${esc(e.t)}</span>`;
}
function sello(p){
  const MES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const DIA = ['dom','lun','mar','mié','jue','vie','sáb'];
  const html = (cls, a, b, c, txt) => `<div class="sello ${cls}" aria-label="${esc([a, b, c].join(' '))}"><small>${esc(a)}</small><b class="${txt ? 'txt' : ''}">${esc(b)}</b><small>${esc(c)}</small></div>`;
  const fechaDe = iso => { const d = diaDe(iso); return d ? d : null; };
  if (p.estado === 'delivered'){
    const d = fechaDe((p.eventos || [])[0] && p.eventos[0].fecha);
    return d ? html('suave', 'llegó', d.getDate(), MES[d.getMonth()]) : html('suave', 'llegó', '✓', '', true);
  }
  if (p.estado === 'available_for_pickup') return html('verde', 'para', 'Ya', 'recoger', true);
  if (p.estado === 'out_for_delivery') return html('', 'reparto', 'Hoy', 'llega', true);
  const d = fechaDe(llegada(p));
  if (!d) return html('suave', 'llegada', '—', 'sin fecha', true);
  const dif = Math.round((d - hoy0()) / 864e5);
  if (retrasado(p)) return html('coral', 'debía', d.getDate(), MES[d.getMonth()]);
  if (llegadaDe(p).hasta && dif > 0) return html('', 'como tarde', d.getDate(), MES[d.getMonth()]);
  if (dif === 0) return html('', 'llega', 'Hoy', MES[d.getMonth()] + ' ' + d.getDate(), true);
  if (dif === 1) return html('', 'mañana', d.getDate(), MES[d.getMonth()]);
  return html('', DIA[d.getDay()], d.getDate(), MES[d.getMonth()]);
}
function tarjeta(p){
  const e = vista(p), ev = (p.eventos || [])[0];
  const cour = (p.couriers || []).map(courier).join(' → ');
  const sub = [cour, p.tienda].filter(Boolean).join(' · ') || p.numero;
  const donde = quieto(p) ? 'Sin movimiento desde ' + (ev ? corto(ev.fecha).toLowerCase() : 'que lo añadiste')
    : (ev && (ciudad(ev.lugar) || traducir(ev.texto))) || 'Esperando datos';
  return `<div class="fila">
    <button class="card ${terminado(p) ? 'fin' : ''}" data-id="${esc(p.id)}">
      <div class="c-top"><span class="burb" style="color:var(${e.c})">${ico(p.estado === 'delivered' ? 'i-ok' : e.i)}</span>
        <div class="c-main"><div class="c-nom">${esc(p.nombre)}</div><div class="c-sub">${esc(sub)}</div></div>${sello(p)}</div>
      <div class="c-pie">${estChip(p)}<span class="c-donde" style="${quieto(p) ? 'color:var(--st-err)' : ''}">${ico(quieto(p) ? 'i-reloj' : 'i-pin')}<span>${esc(donde)}</span></span></div>
      <div class="mini-ruta">${ruta(p, e, true)}</div>
    </button>
  </div>`;
}
function pintar(){
  const ps = datos.pedidos || [];
  const camino = ps.filter(p => !terminado(p)), fin = ps.filter(terminado);
  $('#nCamino').textContent = camino.length ? ` · ${camino.length}` : '';
  $('#nEntregados').textContent = fin.length ? ` · ${fin.length}` : '';
  pintarCabecera();
  $('#titulo').textContent = tab === 'camino' ? 'Pedidos' : 'Entregados';
  const orden = { out_for_delivery:0, failed_attempt:1, available_for_pickup:2, exception:3, in_transit:4, info_received:5, pending:6, delivered:7 };
  let html = '';
  if (tab === 'camino'){
    const lista = camino.slice().sort((a,b) => (orden[a.estado] ?? 9) - (orden[b.estado] ?? 9) || b.creado - a.creado);
    html += lista.length ? lista.map(tarjeta).join('') : cargando ? vacio(['Cargando tus pedidos…', 'Un momento, estoy preguntando a tu script.']) : vacio(!cfg.url
      ? ['Conecta la app', 'Abre Ajustes y pon la dirección del script y tu contraseña.']
      : ['Nada en camino', 'Cuando compres algo, añade su número de seguimiento y aquí verás cada paso del paquete.']);
    if (cfg.url) html += `<div class="fila"><button class="nuevo" id="bNuevo">${ico('i-mas')}Añadir otro pedido</button></div>`;
  } else {
    const ent = fin.filter(p => !p.archivado).sort((a,b) => (b.entregadoEn||b.actualizado||0) - (a.entregadoEn||a.actualizado||0));
    const arc = fin.filter(p => p.archivado);
    html += ent.length ? ent.map(tarjeta).join('') : (arc.length ? '' : vacio(['Aún no hay entregas', 'Aquí verás los pedidos que ya te han llegado. Los de más de 30 días se borran solos.']));
    if (arc.length) html += `<div class="sec-t">Archivados</div>` + arc.map(tarjeta).join('');
  }
  $('#lista').innerHTML = html;
}
function vacio([t, s]){ return `<div class="vacio">${ico('i-caja')}<b>${t}</b>${s}</div>`; }

/* ---------- Ficha ---------- */
function pintarFicha(){
  const p = (datos.pedidos || []).find(x => x.id === abierto);
  if (!p) { cerrar(); return; }
  const e = vista(p), col = `var(${e.c})`;
  $('#fNom').textContent = 'Seguimiento';
  const evs = p.eventos || [];
  const cour = (p.couriers || []).map(courier).join(' → ') || 'Detectando…';
  $('#fCuerpo').innerHTML = `
    <div class="f-cab">
      <div class="c-top"><span class="burb" style="color:${col}">${ico(p.estado === 'delivered' ? 'i-ok' : e.i)}</span>
        <div class="c-main"><div class="c-nom">${esc(p.nombre)}</div><div class="c-sub">${esc([cour, p.tienda].filter(Boolean).join(' · '))}</div></div>${sello(p)}</div>
      <div class="c-pie">${estChip(p)}<button class="f-copiar" id="bCopiar" aria-label="Copiar número" style="margin:0 0 0 auto"><span>${esc(p.numero)}</span>${ico('i-copiar')}</button></div>
      ${ruta(p, e)}
      ${p.estado === 'failed_attempt' ? '<div class="aviso">El repartidor no te ha encontrado. Mira el último movimiento: suele decir si lo intentará otra vez o lo deja en un punto de recogida.</div>' : ''}
      ${p.estado === 'available_for_pickup' ? '<div class="aviso">Ya puedes recogerlo. El último movimiento indica dónde.</div>' : ''}
      ${retrasado(p) ? `<div class="aviso">Tenía que llegar ${esc(corto(llegada(p)).toLowerCase())} y aún no consta como entregado. Si sigue así, consulta con la tienda.</div>` : ''}
      ${quieto(p) ? `<div class="aviso">Lleva más de 2 días sin movimientos. Puede que la empresa aún no lo haya recogido o que no se haya detectado bien el transportista.<br><button class="btn-aviso" id="bTransF2">Elegir transportista</button></div>` : ''}
    </div>
    <div class="linea morada">
      ${evs.length ? evs.map((v, i) => {
          const m = /T(\d{2}):(\d{2})/.exec(local(v.fecha) || '');
          return `<div class="ev ${i === 0 ? 'prim-ev' : ''}">
            <div class="ev-f"><b>${esc(corto(v.fecha) || '—')}</b>${m ? `<small>${m[1]}:${m[2]}</small>` : ''}</div>
            <div class="ev-p"></div>
            <div class="ev-t"><b>${esc(traducir(v.texto))}</b>${v.lugar ? `<small>${esc(v.lugar)}</small>` : ''}</div>
          </div>`; }).join('')
        : '<div class="ev prim-ev"><div class="ev-f"><b>Ahora</b></div><div class="ev-p"></div><div class="ev-t"><b>Esperando el primer movimiento</b><small>La empresa de transporte aún no ha publicado datos. Aparecerán aquí solos.</small></div></div>'}
    </div>
    <div class="dB">
      <div><small>Transporte</small><b>${esc(cour)}</b></div>
      <div><small>Tienda</small><b>${esc(p.tienda || '—')}</b></div>
      <div><small>${p.estado === 'delivered' ? 'Entregado' : { tuya:'Llegada (puesta por ti)', transportista:'Llegada según ' + (cour.split(' → ')[0] || 'el transportista'), ship24:'Llegada estimada', correo:'Llegada según el correo', movimiento:'Llegada prevista', '':'Llegada estimada' }[llegadaDe(p).origen]}</small><b>${p.estado === 'delivered' ? esc(fecha(evs[0] && evs[0].fecha) || '—') : esc(llegada(p) ? textoLlegada(p) : 'Sin fecha')}</b>${p.estado !== 'delivered' && llegadaDe(p).hora ? `<small class="extra">antes de las ${esc(llegadaDe(p).hora)}</small>` : ''}</div>
      <div><small>Comprobado</small><b>${esc(hace(p.actualizado) || '—')}</b></div>
    </div>
    ${p.errorUltimo ? `<p class="ayuda peligro">Última revisión con error: ${esc(errorTxt({error:p.errorUltimo}))}</p>` : ''}
    <div class="acciones">
      <a href="https://www.ship24.com/tracking?p=${encodeURIComponent(p.numero)}" target="_blank" rel="noopener"><span class="circ">${ico('i-web')}</span><small>Ship24</small></a>
      <button id="bEditar"><span class="circ">${ico('i-edit')}</span><small>Editar</small></button>
      <button id="bArch"><span class="circ">${ico('i-arch')}</span><small>${p.archivado ? 'Recuperar' : 'Archivar'}</small></button>
      <button id="bTransF"><span class="circ">${ico('i-swap')}</span><small>Transportista</small></button>
      <button id="bBorrar" class="borrar"><span class="circ">${ico('i-trash')}</span><small>Borrar</small></button>
    </div>`;
  const abrirT = () => abrirTrans(p.id);
  $('#bTransF').onclick = abrirT; if ($('#bTransF2')) $('#bTransF2').onclick = abrirT;
  $('#bCopiar').onclick = () => navigator.clipboard.writeText(p.numero).then(() => toast('Número copiado'), () => toast('No se ha podido copiar'));
  $('#bEditar').onclick = () => {
    $('#eNom').value = p.nombre; $('#eTienda').value = p.tienda || ''; $('#eLlegada').value = p.llegadaManual || '';
    const auto = llegadaDe(Object.assign({}, p, { llegadaManual: '' })).iso;
    $('#eLlegadaAyuda').textContent = auto ? `Sin poner nada se usa la automática: ${textoLlegada(Object.assign({}, p, { llegadaManual: '' })).toLowerCase()}.` : 'Ship24 no da fecha para este pedido. Si la ves en la web del transportista, ponla aquí.';
    abrir('hEditar', true);
  };
  $('#bArch').onclick = () => accion('editar', { id:p.id, archivado:!p.archivado }, p.archivado ? 'Vuelve a la lista' : 'Archivado').then(ok => ok && cerrar());
  $('#bBorrar').onclick = () => confirmar(`¿Borrar «${p.nombre}»?`, 'Dejará de seguirse y desaparecerá de la lista. No se puede deshacer.', 'Borrar pedido',
    async () => { if (await accion('borrar', { id:p.id }, 'Borrado')) { while (pila.length) cerrar(); } });
}
async function accion(nombre, extra, ok){
  ocupado = true; punto('va');
  try{ await api(nombre, extra); punto('ok'); if (ok) toast(ok); return true; }
  catch(e){ if (e.error === 'red') punto('mal'); toast(errorTxt(e)); return false; }
  finally{ ocupado = false; }
}

/* ---------- Hojas ---------- */
let pila = [];
const FONDO = ['header', 'main', '.nav'];
let focoAntes = null;
function estadoHojas(){
  // Solo la hoja de arriba se puede usar; las cerradas y lo de detrás quedan inertes (ni Tab ni lector de pantalla)
  const arriba = pila[pila.length - 1];
  document.querySelectorAll('.hoja').forEach(h => { const on = h.id === arriba; h.inert = !on; h.setAttribute('aria-hidden', !on); });
  FONDO.forEach(s => { const el = $(s); if (el) el.inert = !!pila.length; });
}
function enfocar(id){
  setTimeout(() => { const h = $('#' + id); const f = h && h.querySelector('input:not([type=hidden]), button:not([data-cerrar]), a[href]') || h && h.querySelector('[data-cerrar]'); if (f) f.focus({ preventScroll: true }); }, 280);
}
function abrir(id, encima){
  if (!pila.length) focoAntes = document.activeElement;
  if (!encima) pila.forEach(h => $('#' + h).classList.remove('on')), pila = [];
  else if (pila.length) $('#' + pila[pila.length-1]).classList.remove('on');
  pila.push(id);
  $('#velo').classList.add('on'); $('#' + id).classList.add('on');
  estadoHojas(); enfocar(id);
}
function cerrar(){
  const id = pila.pop(); if (id) $('#' + id).classList.remove('on');
  if (id === 'hFicha') abierto = null;
  if (pila.length) { $('#' + pila[pila.length-1]).classList.add('on'); }
  else { $('#velo').classList.remove('on'); abierto = null; }
  estadoHojas();
  if (!pila.length && focoAntes && document.contains(focoAntes)) focoAntes.focus({ preventScroll: true });
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pila.length) { e.preventDefault(); cerrar(); } });
let confirmarSi = null;
function confirmar(titulo, texto, boton, alSi){
  $('#cTit').textContent = titulo; $('#cTxt').textContent = texto; $('#cSi').textContent = boton;
  confirmarSi = alSi; abrir('hConf', true);
}
document.querySelectorAll('[data-cerrar]').forEach(b => b.onclick = cerrar);
$('#velo').onclick = () => { while (pila.length) cerrar(); };
$('#cNo').onclick = cerrar;
$('#cSi').onclick = () => { const f = confirmarSi; confirmarSi = null; cerrar(); if (f) f(); };
estadoHojas();

/* ---------- Eventos ---------- */
document.querySelectorAll('.nav button[data-tab]').forEach(b => b.onclick = () => {
  tab = b.dataset.tab; document.querySelectorAll('.nav button[data-tab]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); }); pintar(); scrollTo(0, 0);
});
$('#lista').onclick = ev => {
  if (ev.target.closest('#bNuevo')) return $('#bAnadir').onclick();
  const c = ev.target.closest('.card'); if (c){ abierto = c.dataset.id; pintarFicha(); abrir('hFicha'); }
};
$('#bAct').onclick = actualizarAhora;
$('#bAjus').onclick = () => { $('#sUrl').value = cfg.url; $('#sClave').value = cfg.clave; abrir('hAjus'); };
$('#bAnadir').onclick = () => {
  if (!cfg.url) { toast('Primero conecta la app en Ajustes'); return $('#bAjus').onclick(); }
  ['#aNum','#aNom','#aTienda'].forEach(s => $(s).value = '');
  transA = null; $('#aTrans').textContent = 'Automático (recomendado)';
  const mes = new Date(); mes.setDate(1); mes.setHours(0,0,0,0);
  const usados = (datos.altas || []).filter(t => t >= +mes).length;
  $('#aCupo').textContent = `Este mes llevas ${usados} ${usados === 1 ? 'pedido nuevo' : 'pedidos nuevos'}. El plan gratis de Ship24 incluye 10 al mes (100 el primer mes).`;
  abrir('hAnadir'); setTimeout(() => $('#aNum').focus(), 300);
};
$('#bPegar').onclick = async () => { try{ const t = await navigator.clipboard.readText(); $('#aNum').value = t.trim().replace(/\s+/g,''); }catch(e){ toast('Mantén pulsado el campo y elige Pegar'); } };
$('#bGuardar').onclick = async () => {
  const numero = $('#aNum').value.trim().replace(/\s+/g, '');
  if (numero.length < 5) return toast('Escribe el número de seguimiento');
  const b = $('#bGuardar'); b.disabled = true; b.textContent = 'Buscando el paquete…';
  const ok = await accion('anadir', { numero, nombre: $('#aNom').value, tienda: $('#aTienda').value, courier: transA ? transA.c : '' }, 'Pedido añadido');
  b.disabled = false; b.textContent = 'Empezar a seguir';
  if (ok){ cerrar(); tab = 'camino'; document.querySelectorAll('.nav button[data-tab]').forEach(x => { x.classList.toggle('on', x.dataset.tab === 'camino'); x.setAttribute('aria-selected', x.dataset.tab === 'camino'); }); pintar(); }
};
$('#bGuardarEd').onclick = async () => { if (await accion('editar', { id: abierto, nombre: $('#eNom').value, tienda: $('#eTienda').value, llegada: $('#eLlegada').value }, 'Guardado')) cerrar(); };
$('#bQuitarLlegada').onclick = () => { $('#eLlegada').value = ''; };
$('#bConectar').onclick = async () => {
  const nuevo = $('#sUrl').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(nuevo) && !/^http:\/\/localhost[:/]/.test(nuevo)) { $('#sEstado').textContent = ERRORES['url-mala']; return; }
  if (nuevo !== cfg.url) { datos = { pedidos: [] }; ultimoJSON = ''; LS.set('mp-datos', datos); }   // otro script: empezar de cero
  cfg = { url: nuevo, clave: $('#sClave').value }; LS.set('mp-cfg', cfg); pausa = false; ultimoError = '';
  $('#sEstado').textContent = 'Conectando…'; punto('va');
  try{ await api('leer'); punto('ok'); $('#sEstado').textContent = `Conectado · ${(datos.pedidos||[]).length} pedidos.`; toast('Conectado'); }
  catch(e){ punto('mal'); $('#sEstado').textContent = errorTxt(e); }
};
$('#sVer').textContent = `Mis pedidos ${VERSION} · los datos se guardan en tu Google Drive.`;

/* ---------- Avisos al momento ---------- */
function pintarAvisos(){
  $('#sAvisos').textContent = datos.ultimoAviso
    ? `Avisos al momento de Ship24 activos. Último: ${hace(datos.ultimoAviso)}.`
    : 'Avisos al momento de Ship24: aún no ha llegado ninguno. Si no los has activado, mira el LEEME. Mientras tanto, la app revisa cada 15 minutos.';
}

/* ---------- Transportista ---------- */
const HABITUALES = /nacex|correos|seur|gls|mrw|ctt|dhl|ups|dpd|tipsa|envialia|zeleris|inpost|celeritas|amazon|paack|sending|tnt|fedex|redyser|cbl|halcourier|genei|cainiao|yunexpress|4px|spring|asendia|packlink|uber|glovo|stuart|tourline|asm/i;
const sinTildes = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let listaCour = LS.get('mp-couriers', null);
async function cargarCouriers(){
  if (listaCour && listaCour.l && listaCour.l.length && Date.now() - listaCour.t < 30 * 864e5) return listaCour.l;
  const r = await api('couriers');
  listaCour = { t: Date.now(), l: r.couriers || [] }; LS.set('mp-couriers', listaCour);
  return listaCour.l;
}
async function abrirTrans(destino){
  transDestino = destino; $('#tBus').value = '';
  $('#tCuerpo').innerHTML = '<p class="ayuda">Cargando transportistas…</p>';
  abrir('hTrans', true);
  try{ await cargarCouriers(); pintarTrans(); }
  catch(e){ $('#tCuerpo').innerHTML = `<p class="ayuda peligro">${esc(errorTxt(e))}</p>`; }
}
function pintarTrans(){
  const q = sinTildes($('#tBus').value.trim());
  const l = (listaCour && listaCour.l) || [];
  const actual = transDestino === 'anadir' ? (transA && transA.c) : ((datos.pedidos||[]).find(x => x.id === transDestino) || {}).courierElegido;
  const item = c => `<li><button data-c="${esc(c.c)}" data-n="${esc(c.n)}" class="${c.c === actual ? 'on' : ''}"><span>${esc(c.n)}</span><small>${esc(c.c)}</small></button></li>`;
  let html = '';
  if (transDestino === 'anadir' && !q) html += `<ul class="t-lista"><li><button data-c="" data-n="" class="${!actual ? 'on' : ''}"><span>Automático (recomendado)</span></button></li></ul>`;
  if (q){
    const res = l.filter(c => sinTildes(c.n).includes(q) || sinTildes(c.c).includes(q)).slice(0, 60);
    html += res.length ? `<ul class="t-lista">${res.map(item).join('')}</ul>` : '<p class="ayuda">No hay ningún transportista con ese nombre.</p>';
  } else {
    const hab = l.filter(c => HABITUALES.test(c.n) || HABITUALES.test(c.c)).sort((a,b) => a.n.localeCompare(b.n, 'es'));
    html += `<p class="t-grupo">Habituales en España</p><ul class="t-lista">${hab.slice(0, 80).map(item).join('')}</ul>`;
    html += `<p class="ayuda">Escribe arriba para buscar entre los ${l.length} transportistas.</p>`;
  }
  if (transDestino !== 'anadir') html = '<p class="ayuda">Si ese pedido ya tiene movimientos, cambiar de transportista crea un seguimiento nuevo y gasta 1 de tus envíos gratis del mes.</p>' + html;
  $('#tCuerpo').innerHTML = html;
}
$('#tBus').oninput = pintarTrans;
$('#tCuerpo').onclick = async ev => {
  const b = ev.target.closest('button[data-c]'); if (!b) return;
  const c = b.dataset.c, n = b.dataset.n;
  if (transDestino === 'anadir'){
    transA = c ? { c, n } : null; $('#aTrans').textContent = c ? n : 'Automático (recomendado)'; cerrar(); return;
  }
  b.disabled = true; b.querySelector('span').textContent = 'Cambiando…';
  if (await accion('transportista', { id: transDestino, courier: c }, 'Transportista cambiado')) cerrar();
  else pintarTrans();
};
$('#bTransA').onclick = () => abrirTrans('anadir');

/* ---------- Gestos: bajar para cerrar y tirar para actualizar ---------- */
document.querySelectorAll('.hoja').forEach(h => {
  let y0 = null, dy = 0;
  h.addEventListener('touchstart', e => { if (h.scrollTop <= 0 && innerWidth < 700 && !e.target.closest('input,.t-lista')) { y0 = e.touches[0].clientY; dy = 0; } else y0 = null; }, { passive: true });
  h.addEventListener('touchmove', e => {
    if (y0 == null) return; dy = e.touches[0].clientY - y0;
    if (dy > 0){ h.classList.add('arrastrando'); h.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  const soltar = ok => {
    if (y0 == null) return; h.classList.remove('arrastrando'); h.style.transform = '';
    if (ok && dy > 110) cerrar(); y0 = null; dy = 0; };
  h.addEventListener('touchend', () => soltar(true));
  h.addEventListener('touchcancel', () => soltar(false));
});
(() => {
  const ptr = $('#ptr'); let y0 = null, dy = 0;
  addEventListener('touchstart', e => { y0 = (scrollY <= 0 && !pila.length && e.touches.length === 1 && !e.target.closest('.nav,header,.nueva')) ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  addEventListener('touchmove', e => {
    if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0);
    const k = Math.min(dy / 90, 1);
    ptr.style.opacity = k; ptr.style.transform = `translateY(${Math.min(dy, 110) * .5 - 30}px) rotate(${dy * 3}deg)`; }, { passive: true });
  const soltar = ok => {
    if (y0 == null) return;
    if (ok && dy > 90) actualizarAhora();
    ptr.style.opacity = 0; ptr.style.transform = ''; y0 = null; dy = 0; };
  addEventListener('touchend', () => soltar(true));
  addEventListener('touchcancel', () => soltar(false));
})();

/* ---------- Arranque ---------- */
pintar();
$('#sEstado').textContent = cfg.url ? 'Comprobando la conexión…' : 'Sin conectar.';
pintarAvisos();
alAbrir();
document.addEventListener('visibilitychange', () => { if (!document.hidden) alAbrir(); });
addEventListener('pageshow', e => { if (e.persisted) alAbrir(); });
setInterval(() => { if (!document.hidden) sincronizar(); }, 60000);
setInterval(() => { if (!document.hidden) pintarCabecera(); }, 30000);
let diaPintado = new Date().getDate();
setInterval(() => { if (!document.hidden && !pila.length && new Date().getDate() !== diaPintado) { diaPintado = new Date().getDate(); pintar(); } }, 60000);
/* ---------- Versión nueva ---------- */
let regSW = null;
async function comprobarVersion(){
  try{
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const v = (await r.json()).v;
    if (v && v !== VERSION) { $('#nueva').hidden = false; if (regSW) regSW.update().catch(() => {}); }
  }catch(e){}
}
async function ponerVersionNueva(){
  const b = $('#bRecargar'); b.textContent = 'Actualizando…'; b.disabled = true;
  try{
    if (regSW) { await regSW.update().catch(() => {}); if (regSW.waiting) regSW.waiting.postMessage('saltar'); }
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== 'mis-pedidos-fuentes').map(k => caches.delete(k)));
  }catch(e){}
  location.replace(location.pathname + '?v=' + Date.now());
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { regSW = reg; reg.update().catch(() => {}); }).catch(() => {});
}
$('#bRecargar').onclick = ponerVersionNueva;
comprobarVersion();
document.addEventListener('visibilitychange', () => { if (!document.hidden) comprobarVersion(); });
setInterval(() => { if (!document.hidden) comprobarVersion(); }, 5 * 60000);
// quitar el ?v= de la dirección después de actualizar
if (location.search.includes('v=')) history.replaceState(null, '', location.pathname);
