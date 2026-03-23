const APP_BOOT = window.APP_BOOT || {};

const state = {
  auth: {
    username: APP_BOOT.username || "",
    role: APP_BOOT.role || "",
    mustChangePassword: Boolean(APP_BOOT.must_change_password),
    allowedViews: Array.isArray(APP_BOOT.allowed_views) ? APP_BOOT.allowed_views : ["editor", "consulta", "dosificador"],
    canEdit: Boolean(APP_BOOT.can_edit),
    canEditQcHumidity: Boolean(APP_BOOT.can_edit_qc_humidity),
    csrfToken: APP_BOOT.csrf_token || "",
  },
  file: "",
  files: [],
  fileInfos: [],
  datasetFamily: "",
  version: null,
  qcVersion: 0,
  qcUpdatedAt: "",
  qcDirty: false,
  qcError: "",
  encoding: "",
  delimiter: "",
  updatedAt: "",
  headers: [],
  rows: [],
  dirty: false,
  selected: new Set(),
  searchText: "",
  sort: { col: null, dir: "asc" },
  view: "editor",
  consultaStep: 0,
  index: {},
  queryResults: [],
  selectedQueryRow: null,
  unitCosts: {},
  haulCosts: {},
  quoteMode: false,
  quoteOverrides: {},
  remisiones: {
    items: [],
    initialized: false,
  },
  doser: {
    dosageM3: 7.0,
    paramsVersion: 0,
    paramsUpdatedAt: "",
    results: [],
    remisiones: [],
    quality: {
      "Fino 1": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
      "Fino 2": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
      "Grueso 1": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
      "Grueso 2": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
    },
    params: {
      cemento_pesp: 3.1,
      aire_pct: 2.0,
      pasa_malla_200_pct: 19.0,
      pxl_pond_pct: 6.4,
      densidad_agregado_fallback: 2.2,
    },
    tolerances: { cemento: 1, agregados: 3, agua: 2, aditivo: 1 },
    realLoads: {},
    selectedMaterials: {},
    invMaterials: [],
    familiesSummary: [],
    globalRecipes: [],
    selectedEntry: null,
  },
};
const MOD_DATE_HEADER = "FECHA_MODIF";
const QC_AGGREGATES = ["Fino 1", "Fino 2", "Grueso 1", "Grueso 2"];
const QC_FIELDS = ["pvs", "pvc", "densidad", "absorcion", "humedad"];
const BRAND_LOGO_URL = `${window.location.origin}/static/img/logo_almex.png`;
const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// --- PUERTO MORELOS TIME HELPERS ---
function getPuertoMorelosDate() {
  // Retorna un objeto Date ajustado a Puerto Morelos (zona tecnica America/Cancun)
  const now = new Date();
  // Intl.DateTimeFormat es la forma mas robusta de obtener la hora en una zona especifica sin librerias
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Cancun',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const p = parts.reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  // Construir un Date local que "represente" la hora de Puerto Morelos
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

function getTodayPuertoMorelos() {
  const d = getPuertoMorelosDate();
  return formatPuertoMorelosDate(d);
}

function getFullTodayPuertoMorelos() {
  const d = getPuertoMorelosDate();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hrs = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hrs}:${min}`;
}

function formatPuertoMorelosDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPuertoMorelosDateOffset(days) {
  const d = getPuertoMorelosDate();
  d.setDate(d.getDate() + Number(days || 0));
  return formatPuertoMorelosDate(d);
}

function updatePuertoMorelosClock() {
  const timeEl = document.getElementById("clockTime");
  const dateEl = document.getElementById("clockDate");
  if (!timeEl || !dateEl) return;

  const d = getPuertoMorelosDate();

  // Formatear hora: HH:mm:ss
  const hrs = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const sec = String(d.getSeconds()).padStart(2, '0');
  timeEl.textContent = `${hrs}:${min}:${sec}`;

  // Formatear fecha: Lunes, 09 de Marzo de 2026
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Cancun' };
  dateEl.textContent = new Intl.DateTimeFormat('es-MX', options).format(new Date());
}

// Iniciar reloj
setInterval(updatePuertoMorelosClock, 1000);
window.addEventListener('DOMContentLoaded', updatePuertoMorelosClock);

// Expose to AppGlobals
window.AppGlobals = window.AppGlobals || {};
window.AppGlobals.getTodayPuertoMorelos = getTodayPuertoMorelos;
window.AppGlobals.getFullTodayPuertoMorelos = getFullTodayPuertoMorelos;
// ---------------------------

const tableHead = document.querySelector("#csvTable thead");
const tableBody = document.querySelector("#csvTable tbody");
const metaInfo = document.getElementById("metaInfo");
const statusBar = document.getElementById("statusBar");
const uiToastHost = document.getElementById("uiToastHost");
const uiDialogHost = document.getElementById("uiDialogHost");
const saveState = document.getElementById("saveState");
const searchInput = document.getElementById("searchInput");
const fileSelect = document.getElementById("fileSelect");
const datasetFamilyInput = document.getElementById("datasetFamilyInput");
const saveFamilyBtn = document.getElementById("saveFamilyBtn");
const uploadInput = document.getElementById("uploadInput");
const editorView = document.getElementById("editorView");
const consultaView = document.getElementById("consultaView");
const dosificadorView = document.getElementById("dosificadorView");
const remisionesView = document.getElementById("remisionesView");
const tabEditor = document.getElementById("tabEditor");
const tabConsulta = document.getElementById("tabConsulta");
const tabDosificador = document.getElementById("tabDosificador");
const tabRemisiones = document.getElementById("tabRemisiones");
const tabFlotilla = document.getElementById("tabFlotilla");
const tabInventario = document.getElementById("tabInventario");
const tabLaboratorio = document.getElementById("tabLaboratorio");
const tabUsuarios = document.getElementById("tabUsuarios");
const flotillaView = document.getElementById("flotillaView");
const inventarioView = document.getElementById("inventarioView");
const laboratorioView = document.getElementById("laboratorioView");
const usuariosView = document.getElementById("usuariosView");
const vehiclesBody = document.getElementById("vehiclesBody");
const fuelBody = document.getElementById("fuelBody");
const fuelVehicleSelect = document.getElementById("fuelVehicleSelect");
const fleetSummaryBody = document.getElementById("fleetSummaryBody");
const familiasBoard = document.getElementById("familiasBoard");
const updatedStamp = document.getElementById("updatedStamp");
const queryTable = document.getElementById("queryTable");
const queryBody = document.getElementById("queryBody");
const querySummary = document.getElementById("querySummary");
const recipeMeta = document.getElementById("recipeMeta");
const recipeBody = document.getElementById("recipeBody");
const recipeWeight = document.getElementById("recipeWeight");
const exportReportBtn = document.getElementById("exportReportBtn");
const toggleQuoteModeBtn = document.getElementById("toggleQuoteMode");
const costBody = document.getElementById("costBody");
const costHaulTotal = document.getElementById("costHaulTotal");
const costMaterialTotal = document.getElementById("costMaterialTotal");
const costTotal = document.getElementById("costTotal");
const qcBody = document.getElementById("qcBody");
const editorQcBody = document.getElementById("editorQcBody");
const editorQcMeta = document.getElementById("editorQcMeta");
const qcLinkedStamp = document.getElementById("qcLinkedStamp");
const saveQcHumidityBtn = document.getElementById("saveQcHumidityBtn");
const tolAccessNote = document.getElementById("tolAccessNote");
const doserSummary = document.getElementById("doserSummary");
const doserSelectedMeta = document.getElementById("doserSelectedMeta");
const doserQueryBody = document.getElementById("doserQueryBody");
const doserRecipeBody = document.getElementById("doserRecipeBody");
const doserRecipeWeight = document.getElementById("doserRecipeWeight");
const doserTheoreticalBody = document.getElementById("doserTheoreticalBody");
const doserTheoreticalWeight = document.getElementById("doserTheoreticalWeight");
const doserRealBody = document.getElementById("doserRealBody");
const doserRealWeight = document.getElementById("doserRealWeight");
const doserExportReportBtn = document.getElementById("dExportReportBtn");
const doseM3Input = document.getElementById("doseM3");
const remisionNoInput = document.getElementById("dRemisionNo");
const remisionClienteInput = document.getElementById("dCliente");
const remisionUbicacionInput = document.getElementById("dUbicacion");
const remisionDateInput = document.getElementById("dRemisionDate");
const saveRemisionBtn = document.getElementById("dSaveRemisionBtn");
const refreshRemisionBtn = document.getElementById("dRefreshRemisionBtn");
const remisionFilterDate = document.getElementById("dRemisionFilterDate");
const remisionMeta = document.getElementById("dRemisionMeta");
const doserRemisionBody = document.getElementById("doserRemisionBody");
const remisionesSearchInput = document.getElementById("remisionesSearchInput");
const remisionesDateFrom = document.getElementById("remisionesDateFrom");
const remisionesDateTo = document.getElementById("remisionesDateTo");
const remisionesRefreshBtn = document.getElementById("remisionesRefreshBtn");
const remisionesMeta = document.getElementById("remisionesMeta");
const remisionesBody = document.getElementById("remisionesBody");
const tolCementoInput = document.getElementById("tolCemento");
const tolAgregadosInput = document.getElementById("tolAgregados");
const tolAguaInput = document.getElementById("tolAgua");
const tolAditivoInput = document.getElementById("tolAditivo");
const paramCementoPespInput = document.getElementById("paramCementoPesp");
const paramAirePctInput = document.getElementById("paramAirePct");
const paramPasa200PctInput = document.getElementById("paramPasa200Pct");
const paramPxlPctInput = document.getElementById("paramPxlPct");
const paramDensidadAggInput = document.getElementById("paramDensidadAgg");
const doserParamsMeta = document.getElementById("doserParamsMeta");
const saveDoserParamsBtn = document.getElementById("saveDoserParamsBtn");
const auditBtn = document.getElementById("auditBtn");
const backupCreateBtn = document.getElementById("backupCreateBtn");
const backupRestoreBtn = document.getElementById("backupRestoreBtn");

function canEditDoserTolerances() {
  return state.auth.role === "jefe-de-planta" || state.auth.role === "administrador";
}

function withCsrf(options = {}) {
  const out = { ...options };
  const method = (out.method || "GET").toUpperCase();
  if (!MUTATING_HTTP_METHODS.has(method)) return out;
  const headers = { ...(out.headers || {}) };
  if (state.auth.csrfToken) headers["X-CSRF-Token"] = state.auth.csrfToken;
  out.headers = headers;
  return out;
}

function apiFetch(input, options = {}) {
  return window.fetch(input, withCsrf(options));
}

const doserFields = {
  family: document.getElementById("dFamily"),
  fc: document.getElementById("dFc"),
  edad: document.getElementById("dEdad"),
  tipo: document.getElementById("dTipo"),
  tma: document.getElementById("dTma"),
  rev: document.getElementById("dRev"),
  comp: document.getElementById("dComp"),
};

const queryFields = {
  family: document.getElementById("qFamily"),
  fc: document.getElementById("qFc"),
  edad: document.getElementById("qEdad"),
  tipo: document.getElementById("qTipo"),
  tma: document.getElementById("qTma"),
  rev: document.getElementById("qRev"),
  comp: document.getElementById("qComp"),
};

const queryResultShell = queryTable ? queryTable.closest(".result-shell") : null;
const consultaSlides = Array.from(document.querySelectorAll("#consultaView .consulta-slide"));
const consultaStepLabel = document.getElementById("consultaStepLabel");
const consultaPrevBtn = document.getElementById("consultaPrevBtn");
const consultaNextBtn = document.getElementById("consultaNextBtn");

function stripAccents(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalize(value) {
  return stripAccents((value ?? "").toString().toLowerCase().trim());
}

function normalizeHeader(value) {
  return normalize(value).replace(/[^a-z0-9]/g, "");
}

function toNumber(value) {
  const clean = (value ?? "").toString().replace(",", ".").trim();
  if (clean === "") return 0;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNum(value) {
  return Number(value).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatVol(value) {
  return Number(value).toLocaleString("es-MX", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function formatMoney(value) {
  return `$${formatNum(value)}`;
}

function escapeHtml(value) {
  return (value ?? "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nowStamp() {
  const dt = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const y = dt.getFullYear();
  const m = pad(dt.getMonth() + 1);
  const d = pad(dt.getDate());
  const hh = pad(dt.getHours());
  const mm = pad(dt.getMinutes());
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function createDefaultQuality() {
  return {
    "Fino 1": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
    "Fino 2": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
    "Grueso 1": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
    "Grueso 2": { pvs: 0, pvc: 0, densidad: 0, absorcion: 0, humedad: 0 },
  };
}

function normalizeQualityValues(values) {
  const base = createDefaultQuality();
  if (!values || typeof values !== "object") return base;
  QC_AGGREGATES.forEach((agg) => {
    const row = values[agg];
    if (!row || typeof row !== "object") return;
    QC_FIELDS.forEach((field) => {
      base[agg][field] = toNumber(row[field]);
    });
  });
  return base;
}

function defaultDoserParams() {
  return {
    cemento_pesp: 3.1,
    aire_pct: 2.0,
    pasa_malla_200_pct: 19.0,
    pxl_pond_pct: 6.4,
    densidad_agregado_fallback: 2.2,
  };
}

function normalizeDoserParams(values) {
  const base = defaultDoserParams();
  if (!values || typeof values !== "object") return base;
  const out = {};
  Object.keys(base).forEach((key) => {
    const num = toNumber(values[key]);
    out[key] = num >= 0 ? num : base[key];
  });
  return out;
}

function safeDivide(numerator, denominator, fallback = 0) {
  const den = Number(denominator);
  if (!Number.isFinite(den) || Math.abs(den) <= 1e-9) {
    return { value: fallback, fallbackUsed: true };
  }
  return { value: Number(numerator) / den, fallbackUsed: false };
}

function getModDateColIndex() {
  const aliases = new Set(["fechamodif", "fechamodificacion", "modificado", "ultimafecha"]);
  for (let i = 0; i < state.headers.length; i += 1) {
    const key = normalizeHeader(splitHeaderName(state.headers[i]).name || state.headers[i]);
    if (aliases.has(key)) return i;
  }
  return -1;
}

function ensureModDateColumn() {
  let idx = getModDateColIndex();
  if (idx < 0) {
    state.headers.push(MOD_DATE_HEADER);
    state.rows.forEach((row) => row.push(""));
    idx = state.headers.length - 1;
  } else {
    state.rows.forEach((row) => {
      if (row.length < state.headers.length) row.push("");
    });
  }
  return idx;
}

function setRowModifiedDate(rowIndex) {
  const colIndex = ensureModDateColumn();
  if (!state.rows[rowIndex]) return;
  state.rows[rowIndex][colIndex] = nowStamp();
}

function setStatus(message, tone = "ok") {
  if (statusBar) {
    statusBar.textContent = message;
    statusBar.setAttribute("data-tone", tone);
  }
  if (tone === "warn" || tone === "err") pushToast(message, tone);
}

function getToneMeta(tone = "ok") {
  if (tone === "err") return { label: "Error", buttonClass: "btn--danger" };
  if (tone === "warn") return { label: "Advertencia", buttonClass: "btn--warn" };
  if (tone === "info") return { label: "Informacion", buttonClass: "btn--secondary" };
  return { label: "Correcto", buttonClass: "btn--success" };
}

function toneIconSvg(tone = "ok", cssClass = "ui-tone-icon") {
  const cls = escapeHtml(cssClass);
  if (tone === "err") {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"></circle><path d="M8 8l8 8M16 8l-8 8"></path></svg>`;
  }
  if (tone === "warn") {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3l10 18H2L12 3z"></path><path d="M12 9v5m0 3h.01"></path></svg>`;
  }
  if (tone === "info") {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"></circle><path d="M12 10v7m0-10h.01"></path></svg>`;
  }
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"></circle><path d="M7 12l3 3 7-7"></path></svg>`;
}

function pushToast(message, tone = "ok", timeoutMs = 3200) {
  if (!uiToastHost || !message) return;
  const toneMeta = getToneMeta(tone);
  const toast = document.createElement("div");
  toast.className = "ui-toast";
  toast.setAttribute("data-tone", tone);
  toast.innerHTML = `
    <div class="ui-toast__head">
      ${toneIconSvg(tone, "ui-tone-icon ui-tone-icon--toast")}
      <p class="ui-toast__title">${escapeHtml(toneMeta.label)}</p>
    </div>
    <p class="ui-toast__text">${escapeHtml(message)}</p>
  `;
  uiToastHost.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("is-out");
    window.setTimeout(() => toast.remove(), 180);
  }, timeoutMs);
}

function uiDialog(options = {}) {
  const {
    mode = "confirm",
    title = "Confirmacion",
    message = "",
    defaultValue = "",
    confirmText = "Aceptar",
    cancelText = "Cancelar",
    tone = "ok",
  } = options;

  if (!uiDialogHost) {
    if (mode === "prompt") return Promise.resolve(window.prompt(message, defaultValue));
    return Promise.resolve(window.confirm(message));
  }

  const toneMeta = getToneMeta(tone);

  return new Promise((resolve) => {
    uiDialogHost.classList.remove("is-hidden");
    uiDialogHost.setAttribute("aria-hidden", "false");
    uiDialogHost.innerHTML = `
      <div class="ui-dialog" data-tone="${escapeHtml(tone)}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
        <header class="ui-dialog__head">
          <div class="ui-dialog__title-wrap">
            ${toneIconSvg(tone, "ui-tone-icon ui-tone-icon--dialog")}
            <h3 class="ui-dialog__title">${escapeHtml(title)}</h3>
          </div>
          <span class="ui-dialog__chip">${escapeHtml(toneMeta.label)}</span>
        </header>
        <div class="ui-dialog__body">
          <p class="ui-dialog__message">${escapeHtml(message)}</p>
          ${mode === "prompt"
        ? `<input class="ui-dialog__input" type="text" value="${escapeHtml(defaultValue)}" autocomplete="off">`
        : ""
      }
        </div>
        <footer class="ui-dialog__actions">
          <button type="button" class="btn btn--muted btn--small ui-dialog-cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn ${escapeHtml(toneMeta.buttonClass)} btn--small ui-dialog-confirm">${escapeHtml(confirmText)}</button>
        </footer>
      </div>
    `;

    const dialog = uiDialogHost.querySelector(".ui-dialog");
    const input = uiDialogHost.querySelector(".ui-dialog__input");
    const cancelBtn = uiDialogHost.querySelector(".ui-dialog-cancel");
    const confirmBtn = uiDialogHost.querySelector(".ui-dialog-confirm");

    const onBackdropClick = (event) => {
      if (event.target === uiDialogHost) close(mode === "prompt" ? null : false);
    };

    const close = (value) => {
      document.removeEventListener("keydown", onKeyDown);
      uiDialogHost.removeEventListener("click", onBackdropClick);
      uiDialogHost.classList.add("is-hidden");
      uiDialogHost.setAttribute("aria-hidden", "true");
      uiDialogHost.innerHTML = "";
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(mode === "prompt" ? null : false);
        return;
      }
      if (event.key === "Enter") {
        const targetTag = (event.target?.tagName || "").toLowerCase();
        if (targetTag === "textarea") return;
        event.preventDefault();
        close(mode === "prompt" ? (input ? input.value : "") : true);
      }
    };

    document.addEventListener("keydown", onKeyDown);

    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => close(mode === "prompt" ? null : false));
    }
    if (confirmBtn) {
      confirmBtn.addEventListener("click", () => close(mode === "prompt" ? (input ? input.value : "") : true));
    }
    uiDialogHost.addEventListener("click", onBackdropClick);

    if (input) {
      input.focus();
      input.select();
    } else if (dialog) {
      dialog.focus();
    }
  });
}

