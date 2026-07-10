const WS_URL      = "ws://localhost:8766";
const MAX_POINTS  = 40;
const LOG_PREVIEW = 10;
const MAX_LOG     = 50;

let ws           = null;
let pktCount     = 0;
let alertCount   = 0;
let excelTimer   = null;
let excelPaused  = false;
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

function createCard(node) {
  const el = document.createElement('div');
  el.className = 'ncard';
  el.innerHTML = `
    <div class="ncard-head">
      <div class="ncard-zona"></div>
      <div class="ncard-nivel"></div>
    </div>
    <div class="ncard-metrics">
      <div class="ncm" data-k="temp"><span class="ncm-label">Temp</span><span class="ncm-value">--</span><span class="ncm-unit">C</span></div>
      <div class="ncm" data-k="hum"><span class="ncm-label">Humedad</span><span class="ncm-value">--</span><span class="ncm-unit">%</span></div>
      <div class="ncm" data-k="pres"><span class="ncm-label">Presion</span><span class="ncm-value">--</span><span class="ncm-unit">bar</span></div>
      <div class="ncm" data-k="humo"><span class="ncm-label">Humo</span><span class="ncm-value">--</span><span class="ncm-unit">ppm</span></div>
    </div>
    <div class="ncard-flags">
      <div class="flag" data-k="det">Detector OK</div>
      <div class="flag" data-k="fuga">Sin fuga</div>
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
    ['temp','humd','pres','humo'].forEach(k => { e[k].querySelector('.ncm-value').textContent = '--'; });
    e.det.textContent = 'Detector OK'; e.det.classList.remove('bad');
    e.fuga.textContent = 'Sin fuga'; e.fuga.classList.remove('bad');
    return;
  }

  const A = p.alertas || [];
  const box = (el, val, unit, hot) => {
    el.querySelector('.ncm-value').textContent = typeof val === 'number' ? (unit === 'ppm' ? val : val.toFixed(1)) : '--';
    el.classList.toggle('hot', hot);
  };

  box(e.temp, p.temperatura, 'C', A.some(a => a.startsWith('TEMP')));
  box(e.humd, p.humedad, '%', A.some(a => a.startsWith('HUMEDAD')));
  box(e.pres, p.presion_bar, 'bar', A.some(a => a.startsWith('PRESION')));
  box(e.humo, p.humo_ppm, 'ppm', A.some(a => a.startsWith('HUMO')));

  const detOk = p.detector_activo !== false;
  e.det.textContent = detOk ? 'Detector OK' : 'Detector FALLA';
  e.det.classList.toggle('bad', !detOk);

  const fuga = p.fuga_detectada === true;
  e.fuga.textContent = fuga ? 'FUGA DETECTADA' : 'Sin fuga';
  e.fuga.classList.toggle('bad', fuga);
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
  const crit = [], warn = [];
  nodes.forEach(n => {
    if (!n.online) return;
    online++;
    if (n.nivel === 'crit') crit.push(`${n.zona} (${n.id})`);
    else if (n.nivel === 'warn') warn.push(`${n.zona} (${n.id})`);
  });

  document.getElementById('sNodos').textContent = online;
  document.getElementById('chipOnlineTxt').textContent = `${online} online`;

  const chipAlert = document.getElementById('chipAlert');
  const chipTxt   = document.getElementById('chipAlertTxt');
  chipAlert.classList.toggle('hot', crit.length > 0);
  chipTxt.textContent = `${crit.length + warn.length} alertas`;

  const sp = document.getElementById('statePanel');
  const spIcon = document.getElementById('spIcon');
  const spLevel = document.getElementById('spLevel');
  const spDetail = document.getElementById('spDetail');
  const banner = document.getElementById('critBanner');

  if (crit.length) {
    sp.className = 'state-panel crit';
    spIcon.textContent = 'X'; spLevel.textContent = 'ESTADO CRITICO';
    spDetail.textContent = `${crit.length} nodo(s) requiere accion inmediata`;
    banner.className = 'crit-banner visible';
    banner.textContent = `ALERTA CRITICA — ${crit.join(' | ')}`;
  } else if (warn.length) {
    sp.className = 'state-panel warn';
    spIcon.textContent = '!'; spLevel.textContent = 'Advertencia';
    spDetail.textContent = `${warn.length} nodo(s) requiere atencion`;
    banner.className = 'crit-banner';
  } else if (online) {
    sp.className = 'state-panel ok';
    spIcon.textContent = 'OK'; spLevel.textContent = 'Todo bien';
    spDetail.textContent = `${online} nodo(s) en rango normal`;
    banner.className = 'crit-banner';
  } else {
    sp.className = 'state-panel';
    spIcon.textContent = '—'; spLevel.textContent = 'Esperando datos';
    spDetail.textContent = 'Sin nodos aun';
    banner.className = 'crit-banner';
  }

  const critSet = new Set(crit);
  const newCrit = crit.filter(id => !prevCritIds.has(id));
  if (crit.length) {
    setCriticalMode(true);
    if (newCrit.length) selectNode(newCrit[0]);
  } else {
    setCriticalMode(false);
  }
  prevCritIds = critSet;
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
      if (a.includes('TEMP_ALTA')) return `Temperatura: <span class="el-bad">${e.temperatura?.toFixed(1)}°C (alta)</span>`;
      if (a.includes('HUMEDAD_BAJA')) return `Humedad: <span class="el-bad">${e.humedad?.toFixed(1)}% (baja)</span>`;
      if (a.includes('PRESION_BAJA')) return `Presión: <span class="el-bad">${e.presion_bar?.toFixed(1)} bar (baja)</span>`;
      if (a.includes('HUMO_ALTO')) return `Humo: <span class="el-bad">${e.humo_ppm} ppm (alto)</span>`;
      if (a.includes('DETECTOR_SIN_RESPUESTA')) return `Detector: <span class="el-bad">sin respuesta</span>`;
      if (a.includes('FUGA_DETECTADA')) return `Fuga: <span class="el-bad">detectada</span>`;
      return a;
    });

    row.innerHTML = `
      <div class="el-head">
        <div>
          <div class="el-time">${ts}</div>
          <div class="el-src">${zona} • ${e.node_id}</div>
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
    const sens = (cfg.sensores || []).join(', ') || 'sin sensores';
    row.innerHTML = `
      <div class="nm-info">
        <div class="nm-id">${cfg.node_id}</div>
        <div class="nm-meta">${cfg.zona} · ${sens}</div>
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
  document.getElementById('nmFormTitle').textContent = `Editar ${id}`;
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
  const badge = document.getElementById('wsBadge');
  const txt = document.getElementById('wsTxt');
  badge.classList.remove('live');
  if (state === 'connected') {
    badge.classList.add('live');
    txt.textContent = 'conectado';
  } else if (state === 'disconnected') {
    txt.textContent = 'desconectado';
  } else {
    txt.textContent = 'conectando';
  }
}

function loadExcel(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sh = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sh, { defval: '' });
      if (!rows.length) { alert('Archivo vacio o sin formato correcto.'); return; }
      reproducirExcel(rows);
    } catch (err) { alert('No se pudo leer el archivo.'); }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

function mapExcelRow(row) {
  return {
    node_id: row['NodeID'] || row['node_id'] || 'Excel',
    zona: row['Zona'] || row['zona'] || '—',
    timestamp: row['Fecha/Hora'] || row['timestamp'] || new Date().toISOString(),
    temperatura: parseFloat(row['Temperatura'] || row['temperatura'] || 0),
    humedad: parseFloat(row['Humedad'] || row['humedad'] || 0),
    presion_bar: parseFloat(row['Presion_bar'] || row['presion_bar'] || 0),
    humo_ppm: parseInt(row['Humo_ppm'] || row['humo_ppm'] || 0),
    detector_activo: row['Detector_activo'] === true || row['Detector_activo'] === 'true' || row['Detector_activo'] === 'ACTIVO',
    fuga_detectada: row['Fuga_detectada'] === true || row['Fuga_detectada'] === 'true' || row['Fuga_detectada'] === 'FUGA DETECTADA',
    alert: false, alertas: [], nivel: 'OK',
  };
}

function reproducirExcel(rows) {
  let idx = 0;
  excelPaused = false;

  excelTimer = setInterval(() => {
    if (excelPaused) return;
    if (idx >= rows.length) {
      clearInterval(excelTimer); excelTimer = null;
      return;
    }
    renderPaquete(mapExcelRow(rows[idx++]));
  }, 1000);
}

function pausarExcel() {
  excelPaused = !excelPaused;
}

function simAlert() {
  sendCmd('sim_alerta');
}

document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('nodeModal');
  if (overlay) overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeNodeModal(); });
  connectWS();
});
