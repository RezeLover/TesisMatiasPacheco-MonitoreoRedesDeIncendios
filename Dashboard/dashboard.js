const WS_URL      = `ws://${window.location.hostname || "localhost"}:8766`;
const MAX_POINTS  = 40;
const LOG_PREVIEW = 10;
const MAX_LOG     = 50;

const ESCALAS = {
  temp: { max: 90,  umbral: 55,  bajo: false },
  humd: { max: 100, umbral: 20,  bajo: true  },
  pres: { max: 6,   umbral: 1.5, bajo: true  },
  humo: { max: 700, umbral: 300, bajo: false },
};

const SENSORES = [
  { id: 'temperatura', corto: 'Temperatura',      largo: 'Temperatura ambiente' },
  { id: 'humedad',     corto: 'Humedad',          largo: 'Humedad relativa del aire' },
  { id: 'presion',     corto: 'Presion red',      largo: 'Presion de agua red seca' },
  { id: 'humo',        corto: 'Humo',             largo: 'Concentracion de humo' },
  { id: 'detector',    corto: 'Detector de humo', largo: 'Detector de humo (autodiagnostico)' },
  { id: 'fuga',        corto: 'Fuga de agua',     largo: 'Fuga de agua en la red' },
];

let ws           = null;
let pktCount     = 0;
let alertCount   = 0;
let selectedNode = null;

const nodes = new Map();
const ORIG_TITLE = document.title;

let nodosConfig = new Map();
let prevCritIds = new Set();
let titleTimer  = null;
let audioCtx    = null;
let alarmTimer  = null;
let alertLogEntries = [];
let logExpanded = false;
let editingId   = null;
let simActivo   = false;

function mkChart(id, color, yMin, yMax) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 100 },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#999', font: { size: 9, family: 'JetBrains Mono' }, maxRotation: 0, maxTicksLimit: 5 }, grid: { color: 'rgba(255,255,255,.06)' } },
        y: { min: yMin, max: yMax, ticks: { color: '#999', font: { size: 9, family: 'JetBrains Mono' }, maxTicksLimit: 4 }, grid: { color: 'rgba(255,255,255,.06)' } },
      },
    },
  });
}

const chartTemp = mkChart('chart-temp', '#FF5A1F', 0, 90);
const chartHumo = mkChart('chart-humo', '#FFD700', 0, 700);

function updateChartsFromNode(node) {
  if (!node) return;
  chartTemp.data.labels = [...node.hist.labels];
  chartTemp.data.datasets[0].data = [...node.hist.temp];
  chartTemp.update('none');
  chartHumo.data.labels = [...node.hist.labels];
  chartHumo.data.datasets[0].data = [...node.hist.humo];
  chartHumo.update('none');
}

