/**
 * Inventory Management Module
 * Connects with the `/api/inventory` endpoints.
 */
(function(globals) {
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
    uiToastHost
  } = globals;

  // --- DOM Elements ---
  const invReloadBtn = document.getElementById("invReloadBtn");
  const invAddMaterialBtn = document.getElementById("invAddMaterialBtn");
  const invAddTransactionBtn = document.getElementById("invAddTransactionBtn");
  const invDashboardGrid = document.getElementById("invDashboardGrid");
  const invMaterialsBody = document.getElementById("invMaterialsBody");
  const invTrxFilter = document.getElementById("invTrxFilter");
  const invTransactionsBody = document.getElementById("invTransactionsBody");
  const invStatusBar = document.getElementById("invStatusBar");

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
        } catch(e) { /* body is not JSON, leave as-is */ }
      } else if (!opts.body) {
        opts = { ...opts, body: JSON.stringify({ _csrf_token: csrfToken }) };
      }
    }
    const res = await window.fetch(url, { ...opts, headers, credentials: "same-origin" });
    return res.json();
  }

  function setInvStatus(msg, tone="ok") {
    if(!invStatusBar) return;
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
        </td>
      `;
      tr.querySelector(".edit-mat-btn").addEventListener("click", () => showMaterialFormDialog(mat));
      tr.querySelector(".delete-mat-btn").addEventListener("click", () => deleteMaterial(mat));
      invMaterialsBody.appendChild(tr);
    });
  }

  function renderTransactions() {
    if (!invTransactionsBody) return;
    invTransactionsBody.innerHTML = "";
    if (!invTransactions.length) {
      invTransactionsBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No hay movimientos logueados.</td></tr>`;
      return;
    }
    invTransactions.forEach(trx => {
      const isEntry = trx.transaction_type === "ENTRADA";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(trx.created_at)}</td>
        <td><strong>${escapeHtml(trx.material_name)}</strong></td>
        <td><span style="color:${isEntry ? 'var(--color-success)' : 'var(--color-danger)'}; font-weight:bold">${escapeHtml(trx.transaction_type)}</span></td>
        <td>${isEntry ? '+' : '-'}${formatNum(trx.amount)} ${escapeHtml(trx.unit)}</td>
        <td>${escapeHtml(trx.reference || "-")}</td>
        <td>${escapeHtml(trx.actor)}</td>
      `;
      invTransactionsBody.appendChild(tr);
    });
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
            <option value="Aditivo" ${mat && mat.doser_alias === 'Aditivo' ? 'selected' : ''}>Aditivo (Dosificador)</option>
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
    if(!confirm(`Â¿Seguro que deseas ELIMINAR '${mat.name}'? Ya no aparecerÃ¡ en el dosificador ni reportes.`)) return;
    try {
      const res = await invFetch(`/api/inventory/materials/${mat.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(res.error || "Error al eliminar");
      invMaterials = res.materials;
      renderMaterialsTab();
      renderDashboard();
      populateMaterialSelects();
      setInvStatus(`Material ${mat.name} eliminado.`, "ok");
    } catch(e) {
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
  
  const clearKardexBtn = document.getElementById("clearKardexBtn");
  if (clearKardexBtn) {
    clearKardexBtn.addEventListener("click", async () => {
      const confirmed = await window.AppGlobals.uiDialog({
        title: "Limpiar Kardex",
        message: "¡Peligro! ¿Estás seguro de querer ELIMINAR todo el historial de movimientos? Esta acción es irreversible, pero no afectará el stock actual de los materiales.",
        confirmText: "Sí, Limpiar",
        tone: "err"
      });
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

})(window.AppGlobals);