function uiConfirm(message, options = {}) {
  return uiDialog({
    mode: "confirm",
    title: options.title || "Confirmacion",
    message,
    confirmText: options.confirmText || "Aceptar",
    cancelText: options.cancelText || "Cancelar",
    tone: options.tone || "warn",
  });
}

function uiPrompt(message, defaultValue = "", options = {}) {
  return uiDialog({
    mode: "prompt",
    title: options.title || "Captura de datos",
    message,
    defaultValue,
    confirmText: options.confirmText || "Guardar",
    cancelText: options.cancelText || "Cancelar",
    tone: options.tone || "ok",
  });
}

function canAccessView(view) {
  return state.auth.allowedViews.includes(view);
}

function defaultView() {
  const preferredViews = ["editor", "consulta", "dosificador", "inventario", "laboratorio", "flotilla", "remisiones", "usuarios"];
  const firstAllowed = preferredViews.find((view) => canAccessView(view));
  if (firstAllowed) return firstAllowed;
  return "consulta";
}

function applyRoleAccessUi() {
  tabEditor.style.display = canAccessView("editor") ? "" : "none";
  tabConsulta.style.display = canAccessView("consulta") ? "" : "none";
  tabDosificador.style.display = canAccessView("dosificador") ? "" : "none";
  if (tabRemisiones) tabRemisiones.style.display = canAccessView("remisiones") ? "" : "none";
  if (tabFlotilla) tabFlotilla.style.display = canAccessView("flotilla") ? "" : "none";
  if (tabInventario) tabInventario.style.display = canAccessView("inventario") ? "" : "none";
  if (tabLaboratorio) tabLaboratorio.style.display = canAccessView("laboratorio") ? "" : "none";
  if (tabUsuarios) tabUsuarios.style.display = state.auth.role === "administrador" ? "" : "none";
  if (auditBtn) auditBtn.style.display = state.auth.canEdit ? "" : "none";
  if (backupCreateBtn) backupCreateBtn.style.display = state.auth.canEdit ? "" : "none";
  if (backupRestoreBtn) backupRestoreBtn.style.display = state.auth.role === "administrador" ? "" : "none";
  const clearKardexBtn = document.getElementById("clearKardexBtn");
  if (clearKardexBtn) clearKardexBtn.style.display = state.auth.role === "administrador" ? "" : "none";
  if (saveQcHumidityBtn) {
    saveQcHumidityBtn.style.display = state.auth.canEditQcHumidity ? "" : "none";
  }
  const toleranceEditable = canEditDoserTolerances();
  [tolCementoInput, tolAgregadosInput, tolAguaInput, tolAditivoInput].forEach((input) => {
    if (!input) return;
    input.disabled = !toleranceEditable;
    input.classList.toggle("is-locked", !toleranceEditable);
  });
  [
    paramCementoPespInput,
    paramAirePctInput,
    paramPasa200PctInput,
    paramPxlPctInput,
    paramDensidadAggInput,
  ].forEach((input) => {
    if (!input) return;
    input.disabled = !toleranceEditable;
    input.classList.toggle("is-locked", !toleranceEditable);
  });
  if (saveDoserParamsBtn) {
    saveDoserParamsBtn.style.display = canAccessView("dosificador") ? "" : "none";
    saveDoserParamsBtn.disabled = !toleranceEditable;
  }
  if (tolAccessNote) {
    tolAccessNote.textContent = toleranceEditable
      ? "Ajustables por tipo de material (editable por administrador y jefe-de-planta)"
      : "Solo administrador y jefe-de-planta pueden editar tolerancias.";
  }
}

function refreshSaveState() {
  const hasChanges = state.dirty || state.qcDirty;
  saveState.textContent = hasChanges ? "Cambios sin guardar" : "Sin cambios";
  saveState.style.color = hasChanges ? "#b67712" : "#4b627a";
}

function setDirty(value) {
  state.dirty = value;
  refreshSaveState();
}

function setQcDirty(value) {
  state.qcDirty = value;
  refreshSaveState();
}

function setConsultaStep(step) {
  if (!consultaSlides.length) return;
  const maxStep = consultaSlides.length - 1;
  const normalizedStep = Math.max(0, Math.min(maxStep, Number(step) || 0));
  state.consultaStep = normalizedStep;

  consultaSlides.forEach((slide, index) => {
    slide.classList.toggle("is-active", index === normalizedStep);
  });

  if (consultaStepLabel) {
    consultaStepLabel.textContent = `Paso ${normalizedStep + 1} de ${maxStep + 1}`;
  }
  if (consultaPrevBtn) consultaPrevBtn.disabled = normalizedStep === 0;
  if (consultaNextBtn) consultaNextBtn.disabled = normalizedStep === maxStep;
}

function switchView(view) {
  if (!canAccessView(view)) {
    setStatus("No tienes permisos para acceder a esta pestaña.", "warn");
    return;
  }
  state.view = view;
  const isEditor = view === "editor";
  const isConsulta = view === "consulta";
  const isDoser = view === "dosificador";
  const isRemisiones = view === "remisiones";
  const isFleet = view === "flotilla";
  const isInv = view === "inventario";
  const isLab = view === "laboratorio";
  const isUsers = view === "usuarios";
  editorView.classList.toggle("is-hidden", !isEditor);
  consultaView.classList.toggle("is-hidden", !isConsulta);
  dosificadorView.classList.toggle("is-hidden", !isDoser);
  if (remisionesView) remisionesView.classList.toggle("is-hidden", !isRemisiones);
  if (flotillaView) flotillaView.classList.toggle("is-hidden", !isFleet);
  if (inventarioView) inventarioView.classList.toggle("is-hidden", !isInv);
  if (laboratorioView) laboratorioView.classList.toggle("is-hidden", !isLab);
  if (usuariosView) usuariosView.classList.toggle("is-hidden", !isUsers);
  tabEditor.classList.toggle("view-tab--active", isEditor);
  tabConsulta.classList.toggle("view-tab--active", isConsulta);
  tabDosificador.classList.toggle("view-tab--active", isDoser);
  if (tabRemisiones) tabRemisiones.classList.toggle("view-tab--active", isRemisiones);
  if (tabFlotilla) tabFlotilla.classList.toggle("view-tab--active", isFleet);
  if (tabInventario) tabInventario.classList.toggle("view-tab--active", isInv);
  if (tabLaboratorio) tabLaboratorio.classList.toggle("view-tab--active", isLab);
  if (tabUsuarios) tabUsuarios.classList.toggle("view-tab--active", isUsers);
  if (isConsulta) {
    setConsultaStep(state.consultaStep);
    fetchFamiliesSummary().then(() => renderFamiliesBoard());
  }
  if (isDoser) {
    renderDosificador();
    loadRemisiones();
    loadGlobalRecipes();
  }
  if (isRemisiones) {
    ensureRemisionesFilters();
    loadRemisionesView();
  }
  if (isFleet) loadFleetData();
  if (isInv && typeof window.loadInventoryData === "function") window.loadInventoryData();
  if (isLab && typeof window.loadQcLabData === "function") window.loadQcLabData();
  if (isUsers && typeof window.AppUsers !== "undefined" && typeof window.AppUsers.loadUsers === "function") window.AppUsers.loadUsers();
}

function compareValues(a, b) {
  const numA = Number(a);
  const numB = Number(b);
  const aIsNum = !Number.isNaN(numA) && normalize(a) !== "";
  const bIsNum = !Number.isNaN(numB) && normalize(b) !== "";
  if (aIsNum && bIsNum) return numA - numB;
  return a.toString().localeCompare(b.toString(), "es", { sensitivity: "base", numeric: true });
}

function getProcessedRows() {
  const term = normalize(state.searchText);
  let mapped = state.rows.map((row, sourceIndex) => ({ row, sourceIndex }));

  if (term) {
    mapped = mapped.filter((entry) => entry.row.some((cell) => normalize(cell).includes(term)));
  }

  if (state.sort.col !== null) {
    const { col, dir } = state.sort;
    mapped.sort((a, b) => {
      const result = compareValues(a.row[col] ?? "", b.row[col] ?? "");
      return dir === "asc" ? result : -result;
    });
  }
  return mapped;
}

function renderMeta(filteredCount) {
  const base = `Archivo: ${state.file} | Filas: ${state.rows.length} | Mostradas: ${filteredCount} | Columnas: ${state.headers.length}`;
  const fam = state.datasetFamily || "-";
  const details = ` | Familia: ${fam} | Encoding: ${state.encoding} | Delimitador: ${state.delimiter === "\t" ? "\\t" : state.delimiter}`;
  metaInfo.textContent = base + details;
}

function getFileFamilyByName(fileName) {
  const item = state.fileInfos.find((info) => info.name === fileName);
  return item ? (item.family || "") : "";
}

function renderFileSelect() {
  fileSelect.innerHTML = "";
  const infos = state.fileInfos.length
    ? state.fileInfos
    : state.files.map((name) => ({ name, family: "" }));
  infos.forEach((info) => {
    const fileName = info.name;
    const family = info.family || "";
    const option = document.createElement("option");
    option.value = fileName;
    option.textContent = family ? `${fileName} | Familia ${family}` : fileName;
    option.selected = fileName === state.file;
    fileSelect.appendChild(option);
  });
}

function splitHeaderName(headerText) {
  const raw = (headerText ?? "").toString().trim();
  const match = raw.match(/^(.*?)(?:\s*\(([^()]*)\))?$/);
  if (!match) return { name: raw, type: "" };
  return {
    name: (match[1] || "").trim(),
    type: (match[2] || "").trim(),
  };
}

async function renameHeader(colIndex) {
  const modColIndex = getModDateColIndex();
  if (colIndex === modColIndex) {
    setStatus("La columna FECHA_MODIF es automatica y no se puede renombrar.", "warn");
    return;
  }
  const currentHeader = state.headers[colIndex] ?? "";
  const parsed = splitHeaderName(currentHeader);
  const newName = await uiPrompt("Nombre de la columna", parsed.name || currentHeader, {
    title: "Editar encabezado",
    confirmText: "Continuar",
  });
  if (newName === null) return;
  if (!newName.trim()) {
    setStatus("El nombre de la columna no puede quedar vacio.", "warn");
    return;
  }
  const newType = await uiPrompt(
    "Tipo (opcional). Si lo llenas se guardara como: Nombre (Tipo)",
    parsed.type,
    {
      title: "Tipo de columna",
      confirmText: "Aplicar",
    }
  );
  if (newType === null) return;
  state.headers[colIndex] = newType.trim() ? `${newName.trim()} (${newType.trim()})` : newName.trim();
  setDirty(true);
  refreshConsulta();
  setStatus(`Encabezado actualizado: ${state.headers[colIndex]}`, "ok");
  render();
}

function buildHeader() {
  tableHead.innerHTML = "";
  const tr = document.createElement("tr");
  const selTh = document.createElement("th");
  const allCheck = document.createElement("input");
  allCheck.type = "checkbox";
  allCheck.title = "Seleccionar filas visibles";
  allCheck.addEventListener("change", (event) => {
    const visibleRows = getProcessedRows().map((entry) => entry.sourceIndex);
    if (event.target.checked) visibleRows.forEach((idx) => state.selected.add(idx));
    else visibleRows.forEach((idx) => state.selected.delete(idx));
    renderBody();
  });
  selTh.appendChild(allCheck);
  tr.appendChild(selTh);

  const modColIndex = getModDateColIndex();
  state.headers.forEach((header, index) => {
    const th = document.createElement("th");
    const wrap = document.createElement("div");
    wrap.className = "th-wrap";

    const button = document.createElement("button");
    button.className = "th-btn";
    button.textContent = header === "" ? `Columna ${index + 1}` : header;
    if (state.sort.col === index) button.dataset.dir = state.sort.dir;
    button.addEventListener("click", () => {
      if (state.sort.col === index) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else state.sort = { col: index, dir: "asc" };
      render();
    });

    const editButton = document.createElement("button");
    editButton.className = "th-edit";
    editButton.textContent = "Editar";
    editButton.title = "Editar nombre de columna";
    editButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await renameHeader(index);
    });
    if (index === modColIndex) {
      editButton.disabled = true;
      editButton.title = "Columna automatica";
    }

    wrap.appendChild(button);
    wrap.appendChild(editButton);
    th.appendChild(wrap);
    tr.appendChild(th);
  });

  tableHead.appendChild(tr);
}

function renderBody() {
  tableBody.innerHTML = "";
  const rows = getProcessedRows();
  renderMeta(rows.length);

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = state.headers.length + 1;
    td.textContent = "No hay filas para mostrar con el filtro actual.";
    tr.appendChild(td);
    tableBody.appendChild(tr);
    return;
  }

  const modColIndex = getModDateColIndex();
  rows.forEach((entry) => {
    const tr = document.createElement("tr");
    const selectTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(entry.sourceIndex);
    checkbox.addEventListener("change", (event) => {
      if (event.target.checked) state.selected.add(entry.sourceIndex);
      else state.selected.delete(entry.sourceIndex);
    });
    selectTd.appendChild(checkbox);
    tr.appendChild(selectTd);

    state.headers.forEach((_, colIndex) => {
      const td = document.createElement("td");
      td.className = "cell";
      const isModDate = colIndex === modColIndex;
      td.contentEditable = isModDate ? "false" : "true";
      if (isModDate) td.classList.add("cell-readonly");
      td.spellcheck = false;
      td.textContent = entry.row[colIndex] ?? "";
      td.dataset.row = String(entry.sourceIndex);
      td.dataset.col = String(colIndex);
      if (!isModDate) {
        td.addEventListener("input", (event) => {
          const cell = event.currentTarget;
          const rowIndex = Number(cell.dataset.row);
          const fieldIndex = Number(cell.dataset.col);
          state.rows[rowIndex][fieldIndex] = cell.textContent ?? "";
          setRowModifiedDate(rowIndex);
          setDirty(true);
          const rowTr = cell.parentElement;
          const dateCell = rowTr && rowTr.children[modColIndex + 1];
          if (dateCell) {
            dateCell.textContent = state.rows[rowIndex][modColIndex] ?? "";
          }
        });
      }
      tr.appendChild(td);
    });

    tableBody.appendChild(tr);
  });
}

function render() {
  buildHeader();
  renderBody();
}

function buildHeaderIndex() {
  const idx = {};
  state.headers.forEach((header, i) => {
    const key = normalizeHeader(splitHeaderName(header).name || header);
    if (key === "no") idx.no = i;
    else if (key === "formula") idx.formula = i;
    else if (key === "cod") idx.cod = i;
    else if (key === "fc") idx.fc = i;
    else if (key === "edad") idx.edad = i;
    else if (key === "coloc" || key === "tipo") idx.tipo = i;
    else if (key === "tma") idx.tma = i;
    else if (key === "rev") idx.rev = i;
    else if (key === "var" || key === "comp" || key === "complemento") idx.comp = i;
    else if (key === "familia" || key === "family" || key.startsWith("familia") || key.startsWith("family")) idx.family = i;
  });
  state.index = idx;
}

function valueByKey(row, key) {
  const idx = state.index[key];
  if (typeof idx !== "number") return "";
  return (row[idx] ?? "").toString().trim();
}

function getRowModDate(row) {
  const modIdx = getModDateColIndex();
  if (modIdx < 0) return "";
  return (row[modIdx] ?? "").toString().trim();
}

function deriveFamily(row) {
  const explicitFamily = valueByKey(row, "family");
  if (explicitFamily) return explicitFamily;
  if (state.datasetFamily) return state.datasetFamily;
  const formula = valueByKey(row, "formula");
  const no = valueByKey(row, "no");
  const cod = valueByKey(row, "cod");
  if (formula) {
    const start = formula.match(/^(\d{2,3})/);
    if (start) return start[1];
    const any = formula.match(/(\d{2,3})/);
    if (any) return any[1];
    const token = formula.split(/[-\s]/)[0];
    if (token) return token;
  }
  return no || cod || "-";
}

function getUniqueValues(columnKey) {
  const idx = state.index[columnKey];
  if (typeof idx !== "number") return [];
  const set = new Set();
  state.rows.forEach((row) => {
    const value = (row[idx] ?? "").toString().trim();
    if (value !== "") set.add(value);
  });
  return [...set].sort((a, b) => compareValues(a, b));
}

function getUniqueValuesByIndex(index) {
  if (typeof index !== "number") return [];
  const set = new Set();
  state.rows.forEach((row) => {
    const value = (row[index] ?? "").toString().trim();
    if (value !== "") set.add(value);
  });
  return [...set].sort((a, b) => compareValues(a, b));
}

function fillSelect(selectEl, values, keepValue = "") {
  const current = keepValue || selectEl.value || "";
  selectEl.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Todos";
  selectEl.appendChild(all);
  values.forEach((v) => {
    const op = document.createElement("option");
    op.value = v;
    op.textContent = v;
    if (v === current) op.selected = true;
    selectEl.appendChild(op);
  });
}

async function fetchFamiliesSummary() {
  try {
    const resp = await apiFetch("/api/families/summary");
    const res = await resp.json();
    if (res.ok) {
      state.doser.familiesSummary = res.summary || [];
    }
  } catch (err) {
    console.error("Error fetching families summary:", err);
  }
}

function renderFamiliesBoard() {
  const board = document.getElementById("familiasBoard");
  if (!board) return;
  board.innerHTML = "";

  const summary = state.doser.familiesSummary || [];
  if (summary.length === 0) {
    board.textContent = "Cargando familias globalmente...";
    fetchFamiliesSummary().then(() => renderFamiliesBoard());
    return;
  }

  // Agrupar por FAMILIA ahora
  const groups = new Map();
  summary.forEach(item => {
    if (!groups.has(item.family)) groups.set(item.family, []);
    groups.get(item.family).push(item);
  });

  [...groups.entries()]
    .sort((a, b) => compareValues(a[0], b[0]))
    .forEach(([family, tmaItems]) => {
      const card = document.createElement("div");
      card.className = "family-col";
      // Seleccionar el archivo del primer item para esta familia
      const targetFile = tmaItems[0]?.file;

      const h3 = document.createElement("h3");
      h3.textContent = `Familia ${family}`;
      const ul = document.createElement("ul");

      tmaItems.sort((a, b) => compareValues(a.tma, b.tma))
        .forEach(item => {
          const li = document.createElement("li");
          li.innerHTML = `<span class="family-link">T.M.A. ${item.tma}</span> <span class="meta">(${item.count})</span>`;
          ul.appendChild(li);
        });

      card.addEventListener("click", async () => {
        if (!targetFile) return;
        if (state.file !== targetFile) {
          setStatus(`Cargando familia ${family}...`, "info");
          try {
            const resp = await apiFetch("/api/select", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ file: targetFile })
            });
            const res = await resp.json();
            if (res.ok) {
              await loadData();
              const qFamily = document.getElementById("qFamily");
              const qTma = document.getElementById("qTma");
              if (qFamily) qFamily.value = family;
              if (qTma) qTma.value = ""; // No filtrar por TMA
              runQuery();
            }
          } catch (err) {
            setStatus("Error al cargar familia: " + err.message, "err");
          }
        } else {
          const qFamily = document.getElementById("qFamily");
          const qTma = document.getElementById("qTma");
          if (qFamily) qFamily.value = family;
          if (qTma) qTma.value = ""; // No filtrar por TMA
          runQuery();
        }
      });

      card.appendChild(h3);
      card.appendChild(ul);
      board.appendChild(card);
    });
}

function getMetaIndexes() {
  const set = new Set(Object.values(state.index).filter((v) => typeof v === "number"));
  const modIndex = getModDateColIndex();
  if (modIndex >= 0) set.add(modIndex);
  return set;
}