function hhmmss(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function nivelDe(p) {
  const n = (p.nivel || '').toUpperCase();
  if (n === 'CRITICO')     return 'crit';
  if (n === 'ADVERTENCIA') return 'warn';
  if (p.alert && (p.alertas || []).length) return 'crit';
  return 'ok';
}

function sensorPorId(id) {
  return SENSORES.find(s => s.id === id);
}

function metricaHTML(k, sensorId, unit) {
  const s = sensorPorId(sensorId);
  return `
    <div class="ncm" data-k="${k}" title="${s.largo}">
      <div class="ncm-top">
        <span class="ncm-label">${s.corto}</span>
        <span class="ncm-read"><span class="ncm-value">--</span><span class="ncm-unit">${unit}</span></span>
      </div>
      <div class="ncm-track"><div class="ncm-fill"></div><div class="ncm-danger"></div></div>
    </div>`;
}

function lamparaHTML(k, sensorId) {
  const s = sensorPorId(sensorId);
  return `
    <div class="lamprow" data-k="${k}" title="${s.largo}">
      <span class="lamp"></span><span class="lamp-txt">${s.corto}</span>
    </div>`;
}

function createCard(node) {
  const el = document.createElement('div');
  el.className = 'ncard';
  el.innerHTML = `
    <div class="ncard-head">
      <div class="ncard-zona"></div>
      <div class="ncard-nivel"></div>
    </div>
    <div class="ncard-metrics">
      ${metricaHTML('temp', 'temperatura', '°C')}
      ${metricaHTML('hum', 'humedad', '%')}
      ${metricaHTML('pres', 'presion', 'bar')}
      ${metricaHTML('humo', 'humo', 'ppm')}
    </div>
    <div class="ncard-lamps">
      ${lamparaHTML('det', 'detector')}
      ${lamparaHTML('fuga', 'fuga')}
    </div>`;

  el.addEventListener('click', () => selectNode(node.id));
  document.getElementById('nodeGrid').appendChild(el);

  const q = s => el.querySelector(s);
  node.el = {
    root:  el,
    zona:  q('.ncard-zona'),
    nivel: q('.ncard-nivel'),
    temp:  q('[data-k="temp"]'),
    humd:  q('[data-k="hum"]'),
    pres:  q('[data-k="pres"]'),
    humo:  q('[data-k="humo"]'),
    det:   q('[data-k="det"]'),
    fuga:  q('[data-k="fuga"]'),
  };

  ['temp', 'humd', 'pres', 'humo'].forEach(k => {
    const esc  = ESCALAS[k];
    const pct  = (esc.umbral / esc.max) * 100;
    const zona = node.el[k].querySelector('.ncm-danger');
    node.el[k].querySelector('.ncm-track').classList.add(esc.bajo ? 'bajo' : 'alto');
    if (esc.bajo) { zona.style.left = '0'; zona.style.width = `${pct}%`; }
    else          { zona.style.left = `${pct}%`; zona.style.right = '0'; }
  });
}

function setMetrica(el, k, val, hot) {
  const esc = ESCALAS[k];
  const num = typeof val === 'number';
  el.querySelector('.ncm-value').textContent = num ? (k === 'humo' ? val : val.toFixed(1)) : '--';
  el.querySelector('.ncm-fill').style.width = num ? `${Math.max(0, Math.min(100, (val / esc.max) * 100))}%` : '0%';
  el.classList.toggle('hot', !!hot);
}

function setLampara(el, bad, activa) {
  el.classList.toggle('bad', activa && bad);
  el.classList.toggle('ok', activa && !bad);
}

function updateCard(node) {
  if (!node.el) createCard(node);
  const e = node.el;
  e.root.className = 'ncard ' + node.nivel + (node.id === selectedNode ? ' selected' : '');
  e.zona.textContent = node.zona || '—';
  e.nivel.textContent =
    node.nivel === 'crit' ? 'CRITICO' :
    node.nivel === 'warn' ? 'ADVERTENCIA' :
    node.nivel === 'offline' ? (node.latest ? 'OFFLINE' : 'ESPERANDO') : 'OK';

  const cfg = nodosConfig.get(node.id);
  const has = k => !cfg || !Array.isArray(cfg.sensores) || !cfg.sensores.length || cfg.sensores.includes(k);
  e.temp.style.display = has('temperatura') ? '' : 'none';
  e.humd.style.display = has('humedad') ? '' : 'none';
  e.pres.style.display = has('presion') ? '' : 'none';
  e.humo.style.display = has('humo') ? '' : 'none';
  e.det.style.display  = has('detector') ? '' : 'none';
  e.fuga.style.display = has('fuga') ? '' : 'none';

  const p = node.latest;
  if (!p) {
    ['temp', 'humd', 'pres', 'humo'].forEach(k => setMetrica(e[k], k, null, false));
    setLampara(e.det, false, false);
    setLampara(e.fuga, false, false);
    return;
  }

  const A = p.alertas || [];
  setMetrica(e.temp, 'temp', p.temperatura, A.some(a => a.startsWith('TEMP')));
  setMetrica(e.humd, 'humd', p.humedad,     A.some(a => a.startsWith('HUMEDAD')));
  setMetrica(e.pres, 'pres', p.presion_bar, A.some(a => a.startsWith('PRESION')));
  setMetrica(e.humo, 'humo', p.humo_ppm,    A.some(a => a.startsWith('HUMO')));

  setLampara(e.det,  p.detector_activo === false, true);
  setLampara(e.fuga, p.fuga_detectada === true,   true);
}

function upsertNode(p) {
  const id = p.node_id || 'nodo';
  let node = nodes.get(id);
  if (!node) {
    node = { id, zona: p.zona || '—', online: true, live: true, latest: null, nivel: 'ok', hist: { labels: [], temp: [], humo: [] } };
    nodes.set(id, node);
  }
  node.zona   = p.zona || node.zona;
  node.online = true;
  node.live   = true;
  node.latest = p;
  node.nivel  = nivelDe(p);

  const lbl = hhmmss(new Date(p.server_ts || p.timestamp || Date.now()));
  node.hist.labels.push(lbl);
  node.hist.temp.push(parseFloat(p.temperatura ?? 0));
  node.hist.humo.push(parseInt(p.humo_ppm ?? 0));
  if (node.hist.labels.length > MAX_POINTS) {
    node.hist.labels.shift(); node.hist.temp.shift(); node.hist.humo.shift();
  }

  updateCard(node);
  if (!selectedNode) selectNode(id);
  else if (selectedNode === id) updateChartsFromNode(node);

  recomputeGlobal();
}

function selectNode(id) {
  selectedNode = id;
  nodes.forEach(n => { if (n.el) n.el.root.classList.toggle('selected', n.id === id); });
  const node = nodes.get(id);
  if (!node) return;
  updateChartsFromNode(node);
}

function recomputeGlobal() {
  let online = 0;
  const critIds = [], critZonas = [], warnZonas = [];
  nodes.forEach(n => {
    if (!n.online) return;
    online++;
    if (n.nivel === 'crit') { critIds.push(n.id); critZonas.push(n.zona); }
    else if (n.nivel === 'warn') { warnZonas.push(n.zona); }
  });

  document.getElementById('sNodos').textContent = online;
  document.getElementById('roNodosVal').textContent = `${online}/${nodes.size}`;

  document.getElementById('roAlertas').classList.toggle('hot', critIds.length > 0);
  document.getElementById('roAlertasVal').textContent = critIds.length + warnZonas.length;

  const sp       = document.getElementById('statePanel');
  const spLevel  = document.getElementById('spLevel');
  const spDetail = document.getElementById('spDetail');
  const banner   = document.getElementById('critBanner');
  const mark     = document.getElementById('hdrMark');

  let estado;
  if (critIds.length) {
    estado = 'crit';
    spLevel.textContent  = 'Critico';
    spDetail.textContent = `${critIds.length} zona(s) requiere accion inmediata`;
    banner.className = 'crit-banner visible';
    banner.textContent = `ALERTA CRITICA — ${critZonas.join('  |  ')}`;
  } else if (warnZonas.length) {
    estado = 'warn';
    spLevel.textContent  = 'Advertencia';
    spDetail.textContent = `${warnZonas.length} zona(s) requiere atencion`;
    banner.className = 'crit-banner';
  } else if (online) {
    estado = 'ok';
    spLevel.textContent  = 'Sistema normal';
    spDetail.textContent = `${online} zona(s) en rango normal`;
    banner.className = 'crit-banner';
  } else {
    estado = '';
    spLevel.textContent  = 'Esperando datos';
    spDetail.textContent = 'Sin nodos aun';
    banner.className = 'crit-banner';
  }
  sp.className   = `state-panel ${estado}`;
  mark.className = `hdr-mark ${estado}`;

  const newCrit = critIds.filter(id => !prevCritIds.has(id));
  if (critIds.length) {
    setCriticalMode(true);
    if (newCrit.length) selectNode(newCrit[0]);
  } else {
    setCriticalMode(false);
  }
  prevCritIds = new Set(critIds);
}

function setCriticalMode(active) {
  document.getElementById('nodeGrid').classList.toggle('has-critical', active);
  document.getElementById('critVignette').classList.toggle('active', active);
  if (active) { startTitleFlash(); startAlarm(); }
  else { stopTitleFlash(); stopAlarm(); }
}

function startTitleFlash() {
  if (titleTimer) return;
  let on = false;
  titleTimer = setInterval(() => {
    document.title = on ? ORIG_TITLE : 'ALERTA CRITICA — CIMUBB';
    on = !on;
  }, 700);
}
function stopTitleFlash() {
  if (!titleTimer) return;
  clearInterval(titleTimer); titleTimer = null;
  document.title = ORIG_TITLE;
}

function startAlarm() {
  if (alarmTimer) return;
  beep();
  alarmTimer = setInterval(beep, 1600);
}
function stopAlarm() {
  if (!alarmTimer) return;
  clearInterval(alarmTimer); alarmTimer = null;
}

function unlockAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function beep() {
  unlockAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    o.connect(g); g.connect(audioCtx.destination);
    const start = t + i * 0.18;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    o.start(start); o.stop(start + 0.17);
  });
}

