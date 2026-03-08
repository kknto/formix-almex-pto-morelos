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
      renderMaterialsTab();
      renderDashboard();
      populateMaterialSelects();
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
      <form id="matForm" style="display:flex;flex-direction:column;gap:12px;margin-top:16px;">
        <label>
          Nombre Comercial (Ej. Cemento Cemex, Arena Lavada)
          <input type="text" id="matName" value="${mat ? escapeHtml(mat.name) : ''}" required>
        </label>
        <label>
          Alias en Dosificador (Puente para deducciÃ³n automÃ¡tica)
          <select id="matAlias">
            <option value="">-- Sin Vincular --</option>
            <option value="Cemento" ${mat && mat.doser_alias === 'Cemento' ? 'selected' : ''}>Cemento (Dosificador)</option>
            <option value="Agua" ${mat && mat.doser_alias === 'Agua' ? 'selected' : ''}>Agua (Dosificador)</option>
            <option value="Aditivo" ${mat && mat.doser_alias === 'Aditivo' ? 'selected' : ''}>Aditivo (Dosificador)</option>
            <option value="Fino 1" ${mat && mat.doser_alias === 'Fino 1' ? 'selected' : ''}>Fino 1 / Arena 1</option>
            <option value="Fino 2" ${mat && mat.doser_alias === 'Fino 2' ? 'selected' : ''}>Fino 2 / Arena 2</option>
            <option value="Grueso 1" ${mat && mat.doser_alias === 'Grueso 1' ? 'selected' : ''}>Grueso 1 / Grava 1</option>
            <option value="Grueso 2" ${mat && mat.doser_alias === 'Grueso 2' ? 'selected' : ''}>Grueso 2 / Grava 2</option>
          </select>
        </label>
        <label>
          Unidad de Medida
          <input type="text" id="matUnit" value="${mat ? escapeHtml(mat.unit) : 'kg'}" required>
        </label>
        <label>
          Stock MÃ­nimo (Alerta)
          <input type="number" step="any" id="matMin" value="${mat ? mat.min_stock : 0}" required>
        </label>
      </form>
    `;
    const dialogDiv = document.createElement("div");
    dialogDiv.className = "ui-dialog";
    dialogDiv.innerHTML = `
      <div class="ui-dialog__content">
        <h2 style="margin-bottom:8px;">${mat ? "Editar Material" : "Nuevo Material Base"}</h2>
        <p style="color:var(--text-muted);font-size:0.9rem">
          Al crear un nuevo material, este comenzarÃ¡ con stock de 0. Para incrementar el stock usa "Registrar Movimiento".
        </p>
        ${formHtml}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px;">
          <button id="cancelMatBtn" class="btn btn--muted">Cancelar</button>
          <button id="saveMatBtn" class="btn btn--primary">Guardar</button>
        </div>
      </div>
    `;

    uiDialogHost.innerHTML = "";
    uiDialogHost.appendChild(dialogDiv);
    uiDialogHost.classList.remove("is-hidden");

    document.getElementById("cancelMatBtn").addEventListener("click", () => {
      uiDialogHost.classList.add("is-hidden");
    });

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
      <form id="trxForm" style="display:flex;flex-direction:column;gap:12px;margin-top:16px;">
        <label>
          Material
          <select id="trxMatId" required>${optHtml}</select>
        </label>
        <label>
          Tipo de Movimiento
          <select id="trxType">
            <option value="ENTRADA">ENTRADA (Aumentar Stock - Ej: Compra de Cemento)</option>
            <option value="SALIDA">SALIDA (Reducir Stock - Ej: Ajuste / Merma)</option>
          </select>
        </label>
        <label>
          Cantidad
          <input type="number" step="any" min="0.001" id="trxAmount" placeholder="0.0" required>
        </label>
        <label>
          Referencia (Opcional)
          <input type="text" id="trxRef" placeholder="Ej: Ticket #123 Cemex">
        </label>
      </form>
    `;

    const dialogDiv = document.createElement("div");
    dialogDiv.className = "ui-dialog";
    dialogDiv.innerHTML = `
      <div class="ui-dialog__content">
        <h2 style="margin-bottom:8px;">Registrar Movimiento</h2>
        <p style="color:var(--text-muted);font-size:0.9rem">
          Registra una entrada manual de mercancÃ­a por pedido o un ajuste de inventario.
        </p>
        ${formHtml}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px;">
          <button id="cancelTrxBtn" class="btn btn--muted">Cancelar</button>
          <button id="saveTrxBtn" class="btn btn--primary">Registrar</button>
        </div>
      </div>
    `;

    uiDialogHost.innerHTML = "";
    uiDialogHost.appendChild(dialogDiv);
    uiDialogHost.classList.remove("is-hidden");

    document.getElementById("cancelTrxBtn").addEventListener("click", () => {
      uiDialogHost.classList.add("is-hidden");
    });

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

  // Expose loadInventoryData to window so app.js can call it sequentially 
  window.loadInventoryData = loadInventoryData;

})(window.AppGlobals);