function buildAggregateColumnMap() {
  const counters = { fino: 0, grueso: 0 };
  const metaIndexes = getMetaIndexes();
  const map = {
    "Fino 1": new Set(),
    "Fino 2": new Set(),
    "Grueso 1": new Set(),
    "Grueso 2": new Set(),
  };

  state.headers.forEach((header, index) => {
    if (metaIndexes.has(index)) return;
    const rawHeader = (header ?? "").toString().trim();
    if (!rawHeader) return;
    const component = classifyComponent(rawHeader, counters);
    if (map[component]) map[component].add(rawHeader);
  });

  return {
    "Fino 1": [...map["Fino 1"]],
    "Fino 2": [...map["Fino 2"]],
    "Grueso 1": [...map["Grueso 1"]],
    "Grueso 2": [...map["Grueso 2"]],
  };
}

function reportComponentLabel(componentName, aggregateMap) {
  const displayName =
    componentName === "Grueso 1" ? "Grava 1" : componentName === "Grueso 2" ? "Grava 2" : componentName;
  if (!isAggregateComponent(componentName)) return displayName;
  const raw = (aggregateMap && aggregateMap[componentName]) || [];
  const details = [...new Set(raw.map((h) => splitHeaderName(h).name || h).map((s) => (s || "").trim()).filter(Boolean))];
  if (!details.length) return displayName;
  return `${displayName} (${details.join(" + ")})`;
}

function classifyComponent(headerText, counters) {
  const parsed = splitHeaderName(headerText);
  const name = parsed.name || headerText;
  const nName = normalize(name);
  const nType = normalize(parsed.type);

  if (nName.includes("fcpc") || nName.includes("cement")) return "Cemento";
  if (nName.includes("agua")) return "Agua";
  if (nName.includes("reductor")) return "Reductor";
  if (nName.includes("retard")) return "Retardante";
  if (nName.includes("fibra")) return "Fibra";
  if (nName.includes("imper")) return "Imper";

  // Soporte para nombres normalizados (sin espacios ni parentesis)
  if (nName === "fino1" || nName === "arena1") return "Fino 1";
  if (nName === "fino2" || nName === "arena2") return "Fino 2";
  if (nName === "grueso1" || nName === "grava1" || nName === "nava20") return "Grueso 1";
  if (nName === "grueso2" || nName === "grava2" || nName === "nava5") return "Grueso 2";

  if (nType.includes("grava 1") || nType.includes("grueso 1")) return "Grueso 1";
  if (nType.includes("grava 2") || nType.includes("grueso 2")) return "Grueso 2";
  if (nType.includes("fino 1") || nType.includes("arena 1")) return "Fino 1";
  if (nType.includes("fino 2") || nType.includes("arena 2")) return "Fino 2";

  if (nType.includes("grava") || nType.includes("grueso")) {
    counters.grueso += 1;
    return counters.grueso === 1 ? "Grueso 1" : "Grueso 2";
  }
  if (nType.includes("fino") || nType.includes("arena")) {
    counters.fino += 1;
    return counters.fino === 1 ? "Fino 1" : "Fino 2";
  }

  if (nName.includes("lavada") || nName.includes("arena")) return "Fino 1";

  return name || "Otro";
}

function componentUnit(component) {
  if (["Agua", "Reductor", "Retardante"].includes(component)) return "Lts";
  return "kg";
}

function densityFor(component, unit) {
  if (unit === "Lts") return 1000;
  if (component === "Cemento") return 3150;
  if (component === "Fino 1" || component === "Fino 2") return 1600;
  if (component === "Grueso 1" || component === "Grueso 2") return 1500;
  if (component === "Fibra") return 900;
  return 1500;
}

function extractRecipe(row) {
  const counters = { fino: 0, grueso: 0 };
  const metaIndexes = getMetaIndexes();
  const aggregate = new Map();
  const isGlobal = !Array.isArray(row);

  if (isGlobal) {
    // Si es un objeto global de recipes_global
    const EXCLUDE = ["formula", "no", "cod", "fc", "edad", "tipo", "tma", "rev", "comp", "family", "source", "updated", "id", "dataset_id"];
    Object.keys(row).forEach(header => {
      if (header.startsWith("_")) return; // saltar meta-campos
      if (EXCLUDE.includes(header.toLowerCase())) return;

      const qty = toNumber(row[header]);
      if (qty === 0) return;
      const component = classifyComponent(header, counters);
      aggregate.set(component, (aggregate.get(component) || 0) + qty);
    });
  } else {
    // Si es un arreglo local de state.rows
    state.headers.forEach((header, index) => {
      if (metaIndexes.has(index)) return;
      const rawHeader = (header ?? "").toString().trim();
      if (rawHeader === "") return;
      const qty = toNumber(row[index]);
      if (qty === 0) return;
      const component = classifyComponent(rawHeader, counters);
      aggregate.set(component, (aggregate.get(component) || 0) + qty);
    });
  }

  // Mostrar siempre los agregados principales en Receta/Costos, aun cuando su valor sea 0.
  ["Fino 1", "Fino 2", "Grueso 1", "Grueso 2"].forEach((aggName) => {
    if (!aggregate.has(aggName)) aggregate.set(aggName, 0);
  });

  const priority = [
    "Cemento",
    "Fino 1",
    "Fino 2",
    "Grueso 1",
    "Grueso 2",
    "Agua",
    "Reductor",
    "Retardante",
    "Fibra",
    "Imper",
  ];

  const ordered = [];
  priority.forEach((name) => {
    if (aggregate.has(name)) {
      ordered.push({ name, qty: aggregate.get(name), unit: componentUnit(name) });
      aggregate.delete(name);
    }
  });
  [...aggregate.entries()]
    .sort((a, b) => compareValues(a[0], b[0]))
    .forEach(([name, qty]) => ordered.push({ name, qty, unit: componentUnit(name) }));

  const withVolume = ordered.map((item) => ({
    ...item,
    volume: isAggregateComponent(item.name) ? item.qty / (averagePV(item.name) || densityFor(item.name, item.unit)) : 0,
  }));

  return withVolume;
}

function normalizeConsultaRecipeItems(recipeItems) {
  return recipeItems.map((item) => {
    if (!["Reductor", "Retardante", "Fibra", "Imper"].includes(item.name)) return item;

    // Si son Reductor o Retardante, asumimos que el CSV viene en gramos/cc y lo pasamos a litros
    // Si son Imper o Fibra, asumimos que el CSV viene en gramos y lo pasamos a kilos
    const isLiquid = ["Reductor", "Retardante"].includes(item.name);
    const qty = item.qty / 1000;

    return {
      ...item,
      qty,
      unit: isLiquid ? "cc/kg-cto" : "kg",
      volume: isLiquid ? qty / 1000 : 0,
    };
  });
}

function normalizeDoserRecipeItems(recipeItems) {
  return recipeItems.map((item) => {
    if (!["Reductor", "Retardante", "Fibra", "Imper"].includes(item.name)) return item;

    const isLiquid = ["Reductor", "Retardante"].includes(item.name);
    const qty = item.qty / 1000;

    return {
      ...item,
      qty,
      unit: isLiquid ? "Lts/m3" : "kg",
      volume: isLiquid ? qty / 1000 : 0,
    };
  });
}