function updateNodeStatus(statusNodes) {
  Object.entries(statusNodes).forEach(([id, info]) => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, zona: info.zona || '—', online: !!info.online, live: false, latest: null, nivel: info.online ? 'ok' : 'offline', hist: { labels: [], temp: [], humo: [] } };
      nodes.set(id, node);
    }
    node.online = !!info.online;
    node.zona   = info.zona || node.zona;
    node.nivel  = node.online ? (node.latest ? nivelDe(node.latest) : 'ok') : 'offline';
    updateCard(node);
    if (!selectedNode) selectNode(id);
  });
  recomputeGlobal();
}

function applyNodosConfig(list) {
  nodosConfig = new Map(list.map(n => [n.node_id, n]));

  nodosConfig.forEach((cfg, id) => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, zona: cfg.zona || '—', online: false, live: false, latest: null, nivel: 'offline', hist: { labels: [], temp: [], humo: [] } };
      nodes.set(id, node);
    }
    node.zona = cfg.zona || node.zona;
    updateCard(node);
  });

  [...nodes.keys()].forEach(id => {
    const n = nodes.get(id);
    if (!nodosConfig.has(id) && !n.live) {
      if (n.el) n.el.root.remove();
      nodes.delete(id);
      if (selectedNode === id) selectedNode = null;
    }
  });

  const modal = document.getElementById('nodeModal');
  if (modal && modal.classList.contains('visible')) renderNodeList();
  recomputeGlobal();
}

