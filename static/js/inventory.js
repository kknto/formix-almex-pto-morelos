/**
 * Inventory Management Module
 * Connects with the `/api/inventory` endpoints.
 */
(function (globals) {
  if (!globals) {
    console.error("AppGlobals no encontrado. Asegurate de cargar app.js antes que inventory.js");
    return;
  }

  const {
    state,
    escapeHtml,
    formatNum,
    canAccessView,
    switchView,
    tabInventario,
    uiDialogHost,
    uiToastHost,
    BRAND_LOGO_URL,
    getFullTodayCancun
  } = globals;

  // --- DOM Elements ---
  const invStatusBar = document.getElementById("invStatusBar");
  const invMaterialsBody = document.getElementById("maintBody");
  const invTransactionsBody = document.getElementById("invTransactionsBody");
  const invDashboardGrid = document.getElementById("invDashboardGrid");
  const invReloadBtn = document.getElementById("invReloadBtn");
  const invAddMaterialBtn = document.getElementById("invAddMaterialBtn");
  const invAddTransactionBtn = document.getElementById("invAddTransactionBtn");
  const invTrxFilter = document.getElementById("invTrxFilter");
  const invGenDailyReportBtn = document.getElementById("invGenDailyReportBtn");
  const invDailyReportDate = document.getElementById("invDailyReportDate");
  const printDailyReportBtn = document.getElementById("printDailyReportBtn");

  // --- State ---
  let invMaterials = [];
  let invTransactions = [];

  // --- API Fetch Wrapper (reusing auth strategy) ---
  async function invFetch(url, opts = {}) {
    const csrfToken = state.auth.csrfToken || "";
    const headers = { "X-CSRF-Token": csrfToken, ...(opts.headers || {}) };

    if (opts.method && opts.method !== "GET") {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      if (opts.body) {
        try {
          const parsed = JSON.parse(opts.body);
          parsed._csrf_token = csrfToken;
          opts = { ...opts, body: JSON.stringify(parsed) };
        } catch (e) { /* body is not JSON, leave as-is */ }
      } else if (!opts.body) {
        opts = { ...opts, body: JSON.stringify({ _csrf_token: csrfToken }) };
      }
    }
    const res = await window.fetch(url, { ...opts, headers, credentials: "same-origin" });
    return res.json();
  }

  function setInvStatus(msg, tone = "ok") {
    if (!invStatusBar) return;
    invStatusBar.textContent = msg;
    invStatusBar.className = `status ${tone === "warn" ? "status--warn" : tone === "err" ? "status--error" : ""}`;
  }

  // --- Main Data Loaders ---
  async function loadInventoryData() {
    setInvStatus("Cargando inventario...", "warn");
    try {
      const res = await invFetch("/api/inventory/materials");
      if (!res.ok) throw new Error(res.error || "Error al cargar materiales");
      invMaterials = res.materials || [];
      state.doser.invMaterials = invMaterials;
      renderMaterialsTab();
      renderDashboard();
      populateMaterialSelects();
      if (AppGlobals.state && AppGlobals.state.view === "dosificador" && typeof AppGlobals.renderDosificador === "function") {
        AppGlobals.renderDosificador();
      }
      await loadTransactions();

      const isAdmin = window.AppGlobals && window.AppGlobals.state && window.AppGlobals.state.auth && window.AppGlobals.state.auth.role === "administrador";
      const purgeBtn = document.getElementById("adminPurgeInactiveBtn");
      if (purgeBtn) purgeBtn.style.display = isAdmin ? "inline-block" : "none";

      setInvStatus(`Cargados ${invMaterials.length} materiales locales.`, "ok");
    } catch (err) {
      setInvStatus(String(err), "err");
    }
  }

  async function loadTransactions() {
    try {
      const matId = invTrxFilter.value;
      const url = matId ? `/api/inventory/transactions?material_id=${encodeURIComponent(matId)}&limit=100` : "/api/inventory/transactions?limit=100";
      const res = await invFetch(url);
      if (!res.ok) throw new Error(res.error || "Error al cargar movimientos");
      invTransactions = res.transactions || [];
      renderTransactions();
    } catch (err) {
      setInvStatus(String(err), "err");
    }
  }

  // --- Renders ---
  function renderDashboard() {
    if (!invDashboardGrid) return;
    invDashboardGrid.innerHTML = "";
    if (!invMaterials.length) {
      invDashboardGrid.innerHTML = `<div><p style="color:var(--text-muted)">No hay materiales en el inventario aÃºn.</p></div>`;
      return;
    }

    invMaterials.forEach(mat => {
      const isLow = mat.current_stock <= mat.min_stock;
      const html = `
        <article class="panel panel--consulta" style="border-left: 4px solid ${isLow ? 'var(--color-danger)' : 'var(--color-primary)'}">
          <div style="padding: 16px;">
            <h3 style="margin:0 0 8px 0; font-size:1.1rem">${escapeHtml(mat.name)}</h3>
            <div style="font-size:1.8rem; font-weight:600; color:${isLow ? 'var(--color-danger)' : 'var(--text-color)'};">
              ${formatNum(mat.current_stock)} <span style="font-size:1rem">${escapeHtml(mat.unit)}</span>
            </div>
            ${isLow ? `<div style="color:var(--color-danger); font-size:0.85rem; margin-top:4px;">&#9888; Stock Bajo (Min: ${formatNum(mat.min_stock)})</div>` : ''}
          </div>
        </article>
      `;
      invDashboardGrid.insertAdjacentHTML("beforeend", html);
    });
  }

  function renderMaterialsTab() {
    if (!invMaterialsBody) return;
    invMaterialsBody.innerHTML = "";

    const isAdmin = window.AppGlobals && window.AppGlobals.state && window.AppGlobals.state.auth && window.AppGlobals.state.auth.role === "administrador";

    invMaterials.forEach(mat => {
      const tr = document.createElement("tr");
      const isLow = mat.current_stock <= mat.min_stock;
      tr.innerHTML = `
        <td><strong>${escapeHtml(mat.name)}</strong></td>
        <td><span class="bagde" style="background:#eee; padding:2px 6px; border-radius:4px; font-size:0.8rem">${escapeHtml(mat.doser_alias || "Ninguno")}</span></td>
        <td style="color:${isLow ? 'var(--color-danger)' : 'inherit'}; font-weight:${isLow ? 'bold' : 'normal'}">${formatNum(mat.current_stock)} ${escapeHtml(mat.unit)}</td>
        <td>${formatNum(mat.min_stock)}</td>
        <td>
           <button class="btn btn--small btn--muted edit-mat-btn">Editar</button>
           <button class="btn btn--small btn--danger delete-mat-btn">Eliminar</button>
           ${isAdmin ? `<button class="btn btn--small btn--danger hard-delete-mat-btn" style="background:var(--color-danger); border-color:var(--color-danger);" title="Eliminación Definitiva">Elim. Def. ⚠️</button>` : ''}
        </td>
      `;
      tr.querySelector(".edit-mat-btn").addEventListener("click", () => showMaterialFormDialog(mat));
      tr.querySelector(".delete-mat-btn").addEventListener("click", () => deleteMaterial(mat));
      if (isAdmin) {
        tr.querySelector(".hard-delete-mat-btn").addEventListener("click", () => hardDeleteMaterial(mat));
      }
      invMaterialsBody.appendChild(tr);
    });
  }

  function renderTransactions() {
    if (!invTransactionsBody) return;
    invTransactionsBody.innerHTML = "";

    // Check if the current user is an admin
    const isAdmin = window.AppGlobals && window.AppGlobals.state && window.AppGlobals.state.auth && window.AppGlobals.state.auth.role === "administrador";
    const colCount = isAdmin ? 7 : 6;

    if (!invTransactions.length) {
      invTransactionsBody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;color:var(--text-muted)">No hay movimientos logueados.</td></tr>`;
      return;
    }

    invTransactions.forEach(trx => {
      const isEntry = trx.transaction_type === "ENTRADA";
      const tr = document.createElement("tr");

      let actionHtml = '';
      if (isAdmin) {
        actionHtml = `<td><button class="btn btn--small btn--danger delete-trx-btn" style="padding: 2px 6px; font-size: 0.75rem;" data-id="${trx.id}">Borrar</button></td>`;
      } else {
        actionHtml = `<td></td>`;
      }

      tr.innerHTML = `
        <td>${escapeHtml(trx.created_at)}</td>
        <td><strong>${escapeHtml(trx.material_name)}</strong></td>
        <td><span style="color:${isEntry ? 'var(--color-success)' : 'var(--color-danger)'}; font-weight:bold">${escapeHtml(trx.transaction_type)}</span></td>
        <td>${isEntry ? '+' : '-'}${formatNum(trx.amount)} ${escapeHtml(trx.unit)}</td>
        <td>${escapeHtml(trx.reference || "-")}</td>
        <td>${escapeHtml(trx.actor)}</td>
        ${actionHtml}
      `;

      if (isAdmin) {
        const deleteBtn = tr.querySelector('.delete-trx-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', () => deleteTransaction(trx));
        }
      }

      invTransactionsBody.appendChild(tr);
    });
  }

  async function deleteTransaction(trx) {
    const isEntry = trx.transaction_type === "ENTRADA";
    const msg = isEntry
      ? `¿Seguro que deseas ELIMINAR la ENTRADA de ${trx.amount} ${trx.unit} de ${trx.material_name}? Esto restará el material del stock actual.`
      : `¿Seguro que deseas ELIMINAR la SALIDA de ${trx.amount} ${trx.unit} de ${trx.material_name}? Esto sumará el material de regreso al stock.`;

    const confirmed = await window.AppGlobals.uiConfirm(msg, {
      title: "Eliminar Movimiento",
      confirmText: "Sí, Eliminar",
      tone: "err"
    });
    if (!confirmed) return;

    try {
      const res = await invFetch(`/api/inventory/transactions/${trx.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error || "Error al eliminar movimiento");

      invTransactions = res.transactions;
      invMaterials = res.materials;
      renderTransactions();
      renderMaterialsTab();
      renderDashboard();
      setInvStatus("Movimiento eliminado exitosamente.", "ok");
    } catch (e) {
      alert(e.message);
    }
  }

  function populateMaterialSelects() {
    if (!invTrxFilter) return;
    const currentFilter = invTrxFilter.value;
    invTrxFilter.innerHTML = `<option value="">Todos los materiales</option>`;
    invMaterials.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      invTrxFilter.appendChild(opt);
    });
    invTrxFilter.value = currentFilter;
  }

  // --- Actions & Dialogs ---
  function showMaterialFormDialog(mat = null) {
    const formHtml = `
      <form id="matForm">
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="matName" style="color:var(--text-soft); font-size:0.85rem;">Nombre Comercial (Ej. Cemento Cemex, Arena Lavada)</label>
          <input type="text" id="matName" class="ui-dialog__input" value="${mat ? escapeHtml(mat.name) : ''}" required>
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="matAlias" style="color:var(--text-soft); font-size:0.85rem;">Alias en Dosificador (Puente para deducción automática)</label>
          <select id="matAlias" class="ui-dialog__input">
            <option value="">-- Sin Vincular --</option>
            <option value="Cemento" ${mat && mat.doser_alias === 'Cemento' ? 'selected' : ''}>Cemento (Dosificador)</option>
            <option value="Agua" ${mat && mat.doser_alias === 'Agua' ? 'selected' : ''}>Agua (Dosificador)</option>
            <option value="Aditivo" ${mat && mat.doser_alias === 'Aditivo' ? 'selected' : ''}>Aditivo (Genérico)</option>
            <option value="Reductor" ${mat && mat.doser_alias === 'Reductor' ? 'selected' : ''}>Reductor (Dosificador)</option>
            <option value="Retardante" ${mat && mat.doser_alias === 'Retardante' ? 'selected' : ''}>Retardante (Dosificador)</option>
            <option value="Imper" ${mat && mat.doser_alias === 'Imper' ? 'selected' : ''}>Imper (Dosificador)</option>
            <option value="Fibra" ${mat && mat.doser_alias === 'Fibra' ? 'selected' : ''}>Fibra (Dosificador)</option>
            <option value="Fino 1" ${mat && mat.doser_alias === 'Fino 1' ? 'selected' : ''}>Fino 1 / Arena 1</option>
            <option value="Fino 2" ${mat && mat.doser_alias === 'Fino 2' ? 'selected' : ''}>Fino 2 / Arena 2</option>
            <option value="Grueso 1" ${mat && mat.doser_alias === 'Grueso 1' ? 'selected' : ''}>Grueso 1 / Grava 1</option>
            <option value="Grueso 2" ${mat && mat.doser_alias === 'Grueso 2' ? 'selected' : ''}>Grueso 2 / Grava 2</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="matUnit" style="color:var(--text-soft); font-size:0.85rem;">Unidad de Medida</label>
          <input type="text" id="matUnit" class="ui-dialog__input" value="${mat ? escapeHtml(mat.unit) : 'kg'}" required>
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="matMin" style="color:var(--text-soft); font-size:0.85rem;">Stock Mínimo (Alerta)</label>
          <input type="number" step="any" id="matMin" class="ui-dialog__input" value="${mat ? mat.min_stock : 0}" required>
        </div>
      </form>
    `;
    const dialogDiv = document.createElement("div");
    dialogDiv.className = "ui-dialog";
    dialogDiv.setAttribute("data-tone", "info");
    dialogDiv.setAttribute("role", "dialog");
    dialogDiv.setAttribute("aria-modal", "true");
    dialogDiv.innerHTML = `
      <header class="ui-dialog__head">
        <div class="ui-dialog__title-wrap">
          <svg class="ui-tone-icon ui-tone-icon--dialog" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          <h3 class="ui-dialog__title">${mat ? "Editar Material" : "Nuevo Material Base"}</h3>
        </div>
        <span class="ui-dialog__chip">ALTA / EDICIÓN</span>
      </header>
      <div class="ui-dialog__body">
        <p class="ui-dialog__message" style="margin-bottom:1rem;">
          Al crear un nuevo material, este comenzará con stock de 0. Para incrementar el stock usa "Registrar Movimiento".
        </p>
        ${formHtml}
      </div>
      <footer class="ui-dialog__actions">
        <button id="cancelMatBtn" class="btn btn--muted btn--small">Cancelar</button>
        <button id="saveMatBtn" class="btn btn--primary btn--small">Guardar</button>
      </footer>
    `;

    uiDialogHost.innerHTML = "";
    uiDialogHost.appendChild(dialogDiv);
    uiDialogHost.classList.remove("is-hidden");

    const aliasSelect = document.getElementById("matAlias");
    const unitInput = document.getElementById("matUnit");

    if (aliasSelect && unitInput) {
      aliasSelect.addEventListener("change", () => {
        const val = aliasSelect.value;
        const aggregates = ["Fino 1", "Fino 2", "Grueso 1", "Grueso 2"];
        if (aggregates.includes(val)) {
          unitInput.value = "m³";
        } else if (["Cemento", "Imper", "Fibra"].includes(val)) {
          unitInput.value = "kg";
        } else if (["Agua", "Aditivo", "Reductor", "Retardante"].includes(val)) {
          unitInput.value = "Lts";
        }
      });
    }

    document.getElementById("cancelMatBtn").addEventListener("click", () => uiDialogHost.classList.add("is-hidden"));

    document.getElementById("saveMatBtn").addEventListener("click", async () => {
      const payload = {
        name: document.getElementById("matName").value.trim(),
        doser_alias: document.getElementById("matAlias").value,
        unit: document.getElementById("matUnit").value.trim(),
        min_stock: parseFloat(document.getElementById("matMin").value) || 0
      };
      if (mat) payload.id = mat.id;

      if (!payload.name) return alert("Nombre requerido");

      try {
        const res = await invFetch("/api/inventory/materials", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(res.error || "Error al guardar");

        uiDialogHost.classList.add("is-hidden");
        invMaterials = res.materials;
        renderMaterialsTab();
        renderDashboard();
        populateMaterialSelects();
        setInvStatus("Material guardado correctamente.", "ok");
      } catch (e) {
        alert(e.message);
      }
    });
  }

  function showTransactionFormDialog() {
    if (!invMaterials.length) return alert("Primero debes dar de alta un material en el CatÃ¡logo.");

    let optHtml = invMaterials.map(m => `<option value="${m.id}">${escapeHtml(m.name)} (Stock: ${formatNum(m.current_stock)} ${escapeHtml(m.unit)})</option>`).join("");

    const formHtml = `
      <form id="trxForm">
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="trxMatId" style="color:var(--text-soft); font-size:0.85rem;">Material</label>
          <select id="trxMatId" class="ui-dialog__input" required>${optHtml}</select>
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="trxType" style="color:var(--text-soft); font-size:0.85rem;">Tipo de Movimiento</label>
          <select id="trxType" class="ui-dialog__input">
            <option value="ENTRADA">ENTRADA (Aumentar Stock - Ej: Compra de Cemento)</option>
            <option value="SALIDA">SALIDA (Reducir Stock - Ej: Ajuste / Merma)</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="trxAmount" style="color:var(--text-soft); font-size:0.85rem;">Cantidad</label>
          <input type="number" step="any" min="0.001" id="trxAmount" class="ui-dialog__input" placeholder="0.0" required>
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="trxRef" style="color:var(--text-soft); font-size:0.85rem;">Referencia (Opcional)</label>
          <input type="text" id="trxRef" class="ui-dialog__input" placeholder="Ej: Ticket #123 Cemex">
        </div>
      </form>
    `;

    const dialogDiv = document.createElement("div");
    dialogDiv.className = "ui-dialog";
    dialogDiv.setAttribute("data-tone", "info");
    dialogDiv.setAttribute("role", "dialog");
    dialogDiv.setAttribute("aria-modal", "true");
    dialogDiv.innerHTML = `
      <header class="ui-dialog__head">
        <div class="ui-dialog__title-wrap">
          <svg class="ui-tone-icon ui-tone-icon--dialog" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          <h3 class="ui-dialog__title">Registrar Movimiento</h3>
        </div>
        <span class="ui-dialog__chip">MOVIMIENTO</span>
      </header>
      <div class="ui-dialog__body">
        <p class="ui-dialog__message" style="margin-bottom:1rem;">
          Registra una entrada manual de mercancía por pedido o un ajuste de inventario.
        </p>
        ${formHtml}
      </div>
      <footer class="ui-dialog__actions">
        <button id="cancelTrxBtn" class="btn btn--muted btn--small">Cancelar</button>
        <button id="saveTrxBtn" class="btn btn--primary btn--small">Registrar</button>
      </footer>
    `;

    uiDialogHost.innerHTML = "";
    uiDialogHost.appendChild(dialogDiv);
    uiDialogHost.classList.remove("is-hidden");

    document.getElementById("cancelTrxBtn").addEventListener("click", () => uiDialogHost.classList.add("is-hidden"));

    document.getElementById("saveTrxBtn").addEventListener("click", async () => {
      const payload = {
        material_id: parseInt(document.getElementById("trxMatId").value),
        transaction_type: document.getElementById("trxType").value,
        amount: parseFloat(document.getElementById("trxAmount").value),
        reference: document.getElementById("trxRef").value.trim()
      };

      if (!payload.amount || payload.amount <= 0) return alert("Ingresa una cantidad vÃ¡lida mayor a 0");

      try {
        const res = await invFetch("/api/inventory/transactions", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(res.error || "Error al registrar movimiento");

        uiDialogHost.classList.add("is-hidden");
        invMaterials = res.materials; // Backend sends updated materials payload
        renderMaterialsTab();
        renderDashboard();
        await loadTransactions();

        setInvStatus("Movimiento registrado con Ã©xito.", "ok");
      } catch (e) {
        alert(e.message);
      }
    });
  }

  async function deleteMaterial(mat) {
    if (!confirm(`¿Seguro que deseas ocultar (soft-delete) '${mat.name}'? Ya no aparecerá en el dosificador ni reportes, pero su historial se conserva.`)) return;
    try {
      const res = await invFetch(`/api/inventory/materials/${mat.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error || "Error al eliminar");
      invMaterials = res.materials;
      renderMaterialsTab();
      renderDashboard();
      populateMaterialSelects();
      setInvStatus(`Material ${mat.name} eliminado.`, "ok");
    } catch (e) {
      alert(e.message);
    }
  }

  async function hardDeleteMaterial(mat) {
    if (!confirm(`⚠️ ADVERTENCIA: ¿Seguro que deseas ELIMINAR DEFINITIVAMENTE '${mat.name}'?\n\nEsta acción borrará el material físicamente y TODO su historial de movimientos del Kardex.\n\nEsta acción NO se puede deshacer.\n\n¿Deseas continuar?`)) return;
    try {
      const res = await invFetch(`/api/inventory/materials/${mat.id}?force=true`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error || "Error al eliminar definitivamente");
      invMaterials = res.materials;
      renderMaterialsTab();
      renderDashboard();
      populateMaterialSelects();
      await loadTransactions();
      setInvStatus(`Material ${mat.name} eliminado de forma permanente.`, "ok");
    } catch (e) {
      alert(e.message);
    }
  }

  // --- Hooking the Events ---
  if (tabInventario) {
    tabInventario.addEventListener("click", () => {
      if (!canAccessView("inventario")) return;
      switchView("inventario");
      loadInventoryData();
    });
  }

  if (invReloadBtn) invReloadBtn.addEventListener("click", loadInventoryData);
  if (invAddMaterialBtn) invAddMaterialBtn.addEventListener("click", () => showMaterialFormDialog(null));
  if (invAddTransactionBtn) invAddTransactionBtn.addEventListener("click", showTransactionFormDialog);
  if (invTrxFilter) invTrxFilter.addEventListener("change", loadTransactions);

  const adminPurgeInactiveBtn = document.getElementById("adminPurgeInactiveBtn");
  if (adminPurgeInactiveBtn) {
    adminPurgeInactiveBtn.addEventListener("click", async () => {
      const confirmed = await window.AppGlobals.uiConfirm(
        "¿Deseas ELIMINAR DEFINITIVAMENTE todos los materiales inactivos y su historial?\n\nEsta acción limpiará el sistema de materiales de prueba y 'fantasmas'. No afectará a tus materiales actuales activos.",
        {
          title: "Limpiar Materiales Inactivos",
          confirmText: "Sí, Purgar Todo",
          tone: "err"
        }
      );
      if (!confirmed) return;

      try {
        setInvStatus("Purgando materiales...", "warn");
        const res = await invFetch("/api/inventory/materials/purge-inactive", { method: "POST" });
        if (!res.ok) throw new Error(res.error || "Error al purgar materiales");

        invMaterials = res.materials;
        renderMaterialsTab();
        renderDashboard();
        populateMaterialSelects();
        await loadTransactions();

        setInvStatus(`Limpieza completada: ${res.purged} materiales eliminados.`, "ok");
        uiToastHost && uiToastHost.show(`Se eliminaron ${res.purged} materiales permanentemente.`, "ok");
      } catch (err) {
        alert(err.message);
        setInvStatus(err.message, "err");
      }
    });
  }

  const clearKardexBtn = document.getElementById("clearKardexBtn");
  if (clearKardexBtn) {
    clearKardexBtn.addEventListener("click", async () => {
      const confirmed = await window.AppGlobals.uiConfirm(
        "¡Peligro! ¿Estás seguro de querer ELIMINAR todo el historial de movimientos? Esta acción es irreversible, pero no afectará el stock actual de los materiales.",
        {
          title: "Limpiar Kardex",
          confirmText: "Sí, Limpiar",
          tone: "err"
        }
      );
      if (!confirmed) return;
      try {
        const res = await invFetch(`/api/inventory/transactions`, { method: "DELETE" });
        if (!res.ok) throw new Error(res.error || "Error al limpiar Kardex");
        invTransactions = res.transactions || [];
        renderTransactions();
        setInvStatus("Kardex de movimientos limpiado.", "ok");
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // Expose loadInventoryData to window so app.js can call it sequentially 
  window.loadInventoryData = loadInventoryData;

  // Load on boot to ensure state.doser.invMaterials is populated
  if (AppGlobals.canAccessView("dosificador") || AppGlobals.canAccessView("inventario")) {
    loadInventoryData();
  }

  // --- Daily Report Functions ---
  async function generateDailyReport() {
    const invDailyReportDate = document.getElementById("invDailyReportDate");
    const date = invDailyReportDate ? invDailyReportDate.value : null;
    if (!date) {
      uiToastHost && uiToastHost.show("Selecciona una fecha para el reporte.", "warn");
      return;
    }

    setInvStatus(`Generando reporte para ${date}...`, "warn");
    try {
      const res = await invFetch(`/api/inventory/daily_summary?date=${encodeURIComponent(date)}`);
      if (!res.ok) throw new Error(res.error || "Error al obtener resumen");

      openDailyReportInNewTab(res.summary);
      setInvStatus(`Reporte generado para ${date}.`, "ok");
    } catch (err) {
      setInvStatus(String(err), "err");
    }
  }

  function openDailyReportInNewTab(summary) {
    const { production, consumption, remisiones, current_inventory, date } = summary;
    const reportDate = getFullTodayCancun ? getFullTodayCancun() : new Date().toLocaleString();
    const logoUrl = BRAND_LOGO_URL || "";

    const efficiency = production.total_teorico_kg > 0
      ? (production.total_real_kg / production.total_teorico_kg) * 100
      : 100;

    const remisionesRows = remisiones.map(r => `
      <tr>
        <td><strong>${escapeHtml(r.remision_no)}</strong></td>
        <td>${escapeHtml(r.formula)}</td>
        <td class="num">${formatNum(r.dosificacion_m3)} m³</td>
        <td style="text-align:center;">${r.created_at.split(' ')[1] || ''}</td>
      </tr>
    `).join("") || "<tr><td colspan='4' style='text-align:center;'>No hubo remisiones</td></tr>";

    const consumptionRows = consumption.map(c => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td class="num">${formatNum(c.total_entrada)}</td>
        <td class="num" style="color:#b91c1c;">-${formatNum(c.total_salida)}</td>
        <td style="text-align:center;">${escapeHtml(c.unit)}</td>
      </tr>
    `).join("") || "<tr><td colspan='4' style='text-align:center;'>Sin movimientos</td></tr>";

    const inventoryCards = current_inventory.map(m => {
      const isLow = m.current_stock <= m.min_stock;
      return `
        <div class="card ${isLow ? 'card--warn' : ''}">
          <div class="card-label">${escapeHtml(m.name)}</div>
          <div class="card-val">${formatNum(m.current_stock)} <span>${escapeHtml(m.unit)}</span></div>
        </div>
      `;
    }).join("");

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Reporte Diario - ${date}</title>
  <style>
    @page { size: letter landscape; margin: 10mm; }
    body { font-family: "Segoe UI", Tahoma, sans-serif; margin: 0; color: #1a2c3f; font-size: 12px; line-height: 1.4; background: #f8fafc; }
    .page { background: #fff; max-width: 1000px; margin: 0 auto; padding: 20px; box-shadow: 0 0 10px rgba(0,0,0,0.05); min-height: 100vh; }
    .header { border-bottom: 3px solid #005da6; padding-bottom: 10px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; }
    .header-brand { display: flex; align-items: center; gap: 12px; }
    .logo { width: 50px; height: 50px; object-fit: contain; }
    .header h1 { margin: 0; font-size: 20px; color: #004d8a; }
    .header p { margin: 2px 0 0; color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    
    .subtitle { margin-bottom: 20px; font-size: 14px; color: #334155; font-weight: 600; background: #f1f5f9; padding: 8px 12px; border-radius: 6px; }
    
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 25px; }
    .stat-box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; background: #fff; text-align: center; }
    .stat-box label { display: block; font-size: 10px; color: #64748b; text-transform: uppercase; margin-bottom: 4px; font-weight: 700; }
    .stat-box .val { font-size: 18px; font-weight: 800; color: #0f172a; }
    
    .section { margin-bottom: 25px; break-inside: avoid; }
    .section h2 { font-size: 14px; color: #005da6; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
    
    table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; font-size: 11px; }
    th { background: #f8fafc; color: #475569; font-weight: 700; }
    td.num { text-align: right; }
    
    .stock-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
    .card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; background: #fff; }
    .card--warn { border-color: #fca5a5; background: #fff1f1; }
    .card-label { font-size: 9px; color: #64748b; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-val { font-size: 13px; font-weight: 700; margin-top: 2px; }
    .card-val span { font-size: 10px; font-weight: 400; color: #64748b; }

    .footer { margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 10px; text-align: center; font-size: 10px; color: #94a3b8; font-weight: 600; }

    @media print {
      body { background: #fff; }
      .page { box-shadow: none; margin: 0; width: 100%; max-width: none; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      button { display: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="header-brand">
        <img src="${logoUrl}" class="logo" alt="ALMEX">
        <div>
          <h1>Reporte Diario de Operaciones</h1>
          <p>Planta Cancún | ALMEX</p>
        </div>
      </div>
      <div style="text-align:right">
        <button onclick="window.print()" style="padding: 6px 12px; background: #005da6; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">Imprimir Reporte</button>
        <div style="font-size: 9px; color: #94a3b8; margin-top: 4px;">Generado: ${reportDate}</div>
      </div>
    </div>

    <div class="subtitle">Resumen consolidado al ${date}</div>

    <div class="stats-grid">
      <div class="stat-box"><label>Total Remisiones</label><div class="val">${production.total_remisiones}</div></div>
      <div class="stat-box"><label>Volumen Total</label><div class="val">${formatNum(production.total_m3)} m³</div></div>
      <div class="stat-box"><label>Eficiencia de Carga</label><div class="val">${formatNum(efficiency)}%</div></div>
    </div>

    <div class="section">
      <h2>Detalle de Remisiones</h2>
      <table>
        <thead>
          <tr><th>No. Remisión</th><th>Diseño / f'c</th><th class="num">Volumen</th><th style="text-align:center;">Hora</th></tr>
        </thead>
        <tbody>${remisionesRows}</tbody>
      </table>
    </div>

    <div class="section">
      <h2>Resumen de Producción y Pesos</h2>
      <table>
        <tbody>
          <tr><td>Total Concreto Despachado</td><td class="num"><strong>${formatNum(production.total_m3)} m³</strong></td></tr>
          <tr><td>Peso Teórico Total</td><td class="num">${formatNum(production.total_teorico_kg)} kg</td></tr>
          <tr><td>Peso Real Total</td><td class="num">${formatNum(production.total_real_kg)} kg</td></tr>
          <tr style="background:#f1f5f9;"><td><strong>Variación neta</strong></td><td class="num"><strong>${formatNum(production.total_real_kg - production.total_teorico_kg)} kg</strong></td></tr>
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>Consumo de Materiales</h2>
      <table>
        <thead>
          <tr><th>Material</th><th class="num">Entradas</th><th class="num">Salidas</th><th style="text-align:center;">Unidad</th></tr>
        </thead>
        <tbody>${consumptionRows}</tbody>
      </table>
    </div>

    <div class="section">
      <h2>Inventario Restante en Planta</h2>
      <div class="stock-grid">${inventoryCards}</div>
    </div>

    <div class="footer">ForMIX by LABSICO - Sistema de Gestión de Concreto</div>
  </div>
</body>
</html>`;

    const win = window.open("", "_blank");
    if (!win) {
      alert("Habilite los pop-ups para ver el reporte.");
      return;
    }
    win.document.open();
    win.document.write(html);

    win.document.close();
  }

  if (invGenDailyReportBtn) {
    invGenDailyReportBtn.addEventListener("click", () => {
      generateDailyReport();
    });
  }

  if (invDailyReportDate) {
    invDailyReportDate.value = globals.getTodayCancun ? globals.getTodayCancun() : new Date().toISOString().split('T')[0];
  }

})(window.AppGlobals);