function renderRecipeAndCosts(row) {
  if (!row) {
    recipeMeta.textContent = "Selecciona una formula de la tabla de resultados.";
    recipeBody.innerHTML = "";
    recipeWeight.textContent = "0.00";
    costBody.innerHTML = "";
    if (costHaulTotal) costHaulTotal.textContent = "$0.00";
    if (costMaterialTotal) costMaterialTotal.textContent = "$0.00";
    costTotal.textContent = "$0.00";
    return;
  }

  const formula = valueByKey(row, "formula");
  const fc = valueByKey(row, "fc");
  const edad = valueByKey(row, "edad");
  const tipo = valueByKey(row, "tipo");
  const tma = valueByKey(row, "tma");
  const rev = valueByKey(row, "rev");
  const comp = valueByKey(row, "comp");
  const modDate = getRowModDate(row);
  const qcDate = state.qcUpdatedAt || "-";

  recipeMeta.textContent = `Formula: ${formula || "-"} | f'c: ${fc || "-"} | Edad: ${edad || "-"} | Tipo: ${tipo || "-"
    } | TMA: ${tma || "-"} | Rev: ${rev || "-"} | Comp: ${comp || "-"} | Fecha Modif: ${modDate || "-"
    } | QC: ${qcDate}`;

  const recipeItems = normalizeConsultaRecipeItems(extractRecipe(row));
  recipeBody.innerHTML = "";
  let totalWeight = 0;

  recipeItems.forEach((item) => {
    totalWeight += item.qty;
    const volText = isAggregateComponent(item.name) ? formatVol(item.volume) : "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(formatNum(item.qty))}</td>
      <td>${escapeHtml(item.unit)}</td>
      <td>${escapeHtml(volText)}</td>
    `;
    recipeBody.appendChild(tr);
  });

  recipeWeight.textContent = formatNum(totalWeight);
  const adjustedForCost = adjustRecipeByQuality(recipeItems, 1);
  renderCostTable(adjustedForCost);
}

function averagePV(componentName) {
  if (!isAggregateComponent(componentName)) return null;
  const q = getQualityFor(componentName);
  const pvs = toNumber(q.pvs);
  const pvc = toNumber(q.pvc);
  if (pvs > 0 && pvc > 0) return (pvs + pvc) / 2;
  if (pvs > 0) {
    console.warn(`[QC] ${componentName}: PVC es 0, usando solo PVS (${pvs})`);
    return pvs;
  }
  if (pvc > 0) {
    console.warn(`[QC] ${componentName}: PVS es 0, usando solo PVC (${pvc})`);
    return pvc;
  }
  return null;
}

function volumetricWeightForCost(item) {
  if (!isAggregateComponent(item.name)) return densityFor(item.name, item.unit);
  return averagePV(item.name) || densityFor(item.name, "kg");
}

function volumeM3ForCost(item) {
  if (!isAggregateComponent(item.name)) return 0;
  const pv = volumetricWeightForCost(item);
  return pv > 0 ? item.qty / pv : 0;
}

function subtotalForCost(item) {
  const unitCost = state.unitCosts[item.name] || 0;
  if (!isAggregateComponent(item.name)) return unitCost * item.qty;
  const haulCost = state.haulCosts[item.name] || 0;
  const m3 = volumeM3ForCost(item);
  return m3 * (unitCost + haulCost);
}

function materialSubtotalForCost(item) {
  const unitCost = state.unitCosts[item.name] || 0;
  if (!isAggregateComponent(item.name)) return unitCost * item.qty;
  const m3 = volumeM3ForCost(item);
  return m3 * unitCost;
}

function haulSubtotalForCost(item) {
  if (!isAggregateComponent(item.name)) return 0;
  const haulCost = state.haulCosts[item.name] || 0;
  const m3 = volumeM3ForCost(item);
  return m3 * haulCost;
}

function updateCostTotals(recipeItems) {
  const haulTotal = recipeItems.reduce((acc, item) => acc + haulSubtotalForCost(item), 0);
  const materialTotal = recipeItems.reduce((acc, item) => acc + materialSubtotalForCost(item), 0);
  const total = materialTotal + haulTotal;
  if (costHaulTotal) costHaulTotal.textContent = formatMoney(haulTotal);
  if (costMaterialTotal) costMaterialTotal.textContent = formatMoney(materialTotal);
  costTotal.textContent = formatMoney(total);
}

function getAggregateLabel(componentName) {
  if (!isAggregateComponent(componentName)) return "";
  const aggregateMap = buildAggregateColumnMap();
  const raw = (aggregateMap && aggregateMap[componentName]) || [];
  const details = [...new Set(raw.map((h) => splitHeaderName(h).name || h).map((s) => (s || "").trim()).filter(Boolean))];
  return details.length ? details.join(" + ") : "";
}

function getQuoteOverride(componentName) {
  return state.quoteOverrides[componentName] || null;
}

function effectiveQty(item) {
  if (state.quoteMode) {
    const ov = getQuoteOverride(item.name);
    if (ov && typeof ov.qty === "number") return ov.qty;
  }
  return item.qty;
}

function effectivePV(componentName) {
  if (state.quoteMode) {
    const ov = getQuoteOverride(componentName);
    if (ov && typeof ov.pv === "number" && ov.pv > 0) return ov.pv;
  }
  return averagePV(componentName);
}

function renderCostTable(recipeItems) {
  costBody.innerHTML = "";
  const aggregateMap = buildAggregateColumnMap();
  recipeItems.forEach((item) => {
    const tr = document.createElement("tr");
    const isAgg = isAggregateComponent(item.name);
    const ov = state.quoteMode ? (state.quoteOverrides[item.name] || {}) : {};
    const qty = effectiveQty(item);
    const unitCost = state.unitCosts[item.name] || 0;
    const haulCost = state.haulCosts[item.name] || 0;
    const pvValue = isAgg ? (effectivePV(item.name) || densityFor(item.name, "kg")) : densityFor(item.name, item.unit);
    const m3 = isAgg && pvValue > 0 ? qty / pvValue : 0;
    const subtotal = isAgg ? m3 * (unitCost + haulCost) : unitCost * qty;

    // Material label
    const materialLabel = isAgg ? (ov.material || getAggregateLabel(item.name) || "-") : "-";
    const materialCell = state.quoteMode && isAgg
      ? `<input class="quote-input quote-material" type="text" value="${escapeHtml(materialLabel)}" placeholder="Nombre material">`
      : escapeHtml(materialLabel);

    // Qty cell
    const qtyCell = state.quoteMode
      ? `<input class="quote-input quote-qty" type="number" min="0" step="0.01" value="${qty.toFixed(2)}">`
      : escapeHtml(formatNum(qty));

    // PV cell
    const pvDisplay = isAgg ? pvValue.toFixed(0) : "-";
    const pvCell = state.quoteMode && isAgg
      ? `<input class="quote-input quote-pv" type="number" min="0" step="1" value="${pvValue.toFixed(0)}" placeholder="PV">`
      : pvDisplay;

    const m3Text = isAgg ? formatVol(m3) : "-";
    const haulCell = isAgg
      ? `<div class="money-field"><span class="money-field__symbol">$</span><input class="haul-input" type="number" min="0" step="0.01" value="${haulCost.toFixed(
        2
      )}" title="Costo de transporte por m³ del agregado (del banco a la planta)" aria-label="Acarreo por m³"></div>`
      : "-";
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${materialCell}</td>
      <td>${qtyCell}</td>
      <td class="num">${pvCell}</td>
      <td>${escapeHtml(m3Text)}</td>
      <td>${escapeHtml(item.unit)}</td>
      <td>${haulCell}</td>
      <td><div class="money-field"><span class="money-field__symbol">$</span><input class="cost-input" type="number" min="0" step="0.01" value="${unitCost.toFixed(2)}"></div></td>
      <td class="cost-sub">${escapeHtml(formatMoney(subtotal))}</td>
    `;

    const costInput = tr.querySelector(".cost-input");
    const haulInput = tr.querySelector(".haul-input");
    const subCell = tr.querySelector(".cost-sub");

    const recalcRow = () => {
      const q = effectiveQty(item);
      const pv = isAgg ? (effectivePV(item.name) || densityFor(item.name, "kg")) : densityFor(item.name, item.unit);
      const uc = state.unitCosts[item.name] || 0;
      const hc = state.haulCosts[item.name] || 0;
      const mv = isAgg && pv > 0 ? q / pv : 0;
      const st = isAgg ? mv * (uc + hc) : uc * q;
      const pvTd = tr.querySelector(".num");
      const m3Td = tr.children[4];
      const qtyTd = tr.children[2];
      if (pvTd && !state.quoteMode) pvTd.textContent = isAgg ? pv.toFixed(0) : "-";
      if (m3Td) m3Td.textContent = isAgg ? formatVol(mv) : "-";
      subCell.textContent = formatMoney(st);
      updateCostTotals(recipeItems);
    };

    costInput.addEventListener("input", () => {
      state.unitCosts[item.name] = toNumber(costInput.value);
      recalcRow();
    });
    if (haulInput) {
      haulInput.addEventListener("input", () => {
        state.haulCosts[item.name] = toNumber(haulInput.value);
        recalcRow();
      });
    } else {
      state.haulCosts[item.name] = 0;
    }

    // Quote mode editable fields
    if (state.quoteMode) {
      const matInput = tr.querySelector(".quote-material");
      const qtyInput = tr.querySelector(".quote-qty");
      const pvInput = tr.querySelector(".quote-pv");
      if (matInput) {
        matInput.addEventListener("input", () => {
          if (!state.quoteOverrides[item.name]) state.quoteOverrides[item.name] = {};
          state.quoteOverrides[item.name].material = matInput.value;
        });
      }
      if (qtyInput) {
        qtyInput.addEventListener("input", () => {
          if (!state.quoteOverrides[item.name]) state.quoteOverrides[item.name] = {};
          state.quoteOverrides[item.name].qty = toNumber(qtyInput.value);
          recalcRow();
        });
      }
      if (pvInput) {
        pvInput.addEventListener("input", () => {
          if (!state.quoteOverrides[item.name]) state.quoteOverrides[item.name] = {};
          state.quoteOverrides[item.name].pv = toNumber(pvInput.value);
          recalcRow();
        });
      }
    }

    costBody.appendChild(tr);
  });
  updateCostTotals(recipeItems);
}

function buildCostRowsForReport(recipeItems) {
  return recipeItems.map((item) => {
    const isAgg = isAggregateComponent(item.name);
    const m3 = isAgg ? volumeM3ForCost(item) : null;
    const unitCost = state.unitCosts[item.name] || 0;
    const haulCost = isAgg ? state.haulCosts[item.name] || 0 : 0;
    const subtotal = subtotalForCost(item);
    return {
      name: item.name,
      qty: item.qty,
      m3,
      unit: item.unit,
      haul: isAgg ? haulCost : null,
      haulSubtotal: isAgg && m3 !== null ? m3 * haulCost : 0,
      unitCost,
      subtotal,
    };
  });
}

function exportConsultaReport() {
  const selectedIndex = state.selectedQueryRow;
  const row = typeof selectedIndex === "number" ? state.rows[selectedIndex] : null;
  if (!row) {
    setStatus("Selecciona una mezcla en Consulta Mix para exportar el reporte.", "warn");
    return;
  }

  const formula = valueByKey(row, "formula") || "-";
  const fc = valueByKey(row, "fc") || "-";
  const edad = valueByKey(row, "edad") || "-";
  const tipo = valueByKey(row, "tipo") || "-";
  const tma = valueByKey(row, "tma") || "-";
  const rev = valueByKey(row, "rev") || "-";
  const comp = valueByKey(row, "comp") || "-";
  const modDate = getRowModDate(row) || "-";
  const qcDate = state.qcUpdatedAt || "-";
  const reportDate = nowStamp();

  const recipeItems = normalizeConsultaRecipeItems(extractRecipe(row));
  const recipeTotal = recipeItems.reduce((acc, item) => acc + item.qty, 0);
  const adjustedForCost = adjustRecipeByQuality(recipeItems, 1);
  const costRows = buildCostRowsForReport(adjustedForCost);
  const totalMaterials = adjustedForCost.reduce((acc, item) => acc + materialSubtotalForCost(item), 0);
  const totalHaul = costRows.reduce((acc, item) => acc + (item.haulSubtotal || 0), 0);
  const totalCost = totalMaterials + totalHaul;
  const aggregateMap = buildAggregateColumnMap();

  const recipeRowsHtml = recipeItems
    .map(
      (item) => {
        const componentLabel = reportComponentLabel(item.name, aggregateMap);
        const volText = isAggregateComponent(item.name) ? formatVol(item.volume) : "-";
        return `
        <tr>
          <td>${escapeHtml(componentLabel)}</td>
          <td class="num">${escapeHtml(formatNum(item.qty))}</td>
          <td>${escapeHtml(item.unit)}</td>
          <td class="num">${escapeHtml(volText)}</td>
        </tr>
      `;
      }
    )
    .join("");

  const costRowsHtml = costRows
    .map(
      (item) => {
        const componentLabel = reportComponentLabel(item.name, aggregateMap);
        const m3Text = item.m3 === null ? "-" : formatVol(item.m3);
        return `
        <tr>
          <td>${escapeHtml(componentLabel)}</td>
          <td class="num">${escapeHtml(formatNum(item.qty))}</td>
          <td class="num">${escapeHtml(m3Text)}</td>
          <td>${escapeHtml(item.unit)}</td>
          <td class="num">${item.haul === null ? "-" : escapeHtml(formatNum(item.haul))}</td>
          <td class="num">${escapeHtml(formatNum(item.unitCost))}</td>
          <td class="num">${escapeHtml(formatMoney(item.subtotal))}</td>
        </tr>
      `;
      }
    )
    .join("");


  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Reporte Mix - ${escapeHtml(formula)}</title>
  <style>
    @page { size: letter landscape; margin: 8mm; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; margin: 0; color: #1a2c3f; font-size: 11px; }
    .page { min-height: 100%; }
    .head { border-bottom: 2px solid #0b4f8a; padding-bottom: 6px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .head-brand { display: inline-flex; align-items: center; gap: 8px; }
    .head-logo { width: 46px; height: 46px; object-fit: contain; border: 1px solid #d5e1ee; border-radius: 8px; background: #fff; padding: 4px; }
    .head h1 { margin: 0; font-size: 18px; line-height: 1.1; }
    .head .brand { margin: 3px 0 0; color: #3b5572; font-size: 10.5px; font-weight: 600; }
    .head .head-meta { margin: 0; color: #3b5572; font-size: 11px; text-align: right; }
    .meta { display: grid; grid-template-columns: repeat(5, minmax(95px, 1fr)); gap: 5px; margin-bottom: 8px; }
    .meta .item { border: 1px solid #d6e0eb; border-radius: 6px; padding: 5px 6px; background: #f8fbff; }
    .meta .k { font-size: 9px; color: #4d667f; text-transform: uppercase; line-height: 1; }
    .meta .v { font-size: 11px; font-weight: 700; margin-top: 2px; line-height: 1.2; }
    .main-grid { display: grid; grid-template-columns: 36% 64%; gap: 8px; align-items: start; }
    .section { margin-top: 0; }
    .section h2 { margin: 0 0 6px; font-size: 13px; color: #0d3762; line-height: 1.1; }
    table { width: 100%; border-collapse: collapse; margin-top: 0; table-layout: fixed; }
    th, td { border: 1px solid #dce5ef; padding: 4px 5px; font-size: 10px; line-height: 1.2; }
    th { background: #edf4fb; text-align: left; }
    td.num { text-align: right; }
    .cost-table th:nth-child(1), .cost-table td:nth-child(1) { width: 22%; }
    .cost-table th:nth-child(2), .cost-table td:nth-child(2) { width: 13%; }
    .cost-table th:nth-child(3), .cost-table td:nth-child(3) { width: 10%; }
    .cost-table th:nth-child(4), .cost-table td:nth-child(4) { width: 10%; }
    .cost-table th:nth-child(5), .cost-table td:nth-child(5) { width: 12%; }
    .cost-table th:nth-child(6), .cost-table td:nth-child(6) { width: 14%; }
    .cost-table th:nth-child(7), .cost-table td:nth-child(7) { width: 19%; }
    .totals { margin-top: 6px; text-align: right; font-size: 13px; font-weight: 800; color: #123b66; }
    .totals-sub { margin-top: 4px; text-align: right; font-size: 12px; font-weight: 700; color: #1f4e7b; }
    .sign { margin-top: 10px; border-top: 1px solid #d3dfec; padding-top: 6px; text-align: center; color: #264767; font-weight: 700; font-size: 11px; }
    @media print {
      html, body { width: 100%; height: 100%; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .page { break-inside: avoid; }
      .section { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <div class="head-brand">
        <img class="head-logo" src="${escapeHtml(BRAND_LOGO_URL)}" alt="ALMEX">
        <div>
          <h1>Reporte de Consulta Mix</h1>
          <p class="brand">ALMEX</p>
        </div>
      </div>
      <p class="head-meta">Generado: ${escapeHtml(reportDate)} | Archivo: ${escapeHtml(state.file || "-")}</p>
    </div>

    <div class="meta">
      <div class="item"><div class="k">Formula</div><div class="v">${escapeHtml(formula)}</div></div>
      <div class="item"><div class="k">f'c</div><div class="v">${escapeHtml(fc)}</div></div>
      <div class="item"><div class="k">Edad</div><div class="v">${escapeHtml(edad)}</div></div>
      <div class="item"><div class="k">Tipo</div><div class="v">${escapeHtml(tipo)}</div></div>
      <div class="item"><div class="k">TMA</div><div class="v">${escapeHtml(tma)}</div></div>
      <div class="item"><div class="k">Rev</div><div class="v">${escapeHtml(rev)}</div></div>
      <div class="item"><div class="k">Comp</div><div class="v">${escapeHtml(comp)}</div></div>
      <div class="item"><div class="k">Fecha Modif</div><div class="v">${escapeHtml(modDate)}</div></div>
      <div class="item"><div class="k">QC</div><div class="v">${escapeHtml(qcDate)}</div></div>
      <div class="item"><div class="k">Sub-Total Acarreo m³</div><div class="v">${escapeHtml(formatMoney(totalHaul))}</div></div>
      <div class="item"><div class="k">Sub-Total Materiales m³</div><div class="v">${escapeHtml(formatMoney(totalMaterials))}</div></div>
      <div class="item"><div class="k">Total por m³</div><div class="v">${escapeHtml(formatMoney(totalCost))}</div></div>
    </div>

    <section class="main-grid">
      <article class="section">
        <h2>Receta</h2>
        <table>
          <thead>
            <tr>
              <th>Componente</th>
              <th>Cantidad</th>
              <th>Unidad</th>
              <th>Vol. Est. m³</th>
            </tr>
          </thead>
          <tbody>${recipeRowsHtml}</tbody>
        </table>
        <div class="totals">Peso por m³: ${escapeHtml(formatNum(recipeTotal))}</div>
      </article>

      <article class="section">
        <h2>Costos por m³</h2>
        <table class="cost-table">
          <thead>
            <tr>
              <th>Componente</th>
              <th>Cant. Final</th>
              <th>m³</th>
              <th>U.M.</th>
              <th>Acarreo ($)</th>
              <th>Costo Unit. ($)</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>${costRowsHtml}</tbody>
        </table>
        <div class="totals-sub">Sub-Total acarreo m³: ${escapeHtml(formatMoney(totalHaul))}</div>
        <div class="totals-sub">Sub-Total materiales m³: ${escapeHtml(formatMoney(totalMaterials))}</div>
        <div class="totals">Total por m³: ${escapeHtml(formatMoney(totalCost))}</div>
      </article>
    </section>

    <div class="sign">ForMix by Labsico - Dise&#241;a-Dosifica-Calcula</div>
  </div>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    setStatus("El navegador bloqueo la ventana del reporte. Habilita pop-ups e intenta de nuevo.", "warn");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  setStatus("Reporte generado. Usa Imprimir para guardarlo en PDF.", "ok");
}

function buildDoserReportSnapshot() {
  state.doser.tolerances.cemento = toNumber(tolCementoInput.value || "1");
  state.doser.tolerances.agregados = toNumber(tolAgregadosInput.value || "3");
  state.doser.tolerances.agua = toNumber(tolAguaInput.value || "2");
  state.doser.tolerances.aditivo = toNumber(tolAditivoInput.value || "1");
  const dose = Math.max(0, toNumber(doseM3Input.value));
  state.doser.params = readDoserParamsFromInputs();
  state.doser.dosageM3 = dose;

  const entry = state.doser.selectedEntry;
  const selectedRow = entry ? entry.row : null;
  if (!selectedRow) return null;

  const isGlobal = !Array.isArray(selectedRow);
  const getV = (key) => isGlobal ? (selectedRow[key] || "") : valueByKey(selectedRow, key);

  const recipeItems = normalizeDoserRecipeItems(extractRecipe(selectedRow));
  const detailed = computeDoserDetailedLoads(recipeItems, dose, state.doser.params);
  const recipe = detailed.rows.map((row) => {
    // Definimos la unidad de exhibicion para la receta por m3
    let displayUnit = row.unit;
    if (["Reductor", "Retardante"].includes(row.name)) displayUnit = "Lts/m3";
    else if (["Fibra", "Imper"].includes(row.name)) displayUnit = "kg/m3";

    return {
      name: row.name,
      qty: row.designA,
      unit: displayUnit,
    };
  });
  const recipeWeight = recipe.reduce((acc, item) => acc + (item.qty * componentWeightFactor(item)), 0);
  const theoretical = detailed.rows.map((row) => ({
    name: row.name,
    unit: row.trialUnit || row.unit,
    qty: row.trialLoad,
  }));
  const theoreticalWeight = detailed.totals.theoreticalWeight;

  let realWeight = 0;
  const realRows = theoretical.map((item) => {
    if (typeof state.doser.realLoads[item.name] !== "number") {
      state.doser.realLoads[item.name] = item.qty;
    }
    const real = toNumber(state.doser.realLoads[item.name]);
    const diff = real - item.qty;
    const tol = toleranceFor(item.name);
    const lim = item.qty * (tol / 100);
    const ok = Math.abs(diff) <= lim;
    realWeight += real * componentWeightFactor(item);
    return {
      name: item.name,
      material_id: state.doser.selectedMaterials[item.name] || null,
      material_name: state.doser.selectedMaterials[item.name]
        ? ((state.doser.invMaterials || []).find(m => String(m.id) === String(state.doser.selectedMaterials[item.name]))?.name || "-- Sin descontar --")
        : "-- Sin descontar --",
      unit: item.unit,
      theoretical: item.qty,
      real,
      diff,
      status: ok ? "OK" : "FUERA",
      tolerance: tol,
    };
  });

  const formula = getV("formula") || "-";
  const fc = getV("fc") || "-";
  const tipo = getV("cod") || "-";
  const coloc = getV("tipo") || "-";
  const tma = getV("tma") || "-";
  const rev = getV("rev") || "-";
  const comp = getV("comp") || "-";
  const modDate = (isGlobal ? selectedRow._updated : getRowModDate(selectedRow)) || "-";
  const remisionNo = ((remisionNoInput?.value || "").toString().trim().toUpperCase()) || "-";
  const cliente = ((remisionClienteInput?.value || "").toString().trim()) || "-";
  const ubicacion = ((remisionUbicacionInput?.value || "").toString().trim()) || "-";

  return {
    remisionNo,
    cliente,
    ubicacion,
    file: state.file || "",
    qcUpdatedAt: state.qcUpdatedAt || "",
    formula,
    fc,
    tipo,
    coloc,
    tma,
    rev,
    comp,
    modDate,
    recipe,
    recipeWeight,
    theoretical,
    theoreticalWeight,
    theoreticalDetailed: detailed.rows,
    calcTotals: detailed.totals,
    realRows,
    realWeight,
    dose,
    qc: state.doser.quality,
    doserParams: state.doser.params,
    tolerances: { ...state.doser.tolerances },
  };
}

function normalizeDoserReportSnapshot(raw, fallback = {}) {
  const snap = raw && typeof raw === "object" ? raw : {};
  const defaultTol = { cemento: 0, agregados: 0, agua: 0, aditivo: 0 };
  const tolerances = snap.tolerances && typeof snap.tolerances === "object"
    ? snap.tolerances
    : defaultTol;
  const qcValues = snap.qc && typeof snap.qc === "object" ? snap.qc : createDefaultQuality();

  return {
    remisionNo: (snap.remisionNo || snap.remision_no || fallback.remisionNo || "-").toString(),
    cliente: (snap.cliente || fallback.cliente || "-").toString(),
    ubicacion: (snap.ubicacion || fallback.ubicacion || "-").toString(),
    file: snap.file || fallback.file || "-",
    qcUpdatedAt: snap.qcUpdatedAt || fallback.qcUpdatedAt || "-",
    formula: snap.formula || "-",
    fc: snap.fc || "-",
    tipo: snap.tipo || "-",
    coloc: snap.coloc || "-",
    tma: snap.tma || "-",
    rev: snap.rev || "-",
    comp: snap.comp || "-",
    modDate: snap.modDate || "-",
    dose: toNumber(snap.dose || snap.dosificacion_m3 || 0),
    recipe: Array.isArray(snap.recipe) ? snap.recipe : [],
    recipeWeight: toNumber(snap.recipeWeight || snap.peso_receta || 0),
    theoretical: Array.isArray(snap.theoretical) ? snap.theoretical : [],
    theoreticalDetailed: Array.isArray(snap.theoreticalDetailed) ? snap.theoreticalDetailed : [],
    calcTotals: snap.calcTotals && typeof snap.calcTotals === "object" ? snap.calcTotals : {},
    theoreticalWeight: toNumber(snap.theoreticalWeight || snap.peso_teorico_total || 0),
    realRows: Array.isArray(snap.realRows) ? snap.realRows : [],
    realWeight: toNumber(snap.realWeight || snap.peso_real_total || 0),
    doserParams: normalizeDoserParams(snap.doserParams),
    tolerances: {
      cemento: toNumber(tolerances.cemento || 0),
      agregados: toNumber(tolerances.agregados || 0),
      agua: toNumber(tolerances.agua || 0),
      aditivo: toNumber(tolerances.aditivo || 0),
    },
    qc: qcValues,
  };
}

function buildDoserReportHtml(rawSnapshot, reportDate) {
  const snap = normalizeDoserReportSnapshot(rawSnapshot, {
    file: state.file || "-",
    qcUpdatedAt: state.qcUpdatedAt || "-",
  });

  const qcRowsHtml = QC_AGGREGATES.map((agg) => {
    const q = snap.qc[agg] || {};
    return `
      <tr>
        <td>${escapeHtml(agg)}</td>
        <td class="num">${escapeHtml(formatNum(q.pvs || 0))}</td>
        <td class="num">${escapeHtml(formatNum(q.pvc || 0))}</td>
        <td class="num">${escapeHtml(formatNum(q.densidad || 0))}</td>
        <td class="num">${escapeHtml(formatNum(q.absorcion || 0))}</td>
        <td class="num">${escapeHtml(formatNum(q.humedad || 0))}</td>
      </tr>
    `;
  }).join("");

  const tolRowsHtml = `
    <tr><td>Cemento</td><td class="num">${escapeHtml(formatNum(snap.tolerances.cemento))}%</td></tr>
    <tr><td>Agregados</td><td class="num">${escapeHtml(formatNum(snap.tolerances.agregados))}%</td></tr>
    <tr><td>Agua</td><td class="num">${escapeHtml(formatNum(snap.tolerances.agua))}%</td></tr>
    <tr><td>Aditivo</td><td class="num">${escapeHtml(formatNum(snap.tolerances.aditivo))}%</td></tr>
  `;

  const paramsRowsHtml = `
    <tr><td>Peso esp. cemento</td><td class="num">${escapeHtml(formatNum(snap.doserParams.cemento_pesp || 0))}</td></tr>
    <tr><td>Aire (%)</td><td class="num">${escapeHtml(formatNum(snap.doserParams.aire_pct || 0))}</td></tr>
    <tr><td>Pasa malla 200 (%)</td><td class="num">${escapeHtml(formatNum(snap.doserParams.pasa_malla_200_pct || 0))}</td></tr>
    <tr><td>PxL pond. (%)</td><td class="num">${escapeHtml(formatNum(snap.doserParams.pxl_pond_pct || 0))}</td></tr>
    <tr><td>Densidad agg fallback</td><td class="num">${escapeHtml(formatNum(snap.doserParams.densidad_agregado_fallback || 0))}</td></tr>
  `;

  const recipeRowsHtml = snap.recipe
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td class="num">${escapeHtml(formatNum(item.qty))}</td>
          <td>${escapeHtml(item.unit)}</td>
        </tr>
      `
    )
    .join("");

  const theoreticalDetailedRowsHtml = (snap.theoreticalDetailed || [])
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td class="num">${escapeHtml(formatNum(item.designA || 0))}</td>
          <td class="num">${escapeHtml(formatNum(item.designSss || 0))}</td>
          <td class="num">${escapeHtml(formatNum(item.freeWater || 0))}</td>
          <td class="num">${escapeHtml(formatNum(item.absVolume || 0))}</td>
          <td class="num">${escapeHtml(formatNum(item.designReal || 0))}</td>
          <td class="num">${escapeHtml(formatNum(item.trialLoad || 0))}</td>
          <td>${escapeHtml(item.trialUnit || item.unit || "-")}</td>
          <td>${escapeHtml(item.note || "-")}</td>
        </tr>
      `
    )
    .join("");
  const theoreticalRowsHtml = theoreticalDetailedRowsHtml || snap.theoretical
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td class="num">${escapeHtml(formatNum(item.qty || 0))}</td>
          <td class="num">-</td>
          <td class="num">-</td>
          <td class="num">-</td>
          <td class="num">-</td>
          <td class="num">${escapeHtml(formatNum(item.qty || 0))}</td>
          <td>${escapeHtml(item.unit || "-")}</td>
          <td>-</td>
        </tr>
      `
    )
    .join("");

  const realRowsHtml = snap.realRows
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(item.material_name || "-- Sin descontar --")}</td>
          <td class="num">${escapeHtml(formatNum(item.theoretical))}</td>
          <td class="num">${escapeHtml(formatNum(item.real))}</td>
          <td class="num">${item.diff >= 0 ? "+" : ""}${escapeHtml(formatNum(item.diff))}</td>
          <td class="num">${escapeHtml(formatNum(item.tolerance))}%</td>
          <td class="${item.status === "OK" ? "ok" : "bad"}">${escapeHtml(item.status)}</td>
        </tr>
      `
    )
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Reporte Dosificador - ${escapeHtml(snap.formula)}</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    html, body { width: 297mm; height: 210mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; margin: 0; color: #1a2c3f; font-size: 11px; line-height: 1.2; }
    .sheet { width: 100%; min-height: 100%; padding: 3mm 4mm; }
    .head { border-bottom: 1px solid #0b4f8a; margin-bottom: 6px; padding-bottom: 4px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .head-brand { display: inline-flex; align-items: center; gap: 8px; }
    .head-logo { width: 44px; height: 44px; object-fit: contain; border: 1px solid #d5e1ee; border-radius: 8px; background: #fff; padding: 4px; }
    .head h1 { margin: 0; font-size: 16px; color: #0d3762; }
    .head .brand { margin: 2px 0 0; color: #39546e; font-size: 10px; font-weight: 600; }
    .head .sub { margin: 0; color: #39546e; font-size: 10.5px; text-align: right; }
    .meta-table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 6px; }
    .meta-table th, .meta-table td { border: 1px solid #dce5ef; padding: 3px 5px; }
    .meta-table th { background: #edf4fb; text-align: left; width: 9%; font-weight: 600; }
    .meta-table td { width: 16%; font-weight: 600; color: #153958; }
    .grid-2 { display: grid; grid-template-columns: 1.45fr 1fr; gap: 6px; margin-bottom: 6px; }
    .grid-2.equal { grid-template-columns: 1fr 1fr; }
    .panel { border: 1px solid #dce5ef; border-radius: 6px; padding: 4px; break-inside: avoid; }
    .panel h2 { margin: 0 0 4px; font-size: 12px; color: #0d3762; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #dce5ef; padding: 3px 5px; vertical-align: middle; }
    th { background: #edf4fb; text-align: left; font-size: 10.5px; font-weight: 700; }
    td { font-size: 10.5px; }
    td.num, th.num { text-align: right; }
    .total-line { margin-top: 3px; padding-top: 3px; border-top: 1px dashed #ccd8e6; text-align: right; font-weight: 700; color: #123b66; }
    .ok { color: #1f7a42; font-weight: 700; }
    .bad { color: #b9362d; font-weight: 700; }
    .sign { margin-top: 8px; border-top: 1px solid #d3dfec; padding-top: 5px; text-align: center; color: #264767; font-weight: 600; font-size: 10.5px; }
    .nowrap { white-space: nowrap; }
    @media print {
      html, body { margin: 0 !important; padding: 0 !important; }
      .sheet { break-inside: avoid; page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <div class="head-brand">
        <img class="head-logo" src="${escapeHtml(BRAND_LOGO_URL)}" alt="ALMEX">
        <div>
          <h1>Reporte de Dosificador</h1>
          <p class="brand">ALMEX</p>
        </div>
      </div>
      <p class="sub">Generado: ${escapeHtml(reportDate)} | Archivo: ${escapeHtml(snap.file)}</p>
    </div>

    <table class="meta-table">
      <tbody>
        <tr>
          <th>Remision</th><td>${escapeHtml(snap.remisionNo)}</td>
          <th>Formula</th><td>${escapeHtml(snap.formula)}</td>
          <th>f'c</th><td>${escapeHtml(snap.fc)}</td>
          <th>Tipo</th><td>${escapeHtml(snap.tipo)}</td>
        </tr>
        <tr>
          <th>Colocacion</th><td>${escapeHtml(snap.coloc)}</td>
          <th>T.M.A.</th><td>${escapeHtml(snap.tma)}</td>
          <th>Rev</th><td>${escapeHtml(snap.rev)}</td>
          <th>Comp</th><td>${escapeHtml(snap.comp)}</td>
        </tr>
        <tr>
          <th>Cliente</th><td>${escapeHtml(snap.cliente)}</td>
          <th>Ubicacion</th><td>${escapeHtml(snap.ubicacion)}</td>
          <th>Fecha Modif</th><td>${escapeHtml(snap.modDate)}</td>
          <th>Dosificacion</th><td class="nowrap">${escapeHtml(formatNum(snap.dose))} m<sup>3</sup></td>
        </tr>
        <tr>
          <th>QC</th><td>${escapeHtml(snap.qcUpdatedAt)}</td>
          <th></th><td></td>
          <th></th><td></td>
          <th></th><td></td>
        </tr>
      </tbody>
    </table>

    <div class="grid-2">
      <section class="panel">
        <h2>Datos de Control de Calidad</h2>
        <table>
          <thead>
            <tr>
              <th style="width:22%;">Agregado</th>
              <th class="num" style="width:15%;">PVS</th>
              <th class="num" style="width:15%;">PVC</th>
              <th class="num" style="width:16%;">Densidad</th>
              <th class="num" style="width:16%;">Absorcion</th>
              <th class="num" style="width:16%;">Humedad</th>
            </tr>
          </thead>
          <tbody>${qcRowsHtml}</tbody>
        </table>
      </section>
      <section class="panel">
        <h2>Tolerancias de Carga</h2>
        <table>
          <thead><tr><th>Material</th><th class="num">Tolerancia</th></tr></thead>
          <tbody>${tolRowsHtml}</tbody>
        </table>
        <h2 style="margin-top:6px;">Parametros de Calculo</h2>
        <table>
          <thead><tr><th>Parametro</th><th class="num">Valor</th></tr></thead>
          <tbody>${paramsRowsHtml}</tbody>
        </table>
      </section>
    </div>

    <div class="grid-2 equal">
      <section class="panel">
        <h2>Receta</h2>
        <table>
          <thead><tr><th style="width:50%;">Componente</th><th class="num" style="width:30%;">Cantidad</th><th style="width:20%;">Unidad</th></tr></thead>
          <tbody>${recipeRowsHtml}</tbody>
        </table>
        <div class="total-line">Peso aprox por m<sup>3</sup>: ${escapeHtml(formatNum(snap.recipeWeight))}</div>
      </section>
      <section class="panel">
        <h2>Carga Teorica Detallada</h2>
        <table>
          <thead>
            <tr>
              <th style="width:17%;">Componente</th>
              <th class="num" style="width:9%;">Diseño A</th>
              <th class="num" style="width:9%;">Diseño SSS</th>
              <th class="num" style="width:10%;">Agua libre H.R.</th>
              <th class="num" style="width:9%;">Vol. Abs.</th>
              <th class="num" style="width:9%;">Diseño H.R.</th>
              <th class="num" style="width:10%;">Mezcla Prueba</th>
              <th style="width:8%;">U.M.</th>
              <th style="width:19%;">Obs.</th>
            </tr>
          </thead>
          <tbody>${theoreticalRowsHtml}</tbody>
        </table>
        <div class="total-line">Peso teorico total: ${escapeHtml(formatNum(snap.theoreticalWeight))}</div>
        <div class="total-line">Rel. A/C: ${escapeHtml(formatNum(toNumber(snap.calcTotals.relAc || 0)))} | Vol. Abs. + Aire: ${escapeHtml(formatNum(toNumber(snap.calcTotals.absVolumeTotal || 0)))}</div>
      </section>
    </div>

    <section class="panel">
      <h2>Carga Real y Diferencial</h2>
      <table>
        <thead>
          <tr>
            <th style="width:18%;">Componente</th>
            <th style="width:20%;">Material</th>
            <th class="num" style="width:14%;">Teorica</th>
            <th class="num" style="width:14%;">Real</th>
            <th class="num" style="width:12%;">Diferencia</th>
            <th class="num" style="width:10%;">Tol. %</th>
            <th style="width:12%;">Estatus</th>
          </tr>
        </thead>
        <tbody>${realRowsHtml}</tbody>
      </table>
      <div class="total-line">Peso real total: ${escapeHtml(formatNum(snap.realWeight))}</div>
    </section>

    <div class="sign">ForMix by Labsico - Dise&#241;a-Dosifica-Calcula</div>
  </div>
</body>
</html>`;
}