function renderPaquete(p) {
  pktCount++;
  document.getElementById('sPkts').textContent = pktCount;

  if (p.alert && p.alertas?.length) {
    alertCount++;
    document.getElementById('sAlerts').textContent = alertCount;
    document.getElementById('sLastAlert').textContent = new Date().toLocaleTimeString();
  }

  upsertNode(p);
}

function connectWS() {
  updateBadgeWS('connecting');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    updateBadgeWS('connected');
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'history' && Array.isArray(data.data)) {
        data.data.forEach(renderPaquete);
      } else if (data.type === 'node_status') {
        updateNodeStatus(data.nodes || {});
      } else if (data.type === 'nodos_config') {
        applyNodosConfig(data.nodos || []);
      } else if (data.type === 'alert_log') {
        renderAlertLog(data.data || []);
      } else if (data.type === 'alert_log_entry') {
        addAlertLogEntry(data.entry);
      } else if (data.type === 'sim_estado') {
        updateSimButton(!!data.activo);
      } else {
        renderPaquete(data);
      }
    } catch (e) { }
  };

  ws.onclose = () => {
    updateBadgeWS('disconnected');
    setTimeout(connectWS, 6000);
  };

  ws.onerror = () => updateBadgeWS('disconnected');
}

function renderAlertLog(entries) {
  alertLogEntries = entries || [];
  redrawAlertLog();
}

