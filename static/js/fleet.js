/**
 * Fleet Management Module
 * Split from app.js to keep concerns separate.
 */
(function(globals) {
  // --- Destructure shared globals from app.js ---
  const {
    state,
    escapeHtml,
    formatNum,
    canAccessView,
    switchView,
    vehiclesBody,
    fuelBody,
    fuelVehicleSelect,
    fleetSummaryBody,
    tabFlotilla,
    uiDialogHost,
    uiToastHost
  } = globals;

  // --- fleet.js contents ---
// â”€â”€ Fleet Module (Enhanced) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const fleetState = { vehicles: [], fuelRecords: [], summary: [], maintenance: [] };
let trendChartInstance = null;
let compareChartInstance = null;

async function fleetFetch(url, opts = {}) {
  const csrfToken = state.auth.csrfToken || "";
  const headers = { "X-CSRF-Token": csrfToken, ...(opts.headers || {}) };
  // For mutating requests with JSON body, ensure Content-Type and include _csrf_token
  if (opts.method && opts.method !== "GET") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    if (opts.body) {
      try {
        const parsed = JSON.parse(opts.body);
        parsed._csrf_token = csrfToken;
        opts = { ...opts, body: JSON.stringify(parsed) };
      } catch(e) { /* body is not JSON, leave as-is */ }
    } else if (!opts.body) {
      opts = { ...opts, body: JSON.stringify({ _csrf_token: csrfToken }) };
    }
  }
  const res = await fetch(url, { ...opts, headers, credentials: "same-origin" });
  return res.json();
}

function loadFleetData() {
  loadVehicles();
  loadFuelRecords();
  loadFleetSummary();
  loadFleetKPIs();
  loadFleetAlerts();
  loadMaintenance();
}

// Expose to global scope for app.js to call
window.loadFleetData = loadFleetData;

async function loadFleetKPIs() {
  try {
    const d = await fleetFetch("/api/fleet/kpis");
    if (!d.ok) return;
    const el = (id) => document.getElementById(id);
    if (el("kpiVehicles")) el("kpiVehicles").textContent = d.total_vehicles || 0;
    if (el("kpiLiters")) el("kpiLiters").textContent = fmtN(d.month_liters);
    if (el("kpiCost")) el("kpiCost").textContent = "$" + fmtN(d.month_cost);
    if (el("kpiKml")) el("kpiKml").textContent = d.month_avg_kml > 0 ? d.month_avg_kml.toFixed(2) : "-";
  } catch (e) { console.error("loadFleetKPIs", e); }
}

async function loadFleetAlerts() {
  try {
    const d = await fleetFetch("/api/fleet/alerts");
    const banner = document.getElementById("fleetAlertsBanner");
    if (!banner || !d.ok) return;
    const alerts = d.alerts || [];
    if (!alerts.length) { banner.style.display = "none"; return; }
    banner.style.display = "block";
    banner.innerHTML = alerts.map(a => {
      const cls = a.overdue ? "alert-overdue" : "alert-warn";
      const icon = a.overdue ? "\u26a0\ufe0f" : "\ud83d\udd27";
      return `<div class="fleet-alert ${cls}">${icon} <strong>${esc(a.unit_number)}</strong>: ${esc(a.maintenance_type)} \u2014 ${a.overdue ? "VENCIDO por "+Math.abs(Math.round(a.remaining_km))+" km" : "Faltan "+Math.round(a.remaining_km)+" km"}</div>`;
    }).join("");
  } catch (e) { console.error("loadFleetAlerts", e); }
}

async function loadVehicles() {
  try {
    const data = await fleetFetch("/api/fleet/vehicles");
    if (data.ok) { fleetState.vehicles = data.vehicles||[]; renderVehiclesTable(); populateVehicleSelects(); }
  } catch (e) { console.error("loadVehicles", e); }
}

function renderVehiclesTable() {
  if (!vehiclesBody) return;
  vehiclesBody.innerHTML = "";
  if (!fleetState.vehicles.length) {
    vehiclesBody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#6b8299;padding:16px;">Sin veh\u00edculos registrados.</td></tr>';
    return;
  }
  fleetState.vehicles.forEach(v => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><strong>${esc(v.unit_number)}</strong></td><td>${esc(v.phone)}</td><td>${esc(v.year_model)}</td><td>${esc(v.serial_number)}</td><td>${esc(v.plate)}</td><td>${esc(v.driver)}</td><td class="num">${fmtN(v.tank_capacity)}</td><td class="num">${fmtN(v.expected_kml)}</td><td><button class="btn btn--muted btn--small fleet-edit-btn">Editar</button> <button class="btn btn--danger btn--small fleet-del-btn">Eliminar</button></td>`;
    tr.querySelector(".fleet-edit-btn").addEventListener("click", () => showVehicleDialog(v));
    tr.querySelector(".fleet-del-btn").addEventListener("click", () => deleteVehicle(v.id));
    vehiclesBody.appendChild(tr);
  });
}

function esc(v) { return escapeHtml(String(v || "")); }
function fmtN(v) { return formatNum(Number(v) || 0); }

function populateVehicleSelects() {
  ["fuelVehicleSelect","maintVehicleSelect","trendVehicleSelect"].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = selId!=="trendVehicleSelect" ? '<option value="">Todos</option>' : '';
    fleetState.vehicles.forEach(v => { const o=document.createElement("option"); o.value=String(v.id); o.textContent=v.unit_number; if(String(v.id)===cur) o.selected=true; sel.appendChild(o); });
  });
}

function showVehicleDialog(existing) {
  const isEdit = !!existing; const v = existing || {};
  const host = document.getElementById("uiDialogHost"); if (!host) return;
  host.innerHTML = `<div class="ui-dialog-backdrop"><div class="ui-dialog" style="max-width:520px;"><h3>${isEdit?"Editar":"Agregar"} Veh\u00edculo</h3><div class="fleet-form"><label>N\u00famero Unidad <input id="fvUnit" type="text" value="${esc(v.unit_number)}" required></label><label>Tel\u00e9fono <input id="fvPhone" type="text" value="${esc(v.phone)}"></label><label>A\u00f1o y Modelo <input id="fvYearModel" type="text" value="${esc(v.year_model)}"></label><label># Serie <input id="fvSerial" type="text" value="${esc(v.serial_number)}"></label><label>Placa <input id="fvPlate" type="text" value="${esc(v.plate)}"></label><label>Chofer <input id="fvDriver" type="text" value="${esc(v.driver)}"></label><label>Tanque (L) <input id="fvTank" type="number" min="0" value="${v.tank_capacity||0}"></label><label>km/L Esperado <input id="fvKml" type="number" min="0" step="0.1" value="${v.expected_kml||0}"></label></div><div class="query-actions" style="margin-top:12px;justify-content:flex-end;"><button id="fvCancel" class="btn btn--muted">Cancelar</button><button id="fvSave" class="btn btn--primary">Guardar</button></div></div></div>`;
  host.classList.remove("is-hidden"); host.setAttribute("aria-hidden","false");
  document.getElementById("fvCancel").addEventListener("click", closeDialog);
  document.getElementById("fvSave").addEventListener("click", async () => {
    const p = { unit_number:document.getElementById("fvUnit").value, phone:document.getElementById("fvPhone").value, year_model:document.getElementById("fvYearModel").value, serial_number:document.getElementById("fvSerial").value, plate:document.getElementById("fvPlate").value, driver:document.getElementById("fvDriver").value, tank_capacity:Number(document.getElementById("fvTank").value)||0, expected_kml:Number(document.getElementById("fvKml").value)||0 };
    if (isEdit) p.id = v.id;
    const res = await fleetFetch("/api/fleet/vehicles", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
    if (res.ok) { fleetState.vehicles=res.vehicles||[]; renderVehiclesTable(); populateVehicleSelects(); closeDialog(); showToast(isEdit?"Actualizado":"Registrado","ok"); } else showToast(res.error||"Error","error");
  });
}

async function deleteVehicle(id) { if (!confirm("\u00bfEliminar veh\u00edculo?")) return; const r=await fleetFetch(`/api/fleet/vehicles/${id}`,{method:"DELETE"}); if(r.ok){fleetState.vehicles=r.vehicles||[];renderVehiclesTable();populateVehicleSelects();showToast("Eliminado","ok");} }

function closeDialog() { const h=document.getElementById("uiDialogHost"); if(h){h.classList.add("is-hidden");h.setAttribute("aria-hidden","true");h.innerHTML="";} }

async function loadFuelRecords() {
  try {
    const vid = fuelVehicleSelect ? fuelVehicleSelect.value : "";
    const df = document.getElementById("fuelDateFrom"), dt = document.getElementById("fuelDateTo");
    let url = "/api/fleet/fuel?";
    if (vid) url += `vehicle_id=${vid}&`;
    if (df && df.value) url += `date_from=${df.value}&`;
    if (dt && dt.value) url += `date_to=${dt.value}&`;
    const data = await fleetFetch(url);
    if (data.ok) { fleetState.fuelRecords = data.records||[]; renderFuelTable(); }
  } catch (e) { console.error("loadFuelRecords", e); }
}

function renderFuelTable() {
  if (!fuelBody) return; fuelBody.innerHTML = "";
  if (!fleetState.fuelRecords.length) { fuelBody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#6b8299;padding:16px;">Sin registros.</td></tr>'; return; }
  fleetState.fuelRecords.forEach(r => {
    const tr = document.createElement("tr");
    const v = fleetState.vehicles.find(ve => ve.id === r.vehicle_id);
    const exp = v ? Number(v.expected_kml) : 0;
    let kmlStyle = "";
    if (r.kml_real > 0 && exp > 0) { const pct=r.kml_real/exp; kmlStyle = pct<0.7?'style="color:#dc3545;font-weight:bold;"':pct<0.9?'style="color:#e67e22;font-weight:bold;"':''; }
    tr.innerHTML = `<td><strong>${esc(r.unit_number)}</strong></td><td>${esc(r.record_date)}</td><td class="num">${fmtN(r.odometer_km)}</td><td class="num">${fmtN(r.liters)}</td><td class="num">$${fmtN(r.total_cost)}</td><td class="num">$${fmtN(r.price_per_liter)}</td><td class="num">${fmtN(r.km_traveled)}</td><td class="num" ${kmlStyle}>${r.kml_real>0?fmtN(r.kml_real):"-"}</td><td class="num">${r.cost_per_km>0?"$"+fmtN(r.cost_per_km):"-"}</td><td>${esc(r.driver)}</td><td><button class="btn btn--muted btn--small fuel-edit-btn">Ed</button> <button class="btn btn--danger btn--small fuel-del-btn">\u00d7</button></td>`;
    tr.querySelector(".fuel-edit-btn").addEventListener("click", () => showEditFuelDialog(r));
    tr.querySelector(".fuel-del-btn").addEventListener("click", async () => { if(!confirm("\u00bfEliminar carga?")) return; const res=await fleetFetch(`/api/fleet/fuel/${r.id}`,{method:"DELETE"}); if(res.ok){loadFuelRecords();loadFleetSummary();loadFleetKPIs();showToast("Eliminada","ok");} });
    fuelBody.appendChild(tr);
  });
}

function showFuelDialog() {
  const host = document.getElementById("uiDialogHost"); if (!host) return;
  const now = new Date(); const ds = now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0")+" "+String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0");
  const vOpts = fleetState.vehicles.map(v=>`<option value="${v.id}">${esc(v.unit_number)} - ${esc(v.driver)}</option>`).join("");
  host.innerHTML = `<div class="ui-dialog-backdrop"><div class="ui-dialog" style="max-width:480px;"><h3>Registrar Carga</h3><div class="fleet-form"><label>Veh\u00edculo <select id="ffVehicle">${vOpts}</select></label><label>Fecha/Hora <input id="ffDate" type="text" value="${ds}"></label><label>Km Od\u00f3metro <input id="ffKm" type="number" min="0" value="0"></label><label>Litros <input id="ffLiters" type="number" min="0" value="0"></label><label>Costo $ <input id="ffCost" type="number" min="0" value="0"></label><label>Chofer <input id="ffDriver" type="text"></label><label>Estaci\u00f3n <input id="ffStation" type="text"></label><label>Notas <input id="ffNotes" type="text"></label></div><div class="query-actions" style="margin-top:12px;justify-content:flex-end;"><button id="ffCancel" class="btn btn--muted">Cancelar</button><button id="ffSave" class="btn btn--primary">Guardar</button></div></div></div>`;
  host.classList.remove("is-hidden"); host.setAttribute("aria-hidden","false");
  const vSel=document.getElementById("ffVehicle"),dri=document.getElementById("ffDriver");
  if(vSel&&dri){const af=()=>{const ve=fleetState.vehicles.find(v=>String(v.id)===vSel.value);if(ve)dri.value=ve.driver||"";}; af(); vSel.addEventListener("change",af);}
  document.getElementById("ffCancel").addEventListener("click", closeDialog);
  document.getElementById("ffSave").addEventListener("click", async () => {
    const p={vehicle_id:Number(document.getElementById("ffVehicle").value),record_date:document.getElementById("ffDate").value,odometer_km:Number(document.getElementById("ffKm").value)||0,liters:Number(document.getElementById("ffLiters").value)||0,total_cost:Number(document.getElementById("ffCost").value)||0,driver:document.getElementById("ffDriver").value,station:document.getElementById("ffStation").value,notes:document.getElementById("ffNotes").value};
    const res = await fleetFetch("/api/fleet/fuel",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
    if(res.ok){closeDialog();showToast(res.kml_real>0?`Carga: ${res.kml_real} km/L`:"Carga registrada","ok");loadFuelRecords();loadFleetSummary();loadFleetKPIs();}else showToast(res.error||"Error","error");
  });
}

function showEditFuelDialog(r) {
  const host = document.getElementById("uiDialogHost"); if (!host) return;
  host.innerHTML = `<div class="ui-dialog-backdrop"><div class="ui-dialog" style="max-width:480px;"><h3>Editar Carga #${r.id}</h3><div class="fleet-form"><label>Fecha <input id="efDate" type="text" value="${esc(r.record_date)}"></label><label>Km <input id="efKm" type="number" value="${r.odometer_km||0}"></label><label>Litros <input id="efLiters" type="number" value="${r.liters||0}"></label><label>Costo <input id="efCost" type="number" value="${r.total_cost||0}"></label><label>Chofer <input id="efDriver" type="text" value="${esc(r.driver)}"></label><label>Estaci\u00f3n <input id="efStation" type="text" value="${esc(r.station)}"></label></div><div class="query-actions" style="margin-top:12px;justify-content:flex-end;"><button id="efCancel" class="btn btn--muted">Cancelar</button><button id="efSave" class="btn btn--primary">Guardar</button></div></div></div>`;
  host.classList.remove("is-hidden"); host.setAttribute("aria-hidden","false");
  document.getElementById("efCancel").addEventListener("click", closeDialog);
  document.getElementById("efSave").addEventListener("click", async () => {
    const p={record_date:document.getElementById("efDate").value,odometer_km:Number(document.getElementById("efKm").value)||0,liters:Number(document.getElementById("efLiters").value)||0,total_cost:Number(document.getElementById("efCost").value)||0,driver:document.getElementById("efDriver").value,station:document.getElementById("efStation").value};
    const res=await fleetFetch(`/api/fleet/fuel/${r.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
    if(res.ok){closeDialog();showToast("Actualizada","ok");loadFuelRecords();loadFleetSummary();}else showToast(res.error||"Error","error");
  });
}

async function loadMaintenance() {
  try {
    const sel=document.getElementById("maintVehicleSelect"); const vid=sel?sel.value:"";
    const url = vid?`/api/fleet/maintenance?vehicle_id=${vid}`:"/api/fleet/maintenance";
    const d = await fleetFetch(url);
    if (d.ok) { fleetState.maintenance=d.records||[]; renderMaintenanceTable(); }
  } catch (e) { console.error("loadMaintenance", e); }
}

function renderMaintenanceTable() {
  const body = document.getElementById("maintBody"); if (!body) return; body.innerHTML = "";
  if (!fleetState.maintenance.length) { body.innerHTML='<tr><td colspan="9" style="text-align:center;color:#6b8299;padding:16px;">Sin registros.</td></tr>'; return; }
  fleetState.maintenance.forEach(m => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><strong>${esc(m.unit_number)}</strong></td><td>${esc(m.maintenance_type)}</td><td>${esc(m.description)}</td><td class="num">$${fmtN(m.cost)}</td><td class="num">${fmtN(m.odometer_km)}</td><td class="num">${m.next_km>0?fmtN(m.next_km):"-"}</td><td>${esc(m.record_date)}</td><td>${esc(m.provider)}</td><td><button class="btn btn--danger btn--small maint-del-btn">\u00d7</button></td>`;
    tr.querySelector(".maint-del-btn").addEventListener("click", async () => { if(!confirm("\u00bfEliminar?")) return; await fleetFetch(`/api/fleet/maintenance/${m.id}`,{method:"DELETE"}); loadMaintenance();loadFleetAlerts();showToast("Eliminado","ok"); });
    body.appendChild(tr);
  });
}

function showMaintDialog() {
  const host = document.getElementById("uiDialogHost"); if (!host) return;
  const now = new Date().toISOString().split("T")[0];
  const vOpts = fleetState.vehicles.map(v=>`<option value="${v.id}">${esc(v.unit_number)}</option>`).join("");
  const types = ["Cambio de aceite","Filtro de aire","Filtro de diesel","Llantas","Frenos","Afinaci\u00f3n","Bater\u00eda","Otro"];
  const tOpts = types.map(t=>`<option value="${t}">${t}</option>`).join("");
  host.innerHTML = `<div class="ui-dialog-backdrop"><div class="ui-dialog" style="max-width:500px;"><h3>Registrar Mantenimiento</h3><div class="fleet-form"><label>Veh\u00edculo <select id="mfVehicle">${vOpts}</select></label><label>Tipo <select id="mfType">${tOpts}</select></label><label>Descripci\u00f3n <input id="mfDesc" type="text"></label><label>Costo $ <input id="mfCost" type="number" min="0" value="0"></label><label>Km Od\u00f3metro <input id="mfKm" type="number" min="0" value="0"></label><label>Pr\u00f3ximo Km <input id="mfNextKm" type="number" min="0" value="0"></label><label>Fecha <input id="mfDate" type="date" value="${now}"></label><label>Proveedor <input id="mfProvider" type="text"></label></div><div class="query-actions" style="margin-top:12px;justify-content:flex-end;"><button id="mfCancel" class="btn btn--muted">Cancelar</button><button id="mfSave" class="btn btn--primary">Guardar</button></div></div></div>`;
  host.classList.remove("is-hidden"); host.setAttribute("aria-hidden","false");
  document.getElementById("mfCancel").addEventListener("click", closeDialog);
  document.getElementById("mfSave").addEventListener("click", async () => {
    const p={vehicle_id:Number(document.getElementById("mfVehicle").value),maintenance_type:document.getElementById("mfType").value,description:document.getElementById("mfDesc").value,cost:Number(document.getElementById("mfCost").value)||0,odometer_km:Number(document.getElementById("mfKm").value)||0,next_km:Number(document.getElementById("mfNextKm").value)||0,record_date:document.getElementById("mfDate").value,provider:document.getElementById("mfProvider").value};
    const res=await fleetFetch("/api/fleet/maintenance",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
    if(res.ok){closeDialog();showToast("Mantenimiento registrado","ok");loadMaintenance();loadFleetAlerts();}else showToast(res.error||"Error","error");
  });
}

async function loadFleetSummary() {
  try { const d=await fleetFetch("/api/fleet/summary"); if(d.ok){fleetState.summary=d.summary||[];renderFleetSummary();renderCompareChart();} } catch(e){console.error("loadFleetSummary",e);}
}

function renderFleetSummary() {
  if (!fleetSummaryBody) return; fleetSummaryBody.innerHTML = "";
  if (!fleetState.summary.length) { fleetSummaryBody.innerHTML='<tr><td colspan="12" style="text-align:center;color:#6b8299;padding:16px;">Sin datos.</td></tr>'; return; }
  fleetState.summary.forEach(s => {
    const tr = document.createElement("tr");
    const avgKml=Number(s.avg_kml)||0, expKml=Number(s.expected_kml)||0;
    let effPct="-", effStyle="";
    if(expKml>0&&avgKml>0){const pct=(avgKml/expKml)*100;effPct=pct.toFixed(0)+"%";effStyle=pct>=90?'style="color:#28a745;font-weight:bold;"':pct>=70?'style="color:#e67e22;font-weight:bold;"':'style="color:#dc3545;font-weight:bold;"';}
    tr.innerHTML = `<td><strong>${esc(s.unit_number)}</strong></td><td>${esc(s.driver)}</td><td>${esc(s.plate)}</td><td class="num">${s.total_records||0}</td><td class="num">${fmtN(s.total_liters)}</td><td class="num">$${fmtN(s.total_cost)}</td><td class="num">${fmtN(s.total_km)}</td><td class="num"><strong>${avgKml>0?avgKml.toFixed(2):"-"}</strong></td><td class="num">${Number(s.avg_cost_per_km)>0?"$"+Number(s.avg_cost_per_km).toFixed(2):"-"}</td><td class="num">${expKml>0?expKml.toFixed(1):"-"}</td><td class="num" ${effStyle}><strong>${effPct}</strong></td><td>${esc(s.last_record||"-")}</td>`;
    fleetSummaryBody.appendChild(tr);
  });
}

async function loadTrendChart() {
  const sel=document.getElementById("trendVehicleSelect"); if(!sel||!sel.value) return;
  try {
    const d=await fleetFetch(`/api/fleet/trend/${sel.value}`);
    if(!d.ok||!d.trend.length) return;
    const ctx=document.getElementById("trendChart"); if(!ctx) return;
    if(trendChartInstance) trendChartInstance.destroy();
    const v=fleetState.vehicles.find(ve=>String(ve.id)===sel.value); const expKml=v?Number(v.expected_kml):0;
    const datasets=[{label:"km/L Real",data:d.trend.map(t=>t.kml),borderColor:"#0071e3",backgroundColor:"rgba(0,113,227,0.1)",fill:true,tension:0.3}];
    if(expKml>0) datasets.push({label:"km/L Esperado",data:d.trend.map(()=>expKml),borderColor:"#28a745",borderDash:[5,5],pointRadius:0,fill:false});
    const labels=d.trend.map(t=>{const dt=t.date?t.date.substring(0,10):"";return t.driver?dt+"\n"+t.driver:dt;});
    trendChartInstance=new Chart(ctx,{type:"line",data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom"}},scales:{y:{beginAtZero:false,title:{display:true,text:"km/L"}}}}});
  } catch(e){console.error("loadTrendChart",e);}
}

function renderCompareChart() {
  const ctx=document.getElementById("compareChart"); if(!ctx||!fleetState.summary.length) return;
  if(compareChartInstance) compareChartInstance.destroy();
  compareChartInstance=new Chart(ctx,{type:"bar",data:{labels:fleetState.summary.map(s=>s.unit_number),datasets:[
    {label:"km/L Real",data:fleetState.summary.map(s=>Number(s.avg_kml)||0),backgroundColor:"rgba(0,113,227,0.7)"},
    {label:"km/L Esperado",data:fleetState.summary.map(s=>Number(s.expected_kml)||0),backgroundColor:"rgba(40,167,69,0.5)"}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom"}},scales:{y:{beginAtZero:true,title:{display:true,text:"km/L"}}}}});
}

function exportFleetReport() {
  const w=window.open("","_blank"); if(!w) return;
  let h=`<html><head><title>Reporte Flotilla</title><style>body{font-family:Arial,sans-serif;padding:20px;}table{width:100%;border-collapse:collapse;margin:16px 0;}th,td{border:1px solid #ccc;padding:6px 8px;font-size:12px;}th{background:#eaf2fb;}h1{font-size:18px;}.num{text-align:right;}</style></head><body><h1>\ud83d\ude9b Reporte de Flotilla</h1><p>${new Date().toLocaleString()}</p><table><tr><th>Unidad</th><th>Chofer</th><th>Placa</th><th>Cargas</th><th>Litros</th><th>Costo</th><th>Km</th><th>km/L</th><th>$/km</th><th>Eficiencia</th></tr>`;
  fleetState.summary.forEach(s=>{const a=Number(s.avg_kml)||0,e=Number(s.expected_kml)||0;const eff=e>0&&a>0?((a/e)*100).toFixed(0)+"%":"-";h+=`<tr><td>${s.unit_number}</td><td>${s.driver}</td><td>${s.plate}</td><td class="num">${s.total_records}</td><td class="num">${Number(s.total_liters).toFixed(1)}</td><td class="num">$${Number(s.total_cost).toFixed(2)}</td><td class="num">${Number(s.total_km).toFixed(0)}</td><td class="num">${a>0?a.toFixed(2):"-"}</td><td class="num">${Number(s.avg_cost_per_km)>0?"$"+Number(s.avg_cost_per_km).toFixed(2):"-"}</td><td class="num">${eff}</td></tr>`;});
  h+=`</table></body></html>`; w.document.write(h); w.document.close(); w.print();
}

function showToast(msg, type) {
  const host=document.getElementById("uiToastHost"); if(!host) return;
  const t=document.createElement("div"); t.className="ui-toast"; t.style.borderLeftColor=type==="ok"?"#28a745":type==="error"?"#dc3545":"#17a2b8"; t.textContent=msg; host.appendChild(t); setTimeout(()=>t.remove(),4000);
}

// Event listeners
const addVehicleBtn=document.getElementById("addVehicleBtn"), addFuelBtn=document.getElementById("addFuelBtn");
const addMaintBtn=document.getElementById("addMaintBtn"), refreshSummaryBtn=document.getElementById("refreshSummaryBtn");
const exportFleetBtn=document.getElementById("exportFleetBtn");
if(addVehicleBtn) addVehicleBtn.addEventListener("click",()=>showVehicleDialog(null));
if(addFuelBtn) addFuelBtn.addEventListener("click",showFuelDialog);
if(addMaintBtn) addMaintBtn.addEventListener("click",showMaintDialog);
if(refreshSummaryBtn) refreshSummaryBtn.addEventListener("click",()=>{loadFleetSummary();loadFleetKPIs();});
if(exportFleetBtn) exportFleetBtn.addEventListener("click",exportFleetReport);
if(fuelVehicleSelect) fuelVehicleSelect.addEventListener("change",loadFuelRecords);
const fuelDateFrom=document.getElementById("fuelDateFrom"),fuelDateTo=document.getElementById("fuelDateTo");
if(fuelDateFrom) fuelDateFrom.addEventListener("change",loadFuelRecords);
if(fuelDateTo) fuelDateTo.addEventListener("change",loadFuelRecords);
const trendVehicleSelect=document.getElementById("trendVehicleSelect");
if(trendVehicleSelect) trendVehicleSelect.addEventListener("change",loadTrendChart);
const maintVehicleSelect=document.getElementById("maintVehicleSelect");
if(maintVehicleSelect) maintVehicleSelect.addEventListener("change",loadMaintenance);
if(tabFlotilla) tabFlotilla.addEventListener("click",()=>switchView("flotilla"));


})(window.AppGlobals);