function openReportWindow(html, successMessage) {
  const win = window.open("", "_blank");
  if (!win) {
    setStatus("El navegador bloqueo la ventana del reporte. Habilita pop-ups e intenta de nuevo.", "warn");
    return false;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  if (successMessage) setStatus(successMessage, "ok");
  return true;
}

function exportDoserReport() {
  const snap = buildDoserReportSnapshot();
  if (!snap) {
    setStatus("Selecciona una mezcla en Dosificador para exportar el reporte.", "warn");
    return;
  }
  const html = buildDoserReportHtml(snap, nowStamp());
  openReportWindow(html, "Reporte de dosificador generado. Usa Imprimir para guardarlo en PDF.");
}

async function openRemisionReport(remisionId) {
  try {
    const id = Number(remisionId);
    if (!Number.isFinite(id) || id <= 0) return setStatus("ID invalido.", "warn");
    const response = await apiFetch(`/api/remisiones/${encodeURIComponent(id)}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo cargar la remision.");
    }
    const snap = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : null;
    if (!snap) {
      throw new Error("La remision no tiene snapshot de reporte.");
    }
    const remisionNo = snap.remisionNo || snap.remision_no || payload.remision_no || "-";
    const normalized = normalizeDoserReportSnapshot(snap, {
      remisionNo,
      cliente: payload.cliente || "-",
      ubicacion: payload.ubicacion || "-",
      file: payload.file || state.file || "-",
      qcUpdatedAt: state.qcUpdatedAt || "-",
    });
    const html = buildDoserReportHtml(normalized, nowStamp());
    openReportWindow(html);
    setStatus(`Reporte de remision ${remisionNo} generado. Usa Imprimir para guardarlo en PDF.`, "ok");
  } catch (error) {
    setStatus(String(error), "err");
  }
}

function componentWeightFactor(item) {
  const unit = (item?.unit || "").toString().toLowerCase();
  if (unit === "cc" || unit === "ml") return 1 / 1000;
  return 1;
}

function isAggregateComponent(name) {
  return ["Fino 1", "Fino 2", "Grueso 1", "Grueso 2"].includes(name);
}

function getQualityFor(componentName) {
  return (
    state.doser.quality[componentName] || {
      pvs: 0,
      pvc: 0,
      densidad: 0,
      absorcion: 0,
      humedad: 0,
    }
  );
}

function doserComponentOrder(recipeItems) {
  const priority = [
    "Cemento",
    "Grueso 1",
    "Grueso 2",
    "Fino 1",
    "Fino 2",
    "Agua",
    "Reductor",
    "Retardante",
    "Fibra",
    "Imper",
  ];
  const names = recipeItems.map((item) => item.name);
  const out = [];
  priority.forEach((name) => {
    if (names.includes(name)) out.push(name);
  });
  names.forEach((name) => {
    if (!out.includes(name)) out.push(name);
  });
  return out;
}

function resolveAggregateDensityKgPerLt(componentName, params) {
  const avg = averagePV(componentName);
  if (avg && avg > 0) {
    if (avg > 50) return { value: avg / 1000, source: "qc_avg_kg_m3" };
    return { value: avg, source: "qc_avg_kg_l" };
  }
  return {
    value: Math.max(0, toNumber(params.densidad_agregado_fallback)),
    source: "fallback",
  };
}

function computeDoserDetailedLoads(recipeItems, dose, params) {
  const safeDose = Math.max(0, toNumber(dose));
  const cleanParams = normalizeDoserParams(params);
  const order = doserComponentOrder(recipeItems);
  const recipeByName = new Map(recipeItems.map((item) => [item.name, item]));

  const rows = [];
  let aggAbsDemand = 0;
  let aggFreeWater = 0;
  let aggIGravel = 0;
  let aggISand = 0;
  let airLiters = (Math.max(0, cleanParams.aire_pct) / 100) * 1000;
  let cementDesignSss = 0;
  let waterDesignSss = 0;
  let aditivo4DesignSss = 0;

  const makeBaseRow = (name) => {
    const base = recipeByName.get(name) || { qty: 0, unit: componentUnit(name) };
    return {
      name,
      unit: base.unit || componentUnit(name),
      designA: Math.max(0, toNumber(base.qty)),
      designSss: 0,
      freeWater: 0,
      absVolume: 0,
      designReal: 0,
      trialLoad: 0,
      trialUnit: base.unit || componentUnit(name),
      note: "",
      includeAbsVolume: false,
      includeWeightTotal: true,
    };
  };

  order.forEach((name) => {
    const row = makeBaseRow(name);
    if (name === "Cemento") {
      row.designSss = row.designA;
      row.designReal = row.designSss;
      const div = safeDivide(row.designSss, cleanParams.cemento_pesp, 0);
      row.absVolume = div.value;
      row.includeAbsVolume = true;
      row.includeWeightTotal = true;
      row.trialLoad = row.designReal * safeDose;
      row.trialUnit = "kg";
      cementDesignSss = row.designSss;
      if (div.fallbackUsed) row.note = "Peso esp. cemento faltante";
    } else if (isAggregateComponent(name)) {
      const q = getQualityFor(name);
      const absPct = Math.max(0, toNumber(q.absorcion));
      const humPct = Math.max(0, toNumber(q.humedad));
      row.designSss = row.designA + ((row.designA * absPct) / 100);
      row.freeWater = ((humPct - absPct) / 100) * row.designSss;
      row.designReal = row.designSss + row.freeWater;
      const dens = resolveAggregateDensityKgPerLt(name, cleanParams);
      const div = safeDivide(row.designSss, dens.value, 0);
      row.absVolume = div.value;
      row.includeAbsVolume = true;
      row.includeWeightTotal = true;
      row.trialLoad = row.designReal * safeDose;
      row.trialUnit = "kg";
      aggAbsDemand += (row.designA * absPct) / 100;
      aggFreeWater += row.freeWater;
      if (name.startsWith("Grueso")) aggIGravel += row.designSss;
      if (name.startsWith("Fino")) aggISand += row.designSss;
      if (dens.source === "fallback" || div.fallbackUsed) row.note = "Dato base faltante";
    } else if (name === "Agua") {
      row.designSss = row.designA - aggAbsDemand;
      row.freeWater = aggFreeWater;
      row.absVolume = row.designSss;
      row.designReal = row.designSss - row.freeWater;
      row.includeAbsVolume = true;
      row.includeWeightTotal = true;
      row.trialLoad = row.designReal * safeDose;
      row.trialUnit = "Lts";
      waterDesignSss = row.designSss;
    } else if (name === "Reductor" || name === "Retardante") {
      // Flujo Excel: aditivo en diseno como Lts/m3.
      row.designSss = row.designA;
      row.absVolume = row.designSss;
      row.designReal = row.designSss;
      row.includeAbsVolume = true;
      row.includeWeightTotal = true;
      // Formula equivalente a: (m3/1000) * (L/m3) * 1000
      row.trialLoad = (safeDose / 1000) * row.designReal * 1000;
      row.trialUnit = "Lts";
      if (name === "Retardante") aditivo4DesignSss = row.designSss;
    } else {
      row.designSss = row.designA;
      row.designReal = row.designSss;
      if (row.unit === "Lts") {
        row.absVolume = row.designSss;
        row.includeAbsVolume = true;
      }
      row.trialLoad = row.designReal * safeDose;
      row.trialUnit = row.unit || "kg";
    }
    rows.push(row);
  });

  const sumBy = (fn) => rows.reduce((acc, r) => acc + fn(r), 0);
  const absTotalBase = sumBy((r) => (r.includeAbsVolume ? r.absVolume : 0));
  const absTotal = absTotalBase + airLiters;
  const relAc = safeDivide(waterDesignSss, cementDesignSss, 0).value;
  const gravelPct = safeDivide(aggIGravel * 100, aggIGravel + aggISand, 0).value;
  const sandPct = safeDivide(aggISand * 100, aggIGravel + aggISand, 0).value;
  const gravelSandRatio = safeDivide(aggIGravel, aggISand, 0).value;
  const fino1 = rows.find((r) => r.name === "Fino 1");
  const fino2 = rows.find((r) => r.name === "Fino 2");
  const finoContent =
    cementDesignSss +
    ((Math.max(0, cleanParams.pxl_pond_pct) * toNumber(fino1?.designSss || 0)) / 100) +
    ((toNumber(fino2?.designSss || 0) * Math.max(0, cleanParams.pasa_malla_200_pct)) / 100) +
    aditivo4DesignSss;
  const recipeWeight = sumBy((r) => {
    const isAditivo = r.name === "Reductor" || r.name === "Retardante";
    const qty = isAditivo ? r.designSss : r.designA;
    const unit = isAditivo ? "Lts" : (r.unit || "kg");
    return qty * componentWeightFactor({ unit });
  });
  const theoreticalWeight = sumBy((r) =>
    r.includeWeightTotal ? r.trialLoad * componentWeightFactor({ unit: r.trialUnit || r.unit }) : 0
  );

  return {
    rows,
    totals: {
      recipeWeight,
      theoreticalWeight,
      absVolumeTotal: absTotal,
      airLiters,
      gravelPct,
      sandPct,
      gravelSandRatio,
      relAc,
      finoContent,
      freeWaterTotal: aggFreeWater,
    },
  };
}

function adjustRecipeByQuality(recipeItems, dose) {
  const safeDose = Math.max(0, toNumber(dose));
  const baseWater = recipeItems.find((item) => item.name === "Agua");
  let freeWaterCorrection = 0;

  const adjusted = recipeItems.map((item) => {
    let qty = item.qty * safeDose;
    if (isAggregateComponent(item.name)) {
      const q = getQualityFor(item.name);
      const abs = (q.absorcion || 0) / 100;
      const hum = (q.humedad || 0) / 100;
      const den = 1 + abs;
      qty = den > 0 ? (qty * (1 + hum)) / den : qty;
      freeWaterCorrection += item.qty * safeDose * ((q.humedad || 0) - (q.absorcion || 0)) / 100;
    }
    return { ...item, qty };
  });

  if (baseWater) {
    const waterItem = adjusted.find((item) => item.name === "Agua");
    if (waterItem) waterItem.qty = Math.max(0, waterItem.qty - freeWaterCorrection);
  }
  return adjusted;
}

function toleranceFor(componentName) {
  if (componentName === "Cemento") return state.doser.tolerances.cemento || 0;
  if (componentName === "Agua") return state.doser.tolerances.agua || 0;
  if (["Fino 1", "Fino 2", "Grueso 1", "Grueso 2"].includes(componentName)) {
    return state.doser.tolerances.agregados || 0;
  }
  return state.doser.tolerances.aditivo || 0;
}

function applyDoserFilter(entry, filters) {
  const row = entry.row;
  const isGlobal = !!entry.isGlobal;

  const getV = (key) => isGlobal ? (row[key] || "") : valueByKey(row, key);
  const family = isGlobal ? (row.family || "") : deriveFamily(row);
  const formula = getV("formula");
  const no = getV("no");
  const cod = getV("cod");

  if (filters.family) {
    const term = normalize(filters.family);
    const haystack = `${family} ${formula} ${no} ${cod}`;
    if (!normalize(haystack).includes(term)) return false;
  }
  if (filters.fc && normalize(getV("fc")) !== normalize(filters.fc)) return false;
  if (filters.edad && normalize(getV("edad")) !== normalize(filters.edad)) return false;
  if (filters.tipo && normalize(getV("tipo")) !== normalize(filters.tipo)) return false;
  if (filters.tma && normalize(getV("tma")) !== normalize(filters.tma)) return false;
  if (filters.rev && normalize(getV("rev")) !== normalize(filters.rev)) return false;
  if (filters.comp && normalize(getV("comp")) !== normalize(filters.comp)) return false;
  return true;
}

function runDoserSearch() {
  const filters = {
    family: doserFields.family.value.trim(),
    fc: doserFields.fc.value,
    edad: doserFields.edad.value,
    tipo: doserFields.tipo.value,
    tma: doserFields.tma.value,
    rev: doserFields.rev.value,
    comp: doserFields.comp.value,
  };

  let pool = [];
  if (state.doser.globalRecipes.length > 0) {
    pool = state.doser.globalRecipes.map((r, idx) => ({ row: r, sourceIndex: idx, isGlobal: true }));
  } else {
    pool = state.rows.map((row, sourceIndex) => ({ row, sourceIndex, isGlobal: false }));
  }

  state.doser.results = pool.filter((entry) => applyDoserFilter(entry, filters));

  const current = state.doser.selectedEntry;
  const stillInResults = current && state.doser.results.some(r =>
    r.isGlobal === current.isGlobal &&
    (r.isGlobal ? (r.row.formula === current.row.formula && r.row.no === current.row.no) : (r.sourceIndex === current.sourceIndex))
  );

  if (!stillInResults) {
    state.doser.selectedEntry = state.doser.results.length ? state.doser.results[0] : null;
    state.doser.realLoads = {};
  }

  renderDoserResults();
  renderDosificador();
}

async function loadGlobalRecipes() {
  try {
    const resp = await apiFetch("/api/doser/recipes_global");
    const data = await resp.json();
    if (data.ok) {
      state.doser.globalRecipes = data.recipes || [];
      fillDoserSelectorsGlobal();
      runDoserSearch();
    }
  } catch (err) {
    console.warn("No se pudieron cargar recetas globales:", err);
  }
}

function fillDoserSelectorsGlobal() {
  if (!state.doser.globalRecipes.length) return fillDoserSelectors();

  const getUnique = (key) => {
    const s = new Set();
    state.doser.globalRecipes.forEach(r => {
      if (r[key]) s.add(String(r[key]).trim());
    });
    return Array.from(s).sort();
  };

  fillSelect(doserFields.family, getUnique("family"));
  fillSelect(doserFields.fc, getUnique("fc"));
  fillSelect(doserFields.edad, getUnique("edad"));
  fillSelect(doserFields.tipo, getUnique("tipo"));
  fillSelect(doserFields.tma, getUnique("tma"));
  fillSelect(doserFields.rev, getUnique("rev"));
  fillSelect(doserFields.comp, getUnique("comp"));
}

function fillDoserSelectors() {
  if (state.doser.globalRecipes && state.doser.globalRecipes.length > 0) {
    return fillDoserSelectorsGlobal();
  }
  fillSelect(doserFields.family, getUniqueValues("family"));
  fillSelect(doserFields.fc, getUniqueValues("fc"));
  fillSelect(doserFields.edad, getUniqueValues("edad"));
  fillSelect(doserFields.tipo, getUniqueValues("tipo"));
  fillSelect(doserFields.tma, getUniqueValues("tma"));
  fillSelect(doserFields.rev, getUniqueValues("rev"));
  fillSelect(doserFields.comp, getUniqueValues("comp"));
}

function renderDoserResults() {
  doserQueryBody.innerHTML = "";
  if (!state.doser.results.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="9">Sin resultados para los filtros del dosificador.</td>`;
    doserQueryBody.appendChild(tr);
    return;
  }
  state.doser.results.forEach((entry) => {
    const row = entry.row;
    const current = state.doser.selectedEntry;
    const isSelected = current &&
      current.isGlobal === entry.isGlobal &&
      (entry.isGlobal ? (entry.row.formula === current.row.formula && entry.row.no === current.row.no) : (entry.sourceIndex === current.sourceIndex));

    const tr = document.createElement("tr");
    if (isSelected) tr.classList.add("is-selected");

    const displayVal = (key) => escapeHtml(entry.isGlobal ? (row[key] || "-") : (valueByKey(row, key) || "-"));

    tr.innerHTML = `
      <td>${escapeHtml(entry.isGlobal ? (row.family || "") : deriveFamily(row))}</td>
      <td>${displayVal("formula")}</td>
      <td>${displayVal("fc")}</td>
      <td>${displayVal("edad")}</td>
      <td>${displayVal("tipo")}</td>
      <td>${displayVal("tma")}</td>
      <td>${displayVal("rev")}</td>
      <td>${displayVal("comp")}</td>
      <td>${escapeHtml((entry.isGlobal ? row._updated : getRowModDate(row)) || "-")}</td>
    `;
    tr.addEventListener("click", () => {
      selectDoserRecipe(entry);
    });
    doserQueryBody.appendChild(tr);
  });
}

async function selectDoserRecipe(entry) {
  state.doser.selectedEntry = entry;

  if (entry.isGlobal) {
    if (entry.row._source !== state.file) {
      setStatus(`Cambiando al archivo ${entry.row._source}...`, "info");
      try {
        const resp = await apiFetch("/api/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: entry.row._source })
        });
        const res = await resp.json();
        if (res.ok) {
          state.file = res.file;
          state.headers = res.headers || [];
          state.rows = res.rows || [];
          state.datasetFamily = res.family || "";
          state.version = res.version;
          await Promise.all([loadQc(), loadDoserParams()]);
        } else {
          setStatus("Error al cambiar de archivo: " + res.error, "err");
          return;
        }
      } catch (err) {
        setStatus("Error de red al cambiar archivo: " + err.message, "err");
        return;
      }
    }
  }

  state.doser.realLoads = {};
  renderDoserResults();
  renderDosificador();
}

function getRemisionDisplayFields(item) {
  const snap = item?.snapshot || {};
  return {
    cliente: snap.cliente || item?.cliente || "-",
    ubicacion: snap.ubicacion || item?.ubicacion || "-",
  };
}

function buildRemisionRow(item) {
  const { cliente, ubicacion } = getRemisionDisplayFields(item);
  const canEdit = state.auth.role === "administrador";
  const canDelete = canAccessView("dosificador");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${escapeHtml(item.remision_no || "-")}</td>
    <td title="${escapeHtml(item.formula || "-")}"><span class="remision-cell-text">${escapeHtml(item.formula || "-")}</span></td>
    <td>${escapeHtml(item.fc || "-")}</td>
    <td>${escapeHtml(item.tma || "-")}</td>
    <td>${formatNum(item.dosificacion_m3 || 0)}</td>
    <td title="${escapeHtml(cliente)}"><span class="remision-cell-text">${escapeHtml(cliente)}</span></td>
    <td title="${escapeHtml(ubicacion)}"><span class="remision-cell-text">${escapeHtml(ubicacion)}</span></td>
    <td>${formatNum(item.peso_real_total || 0)}</td>
    <td>${escapeHtml(item.created_at || "-")}</td>
    <td title="${escapeHtml(item.source_file || "-")}"><span class="remision-cell-text">${escapeHtml(item.source_file || "-")}</span></td>
    <td title="${escapeHtml(item.created_by || "-")}"><span class="remision-cell-text">${escapeHtml(item.created_by || "-")}</span></td>
    <td class="remision-actions">
      <button type="button" class="btn btn--secondary btn--small remision-report-btn">Reporte</button>
      ${canEdit ? '<button type="button" class="btn btn--muted btn--small remision-edit-btn">Editar</button>' : ''}
      ${canDelete ? '<button type="button" class="btn btn--danger btn--small remision-delete-btn">Eliminar</button>' : ''}
    </td>
  `;
  const reportBtn = tr.querySelector(".remision-report-btn");
  if (reportBtn) reportBtn.addEventListener("click", () => openRemisionReport(item.id));
  const deleteBtn = tr.querySelector(".remision-delete-btn");
  if (deleteBtn) deleteBtn.addEventListener("click", () => deleteRemision(item.id, item.remision_no, item.source_file));
  const editBtn = tr.querySelector(".remision-edit-btn");
  if (editBtn) editBtn.addEventListener("click", () => openEditRemisionModal(item));
  return tr;
}

function renderRemisionTable(targetBody, items, emptyMessage, metaTarget, metaLabel = "Remisiones") {
  if (!targetBody) return;
  targetBody.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="12">${escapeHtml(emptyMessage)}</td>`;
    targetBody.appendChild(tr);
    if (metaTarget) metaTarget.textContent = `${metaLabel}: 0`;
    return;
  }
  items.forEach((item) => targetBody.appendChild(buildRemisionRow(item)));
  if (metaTarget) metaTarget.textContent = `${metaLabel}: ${items.length}`;
}