function addAlertLogEntry(entry) {
  alertLogEntries.unshift(entry);
  if (alertLogEntries.length > MAX_LOG) {
    alertLogEntries.pop();
  }
  redrawAlertLog();
}

function redrawAlertLog() {
  const container = document.getElementById('eventLogList');
  const toggle = document.getElementById('elToggle');
  if (!container) return;

  if (toggle) {
    if (alertLogEntries.length > LOG_PREVIEW) {
      toggle.style.display = '';
      toggle.textContent = logExpanded ? 'VER MENOS' : `VER TODOS (${alertLogEntries.length})`;
    } else {
      toggle.style.display = 'none';
    }
  }

  if (!alertLogEntries.length) {
    container.innerHTML = '<div class="el-empty">Sin alertas</div>';
    return;
  }

  const visibles = logExpanded ? alertLogEntries : alertLogEntries.slice(0, LOG_PREVIEW);
  container.innerHTML = '';
  visibles.forEach(e => {
    const nivel = e.nivel?.toUpperCase() || 'OK';
    const cssClase = nivel === 'CRITICO' ? 'crit' : nivel === 'ADVERTENCIA' ? 'warn' : 'ok';

    const row = document.createElement('div');
    row.className = `el-row ${cssClase}`;

    const ts = e.creado_en ? new Date(e.creado_en).toLocaleTimeString('es-ES') : '—';
    const zona = e.zona || '—';

    const alertasTexto = (e.alertas || []).map(a => {
      if (a.includes('TEMP_ALTA')) return `Temperatura ambiente: <span class="el-bad">${e.temperatura?.toFixed(1)}°C (alta)</span>`;
      if (a.includes('HUMEDAD_BAJA')) return `Humedad relativa: <span class="el-bad">${e.humedad?.toFixed(1)}% (baja)</span>`;
      if (a.includes('PRESION_BAJA')) return `Presión de red: <span class="el-bad">${e.presion_bar?.toFixed(1)} bar (baja)</span>`;
      if (a.includes('HUMO_ALTO')) return `Concentración de humo: <span class="el-bad">${e.humo_ppm} ppm (alta)</span>`;
      if (a.includes('DETECTOR_SIN_RESPUESTA')) return `Detector de humo: <span class="el-bad">no responde</span>`;
      if (a.includes('FUGA_DETECTADA')) return `Fuga de agua: <span class="el-bad">detectada</span>`;
      return a;
    });

    row.innerHTML = `
      <div class="el-head">
        <div>
          <div class="el-time">${ts}</div>
          <div class="el-src" title="${e.node_id || ''}">${zona}</div>
        </div>
        <span class="el-badge ${cssClase}">${nivel}</span>
      </div>
      <div class="el-details">
        ${alertasTexto.map(a => `<div class="el-item">${a}</div>`).join('')}
      </div>
    `;

    container.appendChild(row);
  });
}

function toggleLogView() {
  logExpanded = !logExpanded;
  redrawAlertLog();
}

function clearAlertLog() {
  alertLogEntries = [];
  logExpanded = false;
  redrawAlertLog();
}

function openNodeModal() {
  document.getElementById('nodeModal').classList.add('visible');
  resetNodeForm();
  renderNodeList();
}

function closeNodeModal() {
  document.getElementById('nodeModal').classList.remove('visible');
}