function renderRemisionList() {
  renderRemisionTable(
    doserRemisionBody,
    Array.isArray(state.doser.remisiones) ? state.doser.remisiones : [],
    "Sin remisiones guardadas para esta fecha.",
    remisionMeta
  );
}

function ensureRemisionesFilters() {
  if (!remisionesDateTo || !remisionesDateFrom) return;
  if (!remisionesDateTo.value) remisionesDateTo.value = getTodayPuertoMorelos();
  if (!remisionesDateFrom.value) remisionesDateFrom.value = getPuertoMorelosDateOffset(-30);
}

function renderRemisionesViewTable() {
  renderRemisionTable(
    remisionesBody,
    Array.isArray(state.remisiones.items) ? state.remisiones.items : [],
    "No se encontraron remisiones para los filtros seleccionados.",
    remisionesMeta,
    "Resultados"
  );
}

async function loadRemisiones() {
  if (!canAccessView("dosificador")) return;
  const filterDate = (remisionFilterDate && remisionFilterDate.value) ? remisionFilterDate.value : "";
  try {
    if (remisionMeta) remisionMeta.textContent = "Cargando remisiones...";
    const url = `/api/remisiones?limit=150${filterDate ? `&date=${filterDate}` : ""}`;
    const response = await apiFetch(url);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo cargar remisiones.");
    state.doser.remisiones = Array.isArray(payload.items) ? payload.items : [];
  } catch (error) {
    state.doser.remisiones = [];
    console.error("loadRemisiones error:", error);
  }
  renderRemisionList();
}

async function loadRemisionesView() {
  if (!canAccessView("remisiones")) return;
  ensureRemisionesFilters();
  const dateFrom = remisionesDateFrom?.value || "";
  const dateTo = remisionesDateTo?.value || "";
  const query = (remisionesSearchInput?.value || "").trim();
  try {
    if (remisionesMeta) remisionesMeta.textContent = "Cargando remisiones...";
    const params = new URLSearchParams({ limit: "500" });
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    if (query) params.set("q", query);
    const response = await apiFetch(`/api/remisiones?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo cargar remisiones.");
    state.remisiones.items = Array.isArray(payload.items) ? payload.items : [];
    state.remisiones.initialized = true;
  } catch (error) {
    state.remisiones.items = [];
    console.error("loadRemisionesView error:", error);
    setStatus(`Error al cargar remisiones: ${error.message}`, "err");
  }
  renderRemisionesViewTable();
}

window.openEditRemisionModal = function (item) {
  if (!item || !item.id) return;
  const modal = document.getElementById("editRemisionModal");
  if (!modal) return;
  const snap = item.snapshot || {};
  document.getElementById("editRemisionId").value = item.id;
  document.getElementById("erNo").value = item.remision_no || "";
  document.getElementById("erFormula").value = item.formula || "";
  document.getElementById("erCliente").value = snap.cliente || item.cliente || "";
  document.getElementById("erUbicacion").value = snap.ubicacion || item.ubicacion || "";
  document.getElementById("erM3").value = item.dosificacion_m3 || 0;
  document.getElementById("erWeight").value = item.peso_real_total || 0;
  document.getElementById("editRemisionSourceFile").value = item.source_file || "";

  // Formatear fecha para datetime-local (YYYY-MM-DDTHH:mm)
  if (item.created_at) {
    const dt = item.created_at.replace(' ', 'T').substring(0, 16);
    document.getElementById("erDate").value = dt;
  }

  modal.classList.remove("is-hidden");
  modal.setAttribute("aria-hidden", "false");
};

window.closeEditRemisionModal = function () {
  const modal = document.getElementById("editRemisionModal");
  if (modal) {
    modal.classList.add("is-hidden");
    modal.setAttribute("aria-hidden", "true");
  }
};

// Listener para el formulario de edición
document.addEventListener("DOMContentLoaded", () => {
  const editForm = document.getElementById("editRemisionForm");
  if (editForm) {
    editForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = document.getElementById("editRemisionId").value;
      const sourceFile = document.getElementById("editRemisionSourceFile").value;
      const payload = {
        remision_no: document.getElementById("erNo").value,
        formula: document.getElementById("erFormula").value,
        cliente: document.getElementById("erCliente").value,
        ubicacion: document.getElementById("erUbicacion").value,
        dosificacion_m3: parseFloat(document.getElementById("erM3").value),
        peso_real_total: parseFloat(document.getElementById("erWeight").value),
        created_at: document.getElementById("erDate").value.replace('T', ' ') + ':00'
      };

      try {
        const fileQuery = sourceFile ? `?file=${encodeURIComponent(sourceFile)}` : "";
        const res = await apiFetch(`/api/remisiones/${id}${fileQuery}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
          setStatus("Remisión actualizada correctamente.", "ok");
          closeEditRemisionModal();
          await Promise.all([
            canAccessView("dosificador") ? loadRemisiones() : Promise.resolve(),
            canAccessView("remisiones") ? loadRemisionesView() : Promise.resolve(),
          ]);
        } else {
          throw new Error(data.error || "Error al actualizar");
        }
      } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
      }
    });
  }
});

async function deleteRemision(remisionId, remisionNo, sourceFile) {
  try {
    const id = Number(remisionId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("ID de remision invalido.");
    }
    const code = (remisionNo || "-").toString().trim() || "-";
    const confirmed = await uiConfirm(
      `Se eliminara la remision ${code}. Esta accion no se puede deshacer. Continuar?`,
      {
        title: "Eliminar remision",
        confirmText: "Eliminar",
        tone: "err",
      }
    );
    if (!confirmed) return;
    const response = await apiFetch(`/api/remisiones/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo eliminar la remision.");
    }
    await Promise.all([
      canAccessView("dosificador") ? loadRemisiones() : Promise.resolve(),
      canAccessView("remisiones") ? loadRemisionesView() : Promise.resolve(),
    ]);
    setStatus(`Remision eliminada: ${payload.remision_no || code}`, "ok");
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function saveRemision() {
  try {
    const remisionNo = ((remisionNoInput?.value || "").toString().trim().toUpperCase());
    const cliente = ((remisionClienteInput?.value || "").toString().trim());
    const ubicacion = ((remisionUbicacionInput?.value || "").toString().trim());
    const remisionDate = ((remisionDateInput?.value || "").toString().trim());
    if (!remisionNo) {
      setStatus("Ingresa el numero de remision.", "warn");
      return;
    }
    if (!cliente) {
      setStatus("Ingresa el cliente.", "warn");
      return;
    }
    if (!ubicacion) {
      setStatus("Ingresa la ubicacion.", "warn");
      return;
    }
    if (!remisionDate) {
      setStatus("Selecciona la fecha de la remision.", "warn");
      return;
    }
    const snap = buildDoserReportSnapshot();
    if (!snap) {
      setStatus("Selecciona una mezcla para guardar la remision.", "warn");
      return;
    }
    const nowPm = getPuertoMorelosDate();
    const remisionCreatedAt = `${remisionDate} ${String(nowPm.getHours()).padStart(2, '0')}:${String(nowPm.getMinutes()).padStart(2, '0')}:${String(nowPm.getSeconds()).padStart(2, '0')}`;
    const response = await apiFetch("/api/remisiones/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: state.file,
        remision_no: remisionNo,
        cliente,
        ubicacion,
        snapshot: snap,
        created_at: remisionCreatedAt,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo guardar la remision.");
    }
    if (remisionNoInput) remisionNoInput.value = "";
    if (remisionClienteInput) remisionClienteInput.value = "";
    if (remisionUbicacionInput) remisionUbicacionInput.value = "";
    await Promise.all([
      canAccessView("dosificador") ? loadRemisiones() : Promise.resolve(),
      canAccessView("remisiones") ? loadRemisionesView() : Promise.resolve(),
    ]);
    setStatus(`Remision guardada: ${payload.remision_no}`, "ok");
    pushToast(`Remisión guardada con éxito: ${payload.remision_no}`, "ok");
  } catch (error) {
    setStatus(String(error), "err");
  }
}

function syncQcStamps() {
  const stamp = state.qcUpdatedAt || "-";
  const suffix = state.qcError ? ` | Error: ${state.qcError}` : "";
  editorQcMeta.textContent = `Archivo: ${state.file || "-"} | Fecha QC: ${stamp}${suffix}`;
  qcLinkedStamp.textContent = `Sincronizado con Editor CSV | Fecha QC: ${stamp}`;
}

function onQcFieldChange(aggName, field, rawValue, source = "editor") {
  if (source === "editor" && field === "humedad") return;
  if (source === "dosificador" && field !== "humedad") return;
  if (!state.doser.quality[aggName]) state.doser.quality[aggName] = {};
  state.doser.quality[aggName][field] = toNumber(rawValue);
  setQcDirty(true);
  syncQcStamps();
  if (state.view === "dosificador") renderDosificador({ skipQc: source === "dosificador" });
  if (state.selectedQueryRow !== null) renderRecipeAndCosts(state.rows[state.selectedQueryRow]);
}

function renderEditorQcTable() {
  editorQcBody.innerHTML = "";
  QC_AGGREGATES.forEach((aggName) => {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = aggName;
    tr.appendChild(tdName);
    QC_FIELDS.forEach((field) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.className = "qc-input";
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.value = (state.doser.quality[aggName]?.[field] ?? 0).toString();
      const editable = state.auth.canEdit && field !== "humedad";
      input.disabled = !editable;
      if (!editable) input.classList.add("qc-input--readonly");
      if (editable) {
        input.addEventListener("input", () => onQcFieldChange(aggName, field, input.value, "editor"));
      }
      td.appendChild(input);
      tr.appendChild(td);
    });
    editorQcBody.appendChild(tr);
  });
  syncQcStamps();
}

function renderQcTable() {
  qcBody.innerHTML = "";
  QC_AGGREGATES.forEach((aggName) => {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = aggName;
    tr.appendChild(tdName);
    QC_FIELDS.forEach((field) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.className = "qc-input";
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.value = (state.doser.quality[aggName]?.[field] ?? 0).toString();
      const editable = state.auth.canEditQcHumidity && field === "humedad";
      input.disabled = !editable;
      if (!editable) input.classList.add("qc-input--readonly");
      if (editable) {
        input.addEventListener("input", () => onQcFieldChange(aggName, field, input.value, "dosificador"));
      }
      td.appendChild(input);
      tr.appendChild(td);
    });
    qcBody.appendChild(tr);
  });
  syncQcStamps();
}

function computeTheoreticalLoads(recipeItems) {
  const dose = Math.max(0, toNumber(doseM3Input.value));
  state.doser.dosageM3 = dose;
  const calc = computeDoserDetailedLoads(recipeItems, dose, state.doser.params);
  return calc.rows.map((item) => ({
    name: item.name,
    unit: item.trialUnit || item.unit,
    qty: item.trialLoad,
  }));
}

function renderDosificador(options = {}) {
  if (!options.skipQc) renderQcTable();
  renderRemisionList();
  state.doser.tolerances.cemento = toNumber(tolCementoInput.value || "1");
  state.doser.tolerances.agregados = toNumber(tolAgregadosInput.value || "3");
  state.doser.tolerances.agua = toNumber(tolAguaInput.value || "2");
  state.doser.tolerances.aditivo = toNumber(tolAditivoInput.value || "1");
  state.doser.params = readDoserParamsFromInputs();
  const dose = Math.max(0, toNumber(doseM3Input.value));
  state.doser.dosageM3 = dose;

  const entry = state.doser.selectedEntry;
  const selectedRow = entry ? entry.row : null;
  const baseSummary = `Dosificacion actual: ${formatNum(dose)} m<sup>3</sup>`;
  doserSummary.innerHTML = baseSummary;
  if (doserParamsMeta) {
    const stamp = state.doser.paramsUpdatedAt ? state.doser.paramsUpdatedAt : "sin guardar";
    const lockLabel = canEditDoserTolerances() ? "" : " | solo lectura";
    doserParamsMeta.textContent = `Parametros activos (${stamp})${lockLabel}`;
  }

  doserRecipeBody.innerHTML = "";
  doserTheoreticalBody.innerHTML = "";
  doserRealBody.innerHTML = "";
  doserRecipeWeight.textContent = "0.00";
  doserTheoreticalWeight.textContent = "0.00";
  doserRealWeight.textContent = "0.00";

  if (!selectedRow) {
    doserSelectedMeta.textContent = "Selecciona una mezcla para dosificar";
    return;
  }

  const isGlobal = !Array.isArray(selectedRow);
  const getV = (key) => isGlobal ? (selectedRow[key] || "") : valueByKey(selectedRow, key);

  doserSelectedMeta.textContent = `Formula: ${getV("formula") || "-"} | f'c: ${getV("fc") || "-"
    } | Edad: ${getV("edad") || "-"} | Tipo: ${getV("tipo") || "-"} | T.M.A.: ${getV("tma") || "-"
    } | Rev: ${getV("rev") || "-"} | Comp: ${getV("comp") || "-"}`;

  const recipeItems = normalizeDoserRecipeItems(extractRecipe(selectedRow));
  const detailed = computeDoserDetailedLoads(recipeItems, dose, state.doser.params);

  let recipeTotal = 0;
  detailed.rows.forEach((item) => {
    let displayUnit = item.unit;
    if (["Reductor", "Retardante"].includes(item.name)) displayUnit = "Lts/m3";
    else if (["Fibra", "Imper"].includes(item.name)) displayUnit = "kg/m3";

    const qty = item.designA;
    recipeTotal += qty * componentWeightFactor({ unit: item.unit });
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(formatNum(qty))} <span class="recipe-inline-unit">${escapeHtml(displayUnit)}</span></td>
    `;
    doserRecipeBody.appendChild(tr);
  });
  doserRecipeWeight.textContent = formatNum(recipeTotal);

  let theoTotal = 0;
  detailed.rows.forEach((item) => {
    theoTotal += item.trialLoad * componentWeightFactor({ unit: item.trialUnit || item.unit });
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(formatVol(item.designA))}</td>
      <td>${escapeHtml(formatVol(item.designSss))}</td>
      <td>${escapeHtml(formatVol(item.freeWater))}</td>
      <td>${escapeHtml(item.includeAbsVolume ? formatVol(item.absVolume) : "-")}</td>
      <td>${escapeHtml(formatVol(item.designReal))}</td>
      <td>${escapeHtml(formatVol(item.trialLoad))}</td>
      <td>${escapeHtml(item.trialUnit || item.unit)}</td>
      <td>${escapeHtml(item.note || "-")}</td>
    `;
    doserTheoreticalBody.appendChild(tr);
  });
  doserTheoreticalWeight.textContent = formatNum(theoTotal);
  doserSummary.innerHTML = `${baseSummary} | Rel. A/C: ${formatNum(detailed.totals.relAc || 0)} | Vol. Abs. + Aire: ${formatNum(detailed.totals.absVolumeTotal || 0)}`;

  let realTotal = 0;
  detailed.rows.forEach((item) => {
    if (typeof state.doser.realLoads[item.name] !== "number") {
      state.doser.realLoads[item.name] = item.trialLoad;
    }
    const real = state.doser.realLoads[item.name];
    realTotal += real * componentWeightFactor({ unit: item.trialUnit || item.unit });
    const diff = real - item.trialLoad;
    const tol = toleranceFor(item.name);
    const lim = item.trialLoad * (tol / 100);
    const ok = Math.abs(diff) <= lim;

    // Material Selection for Deduction
    const alias = item.name;
    const options = (state.doser.invMaterials || []).filter(m => m.doser_alias === alias);

    // Auto-select if only one option or preserve selection
    if (options.length === 1 && !state.doser.selectedMaterials[alias]) {
      state.doser.selectedMaterials[alias] = options[0].id;
    }
    const currentSelectedId = state.doser.selectedMaterials[alias];

    let matSelectHtml = `<select class="doser-mat-select"><option value="">-- Sin Descontar --</option>`;
    options.forEach(m => {
      const selected = Number(currentSelectedId) === m.id ? 'selected' : '';
      matSelectHtml += `<option value="${m.id}" ${selected}>${escapeHtml(m.name)}</option>`;
    });
    matSelectHtml += `</select>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${matSelectHtml}</td>
      <td>${escapeHtml(formatNum(item.trialLoad))}</td>
      <td><input class="doser-real-input" type="number" min="0" step="0.01" value="${real.toFixed(2)}"></td>
      <td>${escapeHtml(`${diff >= 0 ? "+" : ""}${formatNum(diff)}`)}</td>
      <td class="${ok ? "status-ok" : "status-bad"}">${escapeHtml(ok ? "OK" : "FUERA")}</td>
    `;

    // Listen to real value changes
    const input = tr.querySelector(".doser-real-input");
    let lastCommitted = toNumber(input.value);
    const commitRealValue = () => {
      const next = toNumber(input.value);
      if (next === lastCommitted) return;
      lastCommitted = next;
      state.doser.realLoads[item.name] = next;
      renderDosificador();
    };
    input.addEventListener("change", commitRealValue);
    input.addEventListener("blur", commitRealValue);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commitRealValue();
      input.blur();
    });

    // Listen to material selection changes
    const select = tr.querySelector(".doser-mat-select");
    select.addEventListener("change", () => {
      state.doser.selectedMaterials[alias] = select.value ? Number(select.value) : null;
    });

    doserRealBody.appendChild(tr);
  });
  doserRealWeight.textContent = formatNum(realTotal);
}
function applyQueryFilter(entry, filters) {
  const { row } = entry;
  const family = deriveFamily(row);
  const formula = valueByKey(row, "formula");
  const no = valueByKey(row, "no");
  const cod = valueByKey(row, "cod");

  if (filters.family) {
    const term = normalize(filters.family);
    const haystack = `${family} ${formula} ${no} ${cod}`;
    if (!normalize(haystack).includes(term)) return false;
  }
  if (filters.fc && normalize(valueByKey(row, "fc")) !== normalize(filters.fc)) return false;
  if (filters.edad && normalize(valueByKey(row, "edad")) !== normalize(filters.edad)) return false;
  if (filters.tipo && normalize(valueByKey(row, "tipo")) !== normalize(filters.tipo)) return false;
  if (filters.tma && normalize(valueByKey(row, "tma")) !== normalize(filters.tma)) return false;
  if (filters.rev && normalize(valueByKey(row, "rev")) !== normalize(filters.rev)) return false;
  if (filters.comp && normalize(valueByKey(row, "comp")) !== normalize(filters.comp)) return false;
  return true;
}

function adjustQueryVisibleRows(rowsToShow = 5) {
  if (!queryTable || !queryResultShell) return;
  const headerHeight = queryTable.tHead ? queryTable.tHead.offsetHeight : 0;
  const firstRow = queryBody.querySelector("tr");
  const rowHeight = firstRow ? firstRow.offsetHeight : 34;
  const shellHeight = Math.round(headerHeight + (rowHeight * rowsToShow) + 2);
  queryResultShell.style.maxHeight = `${shellHeight}px`;
  queryResultShell.style.minHeight = "0";
  queryResultShell.style.flex = "0 0 auto";
  queryResultShell.style.overflow = "auto";
}

function renderQueryResults() {
  queryBody.innerHTML = "";
  if (state.queryResults.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="9">No se encontraron resultados con esos filtros.</td>`;
    queryBody.appendChild(tr);
    querySummary.textContent = "Resultados: 0";
    renderRecipeAndCosts(null);
    setConsultaStep(0);
    adjustQueryVisibleRows(5);
    return;
  }

  state.queryResults.forEach((entry) => {
    const row = entry.row;
    const tr = document.createElement("tr");
    if (entry.sourceIndex === state.selectedQueryRow) tr.classList.add("is-selected");
    tr.innerHTML = `
      <td>${escapeHtml(deriveFamily(row))}</td>
      <td>${escapeHtml(valueByKey(row, "formula") || "-")}</td>
      <td>${escapeHtml(valueByKey(row, "fc") || "-")}</td>
      <td>${escapeHtml(valueByKey(row, "edad") || "-")}</td>
      <td>${escapeHtml(valueByKey(row, "tipo") || "-")}</td>
      <td>${escapeHtml(valueByKey(row, "tma") || "-")}</td>
      <td>${escapeHtml(valueByKey(row, "rev") || "-")}</td>
      <td>${escapeHtml(valueByKey(row, "comp") || "-")}</td>
      <td>${escapeHtml(getRowModDate(row) || "-")}</td>
    `;
    tr.addEventListener("click", () => {
      state.selectedQueryRow = entry.sourceIndex;
      renderQueryResults();
      renderRecipeAndCosts(state.rows[entry.sourceIndex]);
      setConsultaStep(1);
    });
    queryBody.appendChild(tr);
  });

  querySummary.textContent = `Resultados: ${state.queryResults.length} (clic en una fila para ver receta)`;
  if (!state.queryResults.some((item) => item.sourceIndex === state.selectedQueryRow)) {
    state.selectedQueryRow = state.queryResults[0].sourceIndex;
  }
  renderRecipeAndCosts(state.rows[state.selectedQueryRow]);
  adjustQueryVisibleRows(5);
}

function runQuery() {
  const filters = {
    family: queryFields.family.value.trim(),
    fc: queryFields.fc.value,
    edad: queryFields.edad.value,
    tipo: queryFields.tipo.value,
    tma: queryFields.tma.value,
    rev: queryFields.rev.value,
    comp: queryFields.comp.value,
  };

  const mapped = state.rows.map((row, sourceIndex) => ({ row, sourceIndex }));
  state.queryResults = mapped.filter((entry) => applyQueryFilter(entry, filters));
  renderQueryResults();
}

function populateQuerySelectors() {
  fillSelect(queryFields.fc, getUniqueValues("fc"));
  fillSelect(queryFields.edad, getUniqueValues("edad"));
  fillSelect(queryFields.tipo, getUniqueValues("tipo"));
  fillSelect(queryFields.tma, getUniqueValues("tma"));
  fillSelect(queryFields.rev, getUniqueValues("rev"));
  fillSelect(queryFields.comp, getUniqueValues("comp"));
}

function refreshConsulta() {
  buildHeaderIndex();
  populateQuerySelectors();
  fillDoserSelectors();
  renderFamiliesBoard();
  runQuery();
  runDoserSearch();
}

function syncDoserParamInputs() {
  const p = state.doser.params || defaultDoserParams();
  if (paramCementoPespInput) paramCementoPespInput.value = (p.cemento_pesp ?? 0).toString();
  if (paramAirePctInput) paramAirePctInput.value = (p.aire_pct ?? 0).toString();
  if (paramPasa200PctInput) paramPasa200PctInput.value = (p.pasa_malla_200_pct ?? 0).toString();
  if (paramPxlPctInput) paramPxlPctInput.value = (p.pxl_pond_pct ?? 0).toString();
  if (paramDensidadAggInput) paramDensidadAggInput.value = (p.densidad_agregado_fallback ?? 0).toString();
}

function readDoserParamsFromInputs() {
  return normalizeDoserParams({
    cemento_pesp: paramCementoPespInput?.value,
    aire_pct: paramAirePctInput?.value,
    pasa_malla_200_pct: paramPasa200PctInput?.value,
    pxl_pond_pct: paramPxlPctInput?.value,
    densidad_agregado_fallback: paramDensidadAggInput?.value,
  });
}

async function loadQcData(fileName = state.file) {
  state.qcError = "";
  try {
    const response = await apiFetch(`/api/qc?file=${encodeURIComponent(fileName || "")}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo cargar Control de Calidad.");
    }
    state.qcVersion = Number.isFinite(Number(payload.version)) ? Number(payload.version) : 0;
    state.qcUpdatedAt = payload.updated_at || "";
    state.doser.quality = normalizeQualityValues(payload.values);
    setQcDirty(false);
  } catch (error) {
    state.qcVersion = 0;
    state.qcUpdatedAt = "";
    state.doser.quality = createDefaultQuality();
    state.qcError = String(error);
    setQcDirty(false);
  }
  renderEditorQcTable();
}

async function loadDoserParams(fileName = state.file) {
  try {
    const response = await apiFetch(`/api/doser/params?file=${encodeURIComponent(fileName || "")}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudieron cargar parametros de dosificacion.");
    }
    state.doser.paramsVersion = Number.isFinite(Number(payload.version)) ? Number(payload.version) : 0;
    state.doser.paramsUpdatedAt = payload.updated_at || "";
    state.doser.params = normalizeDoserParams(payload.values);
  } catch (error) {
    state.doser.paramsVersion = 0;
    state.doser.paramsUpdatedAt = "";
    state.doser.params = defaultDoserParams();
    setStatus(String(error), "warn");
  }
  syncDoserParamInputs();
}

let isSavingDoserParams = false;
async function saveDoserParams() {
  if (isSavingDoserParams) return;
  isSavingDoserParams = true;
  if (typeof saveDoserParamsBtn !== "undefined" && saveDoserParamsBtn) saveDoserParamsBtn.disabled = true;

  if (!canEditDoserTolerances()) {
    setStatus("Solo administrador y jefe-de-planta pueden guardar parametros de dosificacion.", "warn");
    return;
  }
  try {
    const values = readDoserParamsFromInputs();
    const response = await apiFetch("/api/doser/params/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: state.file,
        version: state.doser.paramsVersion,
        values,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      if (response.status === 409) {
        throw new Error("Conflicto de version en parametros de dosificacion. Recarga y vuelve a intentar.");
      }
      throw new Error(payload.error || "No se pudieron guardar parametros de dosificacion.");
    }
    state.doser.paramsVersion = Number(payload.version || 0);
    state.doser.paramsUpdatedAt = payload.updated_at || "";
    state.doser.params = normalizeDoserParams(payload.values);
    syncDoserParamInputs();
    renderDosificador();
    setStatus("Parametros de dosificacion guardados.", "ok");
  } catch (error) {
    setStatus(String(error), "err");
  } finally {
    isSavingDoserParams = false;
    if (typeof saveDoserParamsBtn !== "undefined" && saveDoserParamsBtn) saveDoserParamsBtn.disabled = false;
  }
}

let isSavingQcData = false;
async function saveQcData() {
  if (isSavingQcData) return;
  isSavingQcData = true;
  if (typeof saveQcBtn !== "undefined" && saveQcBtn) saveQcBtn.disabled = true;

  try {
    const response = await apiFetch("/api/qc/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: state.file,
        version: state.qcVersion,
        values: state.doser.quality,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      if (response.status === 409) {
        throw new Error("Conflicto de version en Control de Calidad. Recarga y vuelve a intentar.");
      }
      throw new Error(payload.error || "No se pudo guardar Control de Calidad.");
    }
    state.qcVersion = Number(payload.version || 0);
    state.qcUpdatedAt = payload.updated_at || "";
    state.doser.quality = normalizeQualityValues(payload.values);
    state.qcError = "";
    setQcDirty(false);
    renderEditorQcTable();
    renderDosificador();
    if (state.selectedQueryRow !== null) renderRecipeAndCosts(state.rows[state.selectedQueryRow]);
    setStatus("Control de Calidad guardado.", "ok");
  } catch (error) {
    setStatus(String(error), "err");
  } finally {
    isSavingQcData = false;
    if (typeof saveQcBtn !== "undefined" && saveQcBtn) saveQcBtn.disabled = false;
  }
}

let isSavingQcHumidity = false;
async function saveQcHumidityData() {
  if (isSavingQcHumidity) return;
  isSavingQcHumidity = true;
  if (typeof saveQcHumidityBtn !== "undefined" && saveQcHumidityBtn) saveQcHumidityBtn.disabled = true;

  if (!state.auth.canEditQcHumidity) {
    setStatus("No tienes permisos para guardar humedad.", "warn");
    return;
  }
  try {
    const humidityValues = {};
    QC_AGGREGATES.forEach((agg) => {
      humidityValues[agg] = {
        humedad: toNumber(state.doser.quality[agg]?.humedad ?? 0),
      };
    });
    const response = await apiFetch("/api/qc/humidity/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: state.file,
        version: state.qcVersion,
        values: humidityValues,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      if (response.status === 409) {
        await loadQcData(state.file);
        throw new Error(payload.error || "Conflicto de versión. Los datos fueron recargados; verifica e intenta de nuevo.");
      }
      throw new Error(payload.error || "No se pudo guardar la humedad.");
    }
    state.qcVersion = Number(payload.version || 0);
    state.qcUpdatedAt = payload.updated_at || "";
    state.doser.quality = normalizeQualityValues(payload.values);
    state.qcError = "";
    setQcDirty(false);
    renderEditorQcTable();
    renderDosificador();
    if (state.selectedQueryRow !== null) renderRecipeAndCosts(state.rows[state.selectedQueryRow]);
    setStatus("Humedad guardada correctamente.", "ok");
  } catch (error) {
    setStatus(String(error), "err");
  } finally {
    isSavingQcHumidity = false;
    if (typeof saveQcHumidityBtn !== "undefined" && saveQcHumidityBtn) saveQcHumidityBtn.disabled = false;
  }
}