function renderNodeList() {
  const box = document.getElementById('nmList');
  box.innerHTML = '';
  if (!nodosConfig.size) {
    box.innerHTML = '<div class="nm-empty">Sin nodos registrados</div>';
    return;
  }
  nodosConfig.forEach(cfg => {
    const row = document.createElement('div');
    row.className = 'nm-row';
    const sens = (cfg.sensores || []).map(id => sensorPorId(id)?.corto || id).join(' · ') || 'sin sensores';
    row.innerHTML = `
      <div class="nm-info">
        <div class="nm-id">${cfg.zona}</div>
        <div class="nm-meta">${cfg.node_id} · ${sens}</div>
      </div>
      <div class="nm-btns">
        <button onclick="editNode('${cfg.node_id}')">EDITAR</button>
        <button class="danger" onclick="deleteNode('${cfg.node_id}')">ELIMINAR</button>
      </div>`;
    box.appendChild(row);
  });
}

function editNode(id) {
  const cfg = nodosConfig.get(id);
  if (!cfg) return;
  editingId = id;
  document.getElementById('nmFormTitle').textContent = `Editar ${cfg.zona || id}`;
  const idInput = document.getElementById('nmId');
  idInput.value = id;
  idInput.disabled = true;
  document.getElementById('nmZona').value = cfg.zona || '';
  document.querySelectorAll('#nmSensores input').forEach(chk => {
    chk.checked = (cfg.sensores || []).includes(chk.value);
  });
}

function resetNodeForm() {
  editingId = null;
  document.getElementById('nmFormTitle').textContent = 'Agregar nodo';
  const idInput = document.getElementById('nmId');
  idInput.value = '';
  idInput.disabled = false;
  document.getElementById('nmZona').value = '';
  document.querySelectorAll('#nmSensores input').forEach(chk => { chk.checked = true; });
}

function submitNodeForm() {
  const id = document.getElementById('nmId').value.trim();
  const zona = document.getElementById('nmZona').value.trim();
  const sensores = [...document.querySelectorAll('#nmSensores input:checked')].map(c => c.value);
  if (!id) { alert('Falta el ID del nodo.'); return; }
  if (!zona) { alert('Falta la zona.'); return; }
  sendData({ cmd: editingId ? 'editar_nodo' : 'crear_nodo', node_id: id, zona, sensores });
  resetNodeForm();
}

function deleteNode(id) {
  if (!confirm(`¿Eliminar ${id} del registro?`)) return;
  sendData({ cmd: 'eliminar_nodo', node_id: id });
}

function sendData(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendCmd(cmd) {
  sendData({ cmd });
}

function updateBadgeWS(state) {
  const ro  = document.getElementById('roEnlace');
  const txt = document.getElementById('roEnlaceVal');
  ro.classList.remove('live');
  if (state === 'connected') {
    ro.classList.add('live');
    txt.textContent = 'ACTIVO';
  } else if (state === 'disconnected') {
    txt.textContent = 'CAIDO';
  } else {
    txt.textContent = '···';
  }
}

function simAlert() {
  sendData({ cmd: 'sim_alerta', node_id: selectedNode });
}

function toggleSim() {
  sendCmd(simActivo ? 'sim_stop' : 'sim_start');
}

function updateSimButton(activo) {
  simActivo = activo;
  const btn = document.getElementById('btnSim');
  if (!btn) return;
  btn.textContent = activo ? 'DETENER SIMULACIÓN' : 'INICIAR SIMULACIÓN';
  btn.classList.toggle('sim-on', activo);
}

function renderSensorPicker() {
  const box = document.getElementById('nmSensores');
  if (!box) return;
  box.innerHTML = SENSORES.map(s => `
    <label class="nm-sen">
      <input type="checkbox" value="${s.id}" checked>
      <span class="nm-sen-name">${s.largo}</span>
    </label>`).join('');
}

document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('DOMContentLoaded', () => {
  renderSensorPicker();
  const overlay = document.getElementById('nodeModal');
  if (overlay) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeNodeModal(); });
  connectWS();
});