async function loadData() {
  try {
    const response = await apiFetch("/api/data");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo cargar el archivo.");

    state.file = payload.file;
    state.files = payload.files || [];
    state.fileInfos = Array.isArray(payload.file_infos)
      ? payload.file_infos
        .map((info) => ({
          name: (info?.name || "").toString(),
          family: (info?.family || "").toString().trim(),
        }))
        .filter((info) => info.name)
      : state.files.map((name) => ({ name: (name || "").toString(), family: "" }));
    state.datasetFamily = (payload.family || "").toString().trim();
    state.version = Number.isFinite(Number(payload.version)) ? Number(payload.version) : null;
    state.encoding = payload.encoding;
    state.delimiter = payload.delimiter;
    state.updatedAt = payload.updated_at || "";
    state.headers = payload.headers || [];
    state.rows = payload.rows || [];
    ensureModDateColumn();
    state.selected.clear();
    state.sort = { col: null, dir: "asc" };
    state.searchText = "";
    searchInput.value = "";
    setDirty(false);
    await loadQcData(state.file);
    await loadDoserParams(state.file);
    renderFileSelect();
    if (datasetFamilyInput) datasetFamilyInput.value = state.datasetFamily;
    render();
    refreshConsulta();
    await loadRemisiones();
    setStatus("Archivo cargado correctamente.", "ok");
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function selectActiveFile(fileName) {
  try {
    const response = await apiFetch("/api/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: fileName }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo cambiar el archivo.");
    setStatus(`Archivo activo: ${payload.file}`, "ok");
    await loadData();
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function saveDatasetFamily() {
  if (!datasetFamilyInput) return;
  const familyCode = datasetFamilyInput.value.trim().toUpperCase();
  if (!familyCode) {
    setStatus("La familia no puede quedar vacia.", "warn");
    return;
  }
  try {
    const response = await apiFetch("/api/family", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: state.file,
        family_code: familyCode,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo guardar la familia.");
    }
    state.datasetFamily = (payload.family || "").toString().trim();
    if (Array.isArray(payload.file_infos)) {
      state.fileInfos = payload.file_infos
        .map((info) => ({
          name: (info?.name || "").toString(),
          family: (info?.family || "").toString().trim(),
        }))
        .filter((info) => info.name);
      state.files = state.fileInfos.map((item) => item.name);
    }
    datasetFamilyInput.value = state.datasetFamily;
    renderFileSelect();
    refreshConsulta();
    renderMeta(getProcessedRows().length);
    setStatus(`Familia actualizada: ${state.datasetFamily}`, "ok");
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function chooseImportMode(preview) {
  const duplicateMsg = preview.duplicate_of
    ? `\nDetectado contenido duplicado de: ${preview.duplicate_of}`
    : "";
  const suggested = preview.suggested_mode || "new";
  const answer = await uiPrompt(
    `Modo de importacion (${preview.allowed_modes.join(" | ")}). Recomendado: ${suggested}.${duplicateMsg}`,
    suggested,
    {
      title: "Importacion de CSV",
      confirmText: "Seleccionar",
    }
  );
  if (answer === null) return null;
  const mode = answer.trim().toLowerCase();
  if (!preview.allowed_modes.includes(mode)) {
    throw new Error("Modo invalido. Usa new, replace o merge.");
  }
  return mode;
}

async function chooseFamilyCode(preview, mode) {
  const detected = (preview.family_guess || "").toString().trim().toUpperCase();
  const current = (state.datasetFamily || "").toString().trim().toUpperCase();
  const defaultValue = mode === "new" ? detected : detected || current;
  const promptText =
    mode === "new"
      ? `Familia detectada: ${detected || "no detectada"}.\nConfirma o escribe la familia del nuevo dataset (ej. 40, 60, 70).`
      : `Familia detectada en CSV: ${detected || "no detectada"}.\nEscribe la familia para el dataset destino o deja vacio para mantener la actual (${current || "-"})`;
  const answer = await uiPrompt(promptText, defaultValue, {
    title: "Familia del dataset",
    confirmText: "Continuar",
  });
  if (answer === null) return null;
  const family = answer.trim().toUpperCase();
  if (mode === "new" && !family) {
    throw new Error("La familia es requerida para crear un dataset nuevo.");
  }
  return family;
}

function describeValidation(preview) {
  const v = preview.validation || { errors: [], warnings: [], stats: { rows: 0, columns: 0 } };
  const parts = [`Filas: ${v.stats.rows}`, `Columnas: ${v.stats.columns}`, `Hash: ${preview.hash}`];
  if (preview.family_guess) parts.push(`Familia detectada: ${preview.family_guess}`);
  if (preview.duplicate_of) parts.push(`Duplicado de: ${preview.duplicate_of}`);
  if (Array.isArray(preview.header_mapping) && preview.header_mapping.length) {
    const sample = preview.header_mapping
      .slice(0, 6)
      .map((item) => `${item.from} -> ${item.to}`)
      .join(" | ");
    parts.push(`Mapeo de columnas: ${sample}${preview.header_mapping.length > 6 ? " | ..." : ""}`);
  }
  if ((v.warnings || []).length) parts.push(`Advertencias: ${v.warnings.join(" | ")}`);
  return parts.join(" | ");
}

async function uploadNewCsv(file) {
  const form = new FormData();
  form.append("file", file);
  try {
    const previewResp = await apiFetch("/api/upload/preview", { method: "POST", body: form });
    const preview = await previewResp.json();
    if (!previewResp.ok || !preview.ok) {
      const msg = preview?.validation?.errors?.join(" | ") || preview.error || "No se pudo validar el CSV.";
      throw new Error(msg);
    }

    const mode = await chooseImportMode(preview);
    if (!mode) return;
    const familyCode = await chooseFamilyCode(preview, mode);
    if (familyCode === null) return;
    const targetFile = mode === "new" ? null : state.file;
    if (mode === "replace") {
      const ok = await uiConfirm(
        `Vas a REEMPLAZAR el dataset '${targetFile}'. Esta accion conserva historial pero cambia todo el contenido.`,
        {
          title: "Confirmar reemplazo",
          confirmText: "Reemplazar",
          tone: "warn",
        }
      );
      if (!ok) return;
    }

    const commitResp = await apiFetch("/api/upload/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: preview.token,
        mode,
        target_file: targetFile,
        family_code: familyCode,
      }),
    });
    const payload = await commitResp.json();
    if (!commitResp.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo confirmar la importacion.");
    }

    const summary =
      mode === "merge"
        ? `Merge listo: insertadas ${payload.inserted || 0}, actualizadas ${payload.updated || 0}.`
        : mode === "replace"
          ? `Dataset reemplazado: ${payload.file}.`
          : `Dataset cargado: ${payload.file}.`;
    setStatus(`${summary} ${describeValidation(preview)}`, "ok");
    await loadData();
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function deleteCsvFile(fileName) {
  try {
    const response = await apiFetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: fileName }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo eliminar el archivo.");
    setStatus(`Dataset eliminado: ${payload.deleted}.`, "ok");
    await loadData();
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function openHistoryDialog() {
  try {
    const response = await apiFetch(`/api/history?file=${encodeURIComponent(state.file)}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo obtener historial.");
    }
    const revisions = payload.revisions || [];
    if (!revisions.length) {
      setStatus("No hay revisiones disponibles para restaurar.", "warn");
      return;
    }
    const top = revisions.slice(0, 20);
    const lines = top.map(
      (r) => `${r.id} | ${r.created_at} | filas:${r.row_count}${r.note ? ` | ${r.note}` : ""}`
    );
    const idText = await uiPrompt(
      `Historial (${payload.file}) v${payload.version}\nIngresa el ID de revision a restaurar:\n\n${lines.join(
        "\n"
      )}`,
      "",
      {
        title: "Restaurar historial",
        confirmText: "Restaurar",
      }
    );
    if (idText === null) return;
    const revisionId = Number(idText);
    if (!Number.isInteger(revisionId) || revisionId <= 0) {
      setStatus("ID de revision invalido.", "warn");
      return;
    }
    const ok = await uiConfirm(
      `Vas a restaurar la revision ${revisionId}. Se guardara una revision del estado actual antes de restaurar.`,
      {
        title: "Confirmar restauracion",
        confirmText: "Restaurar",
        tone: "warn",
      }
    );
    if (!ok) return;
    await restoreRevision(revisionId);
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function restoreRevision(revisionId) {
  const response = await apiFetch("/api/history/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision_id: revisionId,
      file: state.file,
      version: state.version,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    if (response.status === 409) {
      throw new Error("Conflicto de version al restaurar. Recarga y vuelve a intentar.");
    }
    throw new Error(payload.error || "No se pudo restaurar revision.");
  }
  setStatus(`Revision ${revisionId} restaurada.`, "ok");
  await loadData();
}

async function openAuditDialog() {
  try {
    const response = await apiFetch(`/api/audit?file=${encodeURIComponent(state.file || "")}&limit=120`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo cargar la bitacora.");
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      setStatus("Bitacora sin eventos para el dataset actual.", "warn");
      return;
    }
    const lines = items.slice(0, 40).map((item) => {
      const detailKeys = Object.keys(item.details || {});
      const detailText = detailKeys.length
        ? detailKeys
          .slice(0, 3)
          .map((k) => `${k}:${item.details[k]}`)
          .join(", ")
        : "-";
      return `${item.id} | ${item.created_at} | ${item.username || "-"} | ${item.action} | ${detailText}`;
    });
    await uiDialog({
      mode: "confirm",
      title: "Bitacora de cambios",
      message: lines.join("\n"),
      confirmText: "Cerrar",
      cancelText: "Cerrar",
      tone: "info",
    });
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function createManualBackup() {
  try {
    const reason = await uiPrompt("Motivo del respaldo (opcional):", "manual", {
      title: "Crear respaldo",
      confirmText: "Crear",
      tone: "info",
    });
    if (reason === null) return;
    const response = await apiFetch("/api/backups/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo crear el respaldo.");
    }
    const backup = payload.backup || {};
    setStatus(`Respaldo creado: ${backup.file || "-"}.`, "ok");
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function restoreBackupFromDialog() {
  try {
    const response = await apiFetch("/api/backups?limit=80");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo obtener respaldos.");
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      setStatus("No hay respaldos disponibles.", "warn");
      return;
    }
    const previewLines = items
      .slice(0, 20)
      .map((item) => `${item.file} | ${item.created_at} | ${(item.reason || "").replace(/_/g, " ")}`);
    const selected = await uiPrompt(
      `Escribe el nombre exacto del respaldo a restaurar:\n\n${previewLines.join("\n")}`,
      items[0].file,
      {
        title: "Restaurar respaldo",
        confirmText: "Continuar",
        tone: "warn",
      }
    );
    if (selected === null) return;
    const file = selected.trim();
    if (!file) {
      setStatus("Debes indicar el nombre del respaldo.", "warn");
      return;
    }
    const ok = await uiConfirm(
      `Se restaurara el respaldo '${file}'. Se recomienda que no haya usuarios editando durante este proceso.`,
      {
        title: "Confirmar restauracion de respaldo",
        confirmText: "Restaurar",
        tone: "err",
      }
    );
    if (!ok) return;

    const restoreResp = await apiFetch("/api/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    const restorePayload = await restoreResp.json();
    if (!restoreResp.ok || !restorePayload.ok) {
      throw new Error(restorePayload.error || "No se pudo restaurar el respaldo.");
    }
    setStatus(`Respaldo restaurado: ${file}.`, "ok");
    await loadData();
  } catch (error) {
    setStatus(String(error), "err");
  }
}

async function saveData() {
  try {
    ensureModDateColumn();
    const response = await apiFetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headers: state.headers,
        rows: state.rows,
        version: state.version,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      if (response.status === 409) {
        throw new Error("Conflicto de version: otro cambio ya fue guardado. Recarga y vuelve a intentar.");
      }
      throw new Error(payload.error || "No se pudo guardar.");
    }
    if (Number.isFinite(Number(payload.version))) {
      state.version = Number(payload.version);
    }
    setDirty(false);
    setStatus("Cambios guardados en SQLite.", "ok");
    await loadData();
  } catch (error) {
    setStatus(String(error), "err");
  }
}

function addRow() {
  const modColIndex = ensureModDateColumn();
  const row = Array(state.headers.length).fill("");
  row[modColIndex] = nowStamp();
  state.rows.push(row);
  setDirty(true);
  setStatus("Fila agregada.", "ok");
  renderBody();
  refreshConsulta();
}

function deleteSelectedRows() {
  if (state.selected.size === 0) {
    setStatus("Selecciona al menos una fila para eliminar.", "warn");
    return;
  }
  const indexes = [...state.selected].sort((a, b) => b - a);
  indexes.forEach((index) => state.rows.splice(index, 1));
  state.selected.clear();
  setDirty(true);
  setStatus(`Se eliminaron ${indexes.length} fila(s).`, "ok");
  renderBody();
  refreshConsulta();
}

document.getElementById("reloadBtn").addEventListener("click", async () => {
  if (state.dirty || state.qcDirty) {
    const proceed = await uiConfirm("Hay cambios sin guardar. Deseas recargar de todos modos?", {
      title: "Recargar datos",
      confirmText: "Recargar",
      tone: "warn",
    });
    if (!proceed) return;
  }
  loadData();
});

document.getElementById("addBtn").addEventListener("click", addRow);
document.getElementById("deleteBtn").addEventListener("click", deleteSelectedRows);
document.getElementById("saveBtn").addEventListener("click", saveData);
document.getElementById("saveQcBtn").addEventListener("click", saveQcData);
if (saveQcHumidityBtn) saveQcHumidityBtn.addEventListener("click", saveQcHumidityData);
document.getElementById("historyBtn").addEventListener("click", openHistoryDialog);
if (auditBtn) auditBtn.addEventListener("click", openAuditDialog);
if (backupCreateBtn) backupCreateBtn.addEventListener("click", createManualBackup);
if (backupRestoreBtn) backupRestoreBtn.addEventListener("click", restoreBackupFromDialog);

document.getElementById("loadSelectedBtn").addEventListener("click", async () => {
  const selectedFile = fileSelect.value;
  if (!selectedFile) return setStatus("No hay archivo seleccionado.", "warn");
  if (state.dirty || state.qcDirty) {
    const proceed = await uiConfirm("Hay cambios sin guardar. Cambiar de archivo puede descartarlos. Continuar?", {
      title: "Cambiar archivo",
      confirmText: "Cambiar",
      tone: "warn",
    });
    if (!proceed) return;
  }
  await selectActiveFile(selectedFile);
});

if (saveFamilyBtn) {
  saveFamilyBtn.addEventListener("click", saveDatasetFamily);
}
if (datasetFamilyInput) {
  datasetFamilyInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveDatasetFamily();
  });
}

document.getElementById("uploadBtn").addEventListener("click", async () => {
  if (state.dirty || state.qcDirty) {
    const proceed = await uiConfirm("Hay cambios sin guardar. Cargar otro CSV puede descartarlos. Continuar?", {
      title: "Cargar nuevo CSV",
      confirmText: "Continuar",
      tone: "warn",
    });
    if (!proceed) return;
  }
  uploadInput.value = "";
  uploadInput.click();
});

document.getElementById("deleteFileBtn").addEventListener("click", async () => {
  const selectedFile = fileSelect.value;
  if (!selectedFile) return setStatus("No hay archivo seleccionado para eliminar.", "warn");
  if (state.dirty || state.qcDirty) {
    const proceed = await uiConfirm("Hay cambios sin guardar. Eliminar un CSV puede descartar estos cambios. Continuar?", {
      title: "Eliminar CSV",
      confirmText: "Continuar",
      tone: "warn",
    });
    if (!proceed) return;
  }
  const confirmDelete = await uiConfirm(
    `Seguro que quieres eliminar el dataset '${selectedFile}'?`,
    {
      title: "Confirmar eliminacion",
      confirmText: "Eliminar",
      tone: "err",
    }
  );
  if (!confirmDelete) return;
  await deleteCsvFile(selectedFile);
});

// Purga definitiva (Hard Reset) - Solo Admin
const purgeBtn = document.getElementById("purgeDeletedBtn");
if (purgeBtn) {
  purgeBtn.addEventListener("click", async () => {
    const confirmHard = await uiConfirm(
      "¿Estás seguro de que deseas eliminar DEFINITIVAMENTE todos los archivos borrados? Esto eliminará también todas las REMISIONES vinculadas a ellos.",
      {
        title: "Hard Reset - Purga Definitiva",
        confirmText: "Si, entiendo el riesgo",
        tone: "err",
      }
    );
    if (!confirmHard) return;

    const finalBoss = await uiConfirm(
      "¡ADVERTENCIA CRÍTICA! Esta acción borrará permanentemente el historial de remisiones, transacciones de inventario y perfiles. No se puede deshacer. ¿Deseas purgar todo ahora?",
      {
        title: "Confirmacion Final Irreversible",
        confirmText: "BORRAR TODO DEFINITIVAMENTE",
        tone: "err",
      }
    );
    if (!finalBoss) return;

    setStatus("Purgando archivos de la base de datos...", "info");
    try {
      const resp = await apiFetch("/api/purge_deleted", { method: "POST" });
      const res = await resp.json();
      if (res.ok) {
        setStatus(`Purga completada: ${res.purged_count} archivos eliminados físicamente.`, "ok");
        await loadFiles();
      } else {
        setStatus("Error al purgar: " + (res.error || "Error desconocido"), "err");
      }
    } catch (err) {
      setStatus("Error de red al purgar: " + err.message, "err");
    }
  });
}

uploadInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".csv")) return setStatus("Selecciona un archivo con extension .csv", "warn");
  await uploadNewCsv(file);
});

searchInput.addEventListener("input", (event) => {
  state.searchText = event.target.value;
  renderBody();
});

tabEditor.addEventListener("click", () => switchView("editor"));
tabConsulta.addEventListener("click", () => {
  switchView("consulta");
  runQuery();
});
if (tabDosificador) {
  tabDosificador.addEventListener("click", () => {
    if (remisionFilterDate && !remisionFilterDate.value) {
      remisionFilterDate.value = getTodayPuertoMorelos();
    }
    switchView("dosificador");
    loadRemisiones();
    loadGlobalRecipes();
  });
}
if (tabRemisiones) {
  tabRemisiones.addEventListener("click", () => {
    ensureRemisionesFilters();
    switchView("remisiones");
  });
}
if (consultaPrevBtn) {
  consultaPrevBtn.addEventListener("click", () => setConsultaStep(state.consultaStep - 1));
}
if (consultaNextBtn) {
  consultaNextBtn.addEventListener("click", () => setConsultaStep(state.consultaStep + 1));
}

document.getElementById("runQueryBtn").addEventListener("click", runQuery);
exportReportBtn.addEventListener("click", exportConsultaReport);
if (toggleQuoteModeBtn) {
  toggleQuoteModeBtn.addEventListener("click", () => {
    state.quoteMode = !state.quoteMode;
    if (!state.quoteMode) state.quoteOverrides = {};
    toggleQuoteModeBtn.textContent = state.quoteMode ? "Salir Cotización" : "Modo Cotización";
    toggleQuoteModeBtn.classList.toggle("btn--active", state.quoteMode);
    toggleQuoteModeBtn.classList.toggle("btn--muted", !state.quoteMode);
    // Re-render cost table with current recipe
    const selectedIndex = state.selectedQueryRow;
    const row = typeof selectedIndex === "number" ? state.rows[selectedIndex] : null;
    if (row) {
      const recipeItems = normalizeConsultaRecipeItems(extractRecipe(row));
      const adjustedForCost = adjustRecipeByQuality(recipeItems, 1);
      renderCostTable(adjustedForCost);
    }
  });
}
document.getElementById("clearQueryBtn").addEventListener("click", () => {
  queryFields.family.value = "";
  if (doserFields.family) doserFields.family.value = "";
  queryFields.fc.value = "";
  queryFields.edad.value = "";
  queryFields.tipo.value = "";
  queryFields.tma.value = "";
  queryFields.rev.value = "";
  queryFields.comp.value = "";
  runQuery();
});

Object.values(queryFields).forEach((el) => {
  el.addEventListener("change", runQuery);
});

document.getElementById("dSearchBtn").addEventListener("click", runDoserSearch);
if (doserExportReportBtn) doserExportReportBtn.addEventListener("click", exportDoserReport);
if (saveDoserParamsBtn) saveDoserParamsBtn.addEventListener("click", saveDoserParams);
if (saveRemisionBtn) saveRemisionBtn.addEventListener("click", saveRemision);
if (refreshRemisionBtn) {
  refreshRemisionBtn.addEventListener("click", () => {
    loadRemisiones();
  });
}
if (remisionesRefreshBtn) {
  remisionesRefreshBtn.addEventListener("click", () => {
    loadRemisionesView();
  });
}
if (remisionDateInput && !remisionDateInput.value) {
  remisionDateInput.value = getTodayPuertoMorelos();
}
if (remisionFilterDate) {
  remisionFilterDate.addEventListener("change", () => {
    loadRemisiones();
  });
}
if (remisionesSearchInput) {
  remisionesSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    loadRemisionesView();
  });
}
[remisionesDateFrom, remisionesDateTo].forEach((el) => {
  if (!el) return;
  el.addEventListener("change", () => {
    loadRemisionesView();
  });
});
if (remisionNoInput) {
  remisionNoInput.addEventListener("input", () => {
    remisionNoInput.value = remisionNoInput.value.toUpperCase();
  });
  remisionNoInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveRemision();
  });
}
[remisionClienteInput, remisionUbicacionInput].forEach((el) => {
  if (!el) return;
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveRemision();
  });
});
document.getElementById("dClearBtn").addEventListener("click", () => {
  doserFields.family.value = "";
  doserFields.fc.value = "";
  doserFields.edad.value = "";
  doserFields.tipo.value = "";
  doserFields.tma.value = "";
  doserFields.rev.value = "";
  doserFields.comp.value = "";
  runDoserSearch();
});

[
  doseM3Input,
  tolCementoInput,
  tolAgregadosInput,
  tolAguaInput,
  tolAditivoInput,
  paramCementoPespInput,
  paramAirePctInput,
  paramPasa200PctInput,
  paramPxlPctInput,
  paramDensidadAggInput,
].forEach((el) => {
  if (!el) return;
  el.addEventListener("input", () => renderDosificador());
});

document.addEventListener("keydown", (event) => {
  const ctrlOrCmd = event.ctrlKey || event.metaKey;
  if (ctrlOrCmd && event.key.toLowerCase() === "s") {
    if (!state.auth.canEdit || !canAccessView("editor")) return;
    event.preventDefault();
    saveData();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty && !state.qcDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("resize", () => adjustQueryVisibleRows(5));

if (tabLaboratorio) {
  tabLaboratorio.addEventListener("click", () => {
    if (!canAccessView("laboratorio")) return;
    switchView("laboratorio");
    if (typeof window.initQcLab === "function") window.initQcLab();
    if (typeof window.loadQcLabData === "function") window.loadQcLabData();
  });
}

if (tabUsuarios) {
  tabUsuarios.addEventListener("click", () => switchView("usuarios"));
}

applyRoleAccessUi();
switchView(defaultView());
loadData();



// --- Exports for other modules (e.g., fleet.js) ---
window.AppGlobals = {
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
  tabInventario,
  uiDialogHost,
  uiToastHost,
  renderDosificador,
  uiConfirm,
  BRAND_LOGO_URL,
  getTodayPuertoMorelos,
  getFullTodayPuertoMorelos
};
