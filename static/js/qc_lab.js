let stateQcCylinders = [];
let sampleAges = [3, 7, 14, 28]; // Default ages for a native sample
let currentTestCylinderId = null;

async function lookupRemision() {
    const remNo = document.getElementById("qcRemisionNo").value.trim();
    if (!remNo) {
        if (typeof setStatus === 'function') setStatus("Ingresa un nº de remisión para buscar.", 'warn');
        return;
    }

    try {
        const response = await apiFetch("/api/qclab/lookup_remision/" + encodeURIComponent(remNo));
        const res = await response.json();

        if (res.ok && res.remision) {
            const rem = res.remision;
            // Auto-fill fc if available
            if (rem.fc) {
                document.getElementById("qcFcExpected").value = rem.fc || "";
            }
            if (rem.rev) {
                const slumpNum = parseFloat(rem.rev);
                if (!isNaN(slumpNum)) {
                    document.getElementById("qcSlump").value = slumpNum;
                }
            }
            if (rem.created_at) {
                // created_at usually is "YYYY-MM-DD HH:MM:SS"
                const datePart = rem.created_at.split(" ")[0];
                const castDateInput = document.getElementById("qcCastDate");
                if (castDateInput) {
                    castDateInput.value = datePart;
                }
            }
            if (rem.fc || rem.rev || rem.created_at) {
                if (typeof setStatus === 'function') setStatus(`Datos cargados de remisión ${remNo}.`, 'ok');
            }
            // We could auto-fill more if we had more fields in the form
        } else {
            if (typeof setStatus === 'function') setStatus("Remisión no encontrada.", 'warn');
        }
    } catch (err) {
        console.error("Error lookup remision:", err);
    }
}

function initQcLab() {
    renderAgesBadges();
}

/**
 * Heuristic for expected concrete strength gain percentage based on age.
 */
function getExpectedPercentage(days) {
    if (days >= 28) return 100;
    if (days >= 14) return 85;
    if (days >= 7) return 70;
    if (days >= 3) return 50;
    return 10; // Under 3 days
}

function getPerformanceClass(percentAchieved, targetDays) {
    const expected = getExpectedPercentage(targetDays);
    // Performance relative to what is expected for that age
    const ratio = (percentAchieved / expected) * 100;

    if (ratio >= 100) return 'qc-perf-good';
    if (ratio >= 85) return 'qc-perf-warn';
    return 'qc-perf-bad';
}

async function loadLaboratoryData() {
    try {
        const response = await apiFetch("/api/qclab/cylinders?pending_only=false");
        const res = await response.json();
        if (!res.ok) throw new Error(res.error || "Error cargando cilindros");

        stateQcCylinders = res.cylinders || [];
        renderQcCylinders();
        renderQcDashboard();
    } catch (err) {
        if (typeof setStatus === 'function') setStatus("Error cargando laboratorio: " + err.message, 'err'); else console.error("Error cargando laboratorio: " + err.message);
    }
}

function renderQcDashboard() {
    const qcDashboardContainer = document.getElementById("qcDashboard");
    if (!qcDashboardContainer) return;

    let pendingToday = 0;
    let overdue = 0;
    let totalPending = 0;

    const todayStr = (window.AppGlobals && window.AppGlobals.getTodayCancun) ? window.AppGlobals.getTodayCancun() : new Date().toISOString().split("T")[0];

    stateQcCylinders.forEach(cyl => {
        if (cyl.status === "pendiente") {
            totalPending++;
            if (cyl.expected_test_date === todayStr) {
                pendingToday++;
            } else if (cyl.expected_test_date < todayStr) {
                overdue++;
            }
        }
    });

    qcDashboardContainer.innerHTML = `
        <article class="panel panel--consulta" style="border-left: 4px solid var(--color-primary);">
            <div style="padding: 16px;">
                <h3 style="margin:0 0 8px 0; font-size:1.1rem; color:var(--text-soft);">Cilindros Pendientes</h3>
                <div style="font-size:1.8rem; font-weight:600; color:var(--text-color);">
                  ${totalPending} <span style="font-size:1rem; color:var(--text-muted); font-weight:400;">Total en espera</span>
                </div>
            </div>
        </article>
        <article class="panel panel--consulta" style="border-left: 4px solid var(--color-success);">
            <div style="padding: 16px;">
                <h3 style="margin:0 0 8px 0; font-size:1.1rem; color:var(--text-soft);">Para Ensayar Hoy</h3>
                <div style="font-size:1.8rem; font-weight:600; color:var(--text-color);">
                  ${pendingToday} <span style="font-size:1rem; color:var(--text-muted); font-weight:400;">Fecha: ${todayStr}</span>
                </div>
            </div>
        </article>
        <article class="panel panel--consulta" style="border-left: 4px solid ${overdue > 0 ? 'var(--color-danger)' : 'var(--border-color)'};">
            <div style="padding: 16px;">
                <h3 style="margin:0 0 8px 0; font-size:1.1rem; color:var(--text-soft);">Vencidos (Atrasados)</h3>
                <div style="font-size:1.8rem; font-weight:600; color: ${overdue > 0 ? 'var(--color-danger)' : 'var(--text-color)'};">
                  ${overdue} <span style="font-size:1rem; color:var(--text-muted); font-weight:400;">Requieren atención</span>
                </div>
            </div>
        </article>
    `;
}

function renderQcCylinders() {
    const pendingCylindersTableBody = document.getElementById("pendingCylindersTbody");
    if (!pendingCylindersTableBody) return;
    pendingCylindersTableBody.innerHTML = "";

    // Group cylinders by sample
    const samplesMap = new Map();
    stateQcCylinders.forEach(cyl => {
        if (!samplesMap.has(cyl.sample_id)) {
            samplesMap.set(cyl.sample_id, {
                sample_id: cyl.sample_id,
                sample_code: cyl.sample_code,
                formula: cyl.formula,
                fc: cyl.fc,
                tma: cyl.tma,
                tipo: cyl.tipo,
                cylinders: []
            });
        }
        samplesMap.get(cyl.sample_id).cylinders.push(cyl);
    });

    // Render each group
    samplesMap.forEach(sample => {
        // --- 1. Header Row (The Sample) ---
        const trHeader = document.createElement("tr");
        trHeader.className = "qc-sample-header";
        trHeader.style.cursor = "pointer";
        trHeader.style.background = "#eff5fb"; // Slight highlight to distinguish groups

        // Count how many are pending vs tested
        const total = sample.cylinders.length;
        const pending = sample.cylinders.filter(c => c.status === "pendiente").length;
        const tested = total - pending;

        const svgIcon = `<svg style="width:16px; height:16px; margin-right:6px; color:var(--brand); vertical-align:middle; transition: transform 0.2s;" fill="none" class="qc-expand-icon" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>`;

        const designInfo = (sample.formula || sample.fc || sample.tma) ?
            `<div style="font-size:0.8rem; color:var(--text-soft); font-weight:400; margin-top:4px; padding:2px 4px; display:inline-block;">
                ${sample.formula ? `<b>${sample.formula}</b>` : ''} 
                ${sample.fc ? ` | f'c ${sample.fc}` : ''}
                ${sample.tma ? ` | TMA ${sample.tma}` : ''}
                ${sample.tipo ? ` | ${sample.tipo}` : ''}
            </div>` : '';

        const userRole = (window.APP_BOOT && window.APP_BOOT.role) ? window.APP_BOOT.role.toLowerCase() : "";
        const canEditDelete = (userRole === "administrador" || userRole === "laboratorista");

        trHeader.innerHTML = `
            <td colspan="4" style="font-weight:600; color:var(--text-color); border-bottom: 2px solid var(--line);">
                <div style="font-size: 1.05rem; display: flex; align-items: center; justify-content: space-between;">
                    <span>${svgIcon}${sample.sample_code}</span>
                    ${sample.remision_id ? `<span style="font-size: 0.8rem; background: var(--bg-0); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--line); font-weight: normal; color: var(--text-soft);">Remisión: <b>${sample.remision_id}</b></span>` : '<span style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;"><i>Sin remisión</i></span>'}
                </div>
                ${designInfo}
            </td>
            <td colspan="3" style="text-align:center; color:var(--text-soft); border-bottom: 2px solid var(--line); vertical-align: middle;">
                <span class="qc-status-badge qc-status-ensayado" style="margin-right: 8px;">${tested} Ensayados</span>
                <span class="qc-status-badge qc-status-pendiente">${pending} Pendientes</span>
            </td>
            <td style="text-align:center; display:flex; justify-content:center; gap:8px; border-bottom: 2px solid var(--line); border-left: none;">
                ${canEditDelete ? `<button class="btn btn--muted btn--small" onclick="event.stopPropagation(); window.editQcSample(${sample.sample_id})" title="Editar Datos de Muestra" style="padding: 6px 10px; color: var(--brand);"><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>` : ''}
                <button class="btn btn--muted btn--small" onclick="event.stopPropagation(); window.openChartModal(${sample.sample_id}, '${sample.sample_code}')" title="Ver Gráfica de Evolución" style="padding: 6px 10px;"><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg></button>
                ${canEditDelete ? `<button type="button" class="btn btn--muted btn--small" onclick="event.stopPropagation(); window.deleteQcSample(${sample.sample_id})" title="Eliminar Muestra Completa" style="color:var(--color-danger); border-color:transparent; padding:6px 10px;"><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>` : ''}
            </td>
        `;
        pendingCylindersTableBody.appendChild(trHeader);

        // --- 2. Child Rows (The Cylinders) ---
        const childRows = [];
        sample.cylinders.forEach(cyl => {
            const tr = document.createElement("tr");
            tr.className = `qc-sample-child row-sample-${sample.sample_id}`;
            tr.style.display = "none"; // Initially hidden
            tr.style.background = "#ffffff";

            const isPending = cyl.status === "pendiente";
            const badgeClass = isPending ? "qc-status-pendiente" : "qc-status-ensayado";

            // Performance Calculation
            let perfHtml = '<span style="color:var(--text-muted); opacity:0.5">-</span>';
            if (!isPending && cyl.fc_expected > 0) {
                const percentAchieved = (cyl.strength_kgcm2 / cyl.fc_expected) * 100;
                const perfClass = getPerformanceClass(percentAchieved, cyl.target_age_days);
                perfHtml = `<span class="${perfClass}" title="Esperado para ${cyl.target_age_days}d: ${getExpectedPercentage(cyl.target_age_days)}% del f'c">
                    ${percentAchieved.toFixed(1)}%
                </span>`;
            }

            tr.innerHTML = `
                <td style="padding-left: 24px; color:var(--text-soft); font-size: 0.9em;">
                    <span style="display:inline-block; width:12px; border-left:2px solid var(--line); border-bottom:2px solid var(--line); height:16px; margin-right:8px; margin-top:-8px; border-bottom-left-radius: 4px;"></span>
                    Cilindro ${cyl.target_age_days}d
                </td>
                <td style="text-align:center;"><span style="background:var(--bg-0); padding:2px 8px; border-radius:4px; font-size:0.9em; border: 1px solid var(--line);">${cyl.target_age_days} días</span></td>
                <td style="text-align:center; color:var(--text-soft);">${cyl.expected_test_date}</td>
                <td style="text-align:center;"><span class="qc-status-badge ${badgeClass}">${cyl.status.toUpperCase()}</span></td>
                <td style="text-align:center; font-weight:600; color:${isPending ? 'var(--text-muted)' : 'var(--color-success)'};">${isPending ? '<span style="opacity:0.5">-</span>' : cyl.strength_kgcm2 + ' kg/cm²'}</td>
                <td style="text-align:center;">${perfHtml}</td>
                <td style="text-align:center;">
                    ${cyl.image_path ? `<img src="${cyl.image_path}" class="qc-thumbnail" onclick="window.open('${cyl.image_path}')" title="Ver Evidencia">` : '<span style="color:var(--text-muted); font-size:0.85em; opacity:0.6;">Sin foto</span>'}
                </td>
                <td style="text-align:center; display:flex; justify-content:center;">
                    ${isPending ? `<button class="btn btn--primary btn--small" onclick="window.openTestModal(${cyl.id}, '${sample.sample_code}')" style="display:inline-flex; align-items:center; gap:4px; padding: 4px 12px;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg> Ensaye</button>` : `<span style="color:var(--text-muted); font-size:0.85em; opacity:0.6;">Completado</span>`}
                </td>
            `;
            childRows.push(tr);
            pendingCylindersTableBody.appendChild(tr);
        });

        // --- 3. Toggle Logic ---
        let expanded = false;
        trHeader.addEventListener("click", () => {
            expanded = !expanded;
            const icon = trHeader.querySelector('.qc-expand-icon');
            if (expanded) {
                icon.style.transform = "rotate(90deg)";
                childRows.forEach(row => row.style.display = "");
            } else {
                icon.style.transform = "rotate(0deg)";
                childRows.forEach(row => row.style.display = "none");
            }
        });

        // Auto-expand if there are pending cylinders? Or keep it collapsed. 
        // Let's keep it expanded by default for better visibility, since they 
        // probably want to see the dates to test.
        trHeader.click(); // programmatically click to expand
    });
}

function renderAgesBadges() {
    const qcAgesList = document.getElementById("qcAgesList");
    if (!qcAgesList) {
        console.warn("QC: Element 'qcAgesList' not found in DOM");
        return;
    }
    qcAgesList.innerHTML = "";
    sampleAges.forEach((age, index) => {
        const badge = document.createElement("div");
        badge.className = "cylinder-age-badge";
        badge.innerHTML = `
            ${age} d
            <span onclick="window.removeQcAge(${index})" title="Quitar">×</span>
        `;
        qcAgesList.appendChild(badge);
    });
}

window.removeQcAge = function (index) {
    sampleAges.splice(index, 1);
    renderAgesBadges();
}

window.editQcSample = function (sampleId) {
    const userRole = (window.APP_BOOT && window.APP_BOOT.role) ? window.APP_BOOT.role.toLowerCase() : "";
    if (userRole !== "administrador" && userRole !== "laboratorista") {
        if (typeof setStatus === 'function') setStatus("No tienes permisos para editar muestras.", 'err');
        return;
    }
    const sample = stateQcCylinders.find(c => c.sample_id === sampleId);
    if (!sample) return;

    // Fill form
    document.getElementById("qcSampleId").value = sample.sample_id;
    document.getElementById("qcSampleCode").value = sample.sample_code || "";
    document.getElementById("qcRemisionNo").value = sample.remision_id || "";
    document.getElementById("qcCastDate").value = sample.cast_date || "";
    document.getElementById("qcFcExpected").value = sample.fc_expected || "";
    document.getElementById("qcSlump").value = sample.slump_cm || "";

    // UI Changes
    document.getElementById("qcSubmitBtn").innerText = "Actualizar Muestra";
    document.getElementById("qcCancelEditBtn").classList.remove("is-hidden");

    // Smooth scroll to form
    const form = document.getElementById("addQcSampleForm");
    if (form) form.scrollIntoView({ behavior: 'smooth' });
}

window.cancelQcEdit = function () {
    document.getElementById("qcSampleId").value = "";
    const form = document.getElementById("addQcSampleForm");
    if (form) form.reset();
    document.getElementById("qcSubmitBtn").innerText = "Registrar Muestra y Cilindros";
    document.getElementById("qcCancelEditBtn").classList.add("is-hidden");
}

window.deleteQcSample = async function (sampleId) {
    const userRole = (window.APP_BOOT && window.APP_BOOT.role) ? window.APP_BOOT.role.toLowerCase() : "";
    if (userRole !== "administrador" && userRole !== "laboratorista") {
        if (typeof setStatus === 'function') setStatus("No tienes permisos para eliminar muestras.", 'err');
        return;
    }
    if (!confirm("¿Seguro que deseas eliminar toda la muestra y todos sus cilindros asociados? Esta acción no se puede deshacer.")) return;
    try {
        const response = await apiFetch("/api/qclab/samples/" + sampleId, { method: "DELETE" });
        const data = await response.json();
        if (data.ok) {
            if (typeof setStatus === 'function') setStatus("Muestra eliminada correctamente.", 'ok');
            loadLaboratoryData();
        } else {
            throw new Error(data.error || "Error al eliminar");
        }
    } catch (err) {
        if (typeof setStatus === 'function') setStatus("Error al eliminar: " + err.message, 'err');
    }
}

function setupListeners() {
    const addCylinderAgeBtn = document.getElementById("addCylinderAgeBtn");
    const cylinderAgeInput = document.getElementById("cylinderAgeInput");

    if (addCylinderAgeBtn && cylinderAgeInput) {
        addCylinderAgeBtn.addEventListener("click", () => {
            const val = parseInt(cylinderAgeInput.value);
            if (!isNaN(val) && val > 0) {
                sampleAges.push(val);
                // Sort ascending
                sampleAges.sort((a, b) => a - b);
                renderAgesBadges();
                cylinderAgeInput.value = "";
            }
        });
    }

    const qcAddSampleForm = document.getElementById("addQcSampleForm");
    if (qcAddSampleForm) {
        qcAddSampleForm.addEventListener("submit", async (e) => {
            e.preventDefault();

            if (sampleAges.length === 0) {
                if (typeof setStatus === 'function') setStatus("Agrega al menos una edad de cilindro (Ej: 3, 7, 28).", 'err');
                return;
            }

            const payload = {
                id: document.getElementById("qcSampleId").value || null,
                sample_code: document.getElementById("qcSampleCode").value,
                remision_id: String(document.getElementById("qcRemisionNo").value || "").trim(),
                cast_date: document.getElementById("qcCastDate").value,
                fc_expected: document.getElementById("qcFcExpected").value,
                slump_cm: document.getElementById("qcSlump").value,
                cylinder_ages: sampleAges
            };

            try {
                const response = await apiFetch("/api/qclab/samples", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                if (!data.ok) throw new Error(data.error || "Error del servidor al guardar muestra");

                if (typeof setStatus === 'function') setStatus("Muestra guardada correctamente.", 'ok');
                window.cancelQcEdit();
                // Reset to defaults
                sampleAges = [3, 7, 14, 28];
                renderAgesBadges();
                loadLaboratoryData();
            } catch (err) {
                if (typeof setStatus === 'function') setStatus("Error al guardar muestra: " + err.message, 'err');
            }
        });
    }

    const testImageInput = document.getElementById("testImageInput");
    if (testImageInput) {
        testImageInput.addEventListener("change", async (e) => {
            const file = e.target.files[0];
            const compressPreviewImg = document.getElementById("compressPreviewImg");
            if (!file) {
                currentCompressedFile = null;
                if (compressPreviewImg) compressPreviewImg.style.display = "none";
                return;
            }

            try {
                // Compress down to 1200px max width/height, 80% quality
                currentCompressedFile = await compressImage(file, 1200, 1200, 0.8);

                // Preview
                if (compressPreviewImg) {
                    compressPreviewImg.src = URL.createObjectURL(currentCompressedFile);
                    compressPreviewImg.style.display = "block";
                }
            } catch (error) {
                if (typeof setStatus === 'function') setStatus("Error procesando imagen: " + error.message, 'err');
            }
        });
    }

    const testCylinderForm = document.getElementById("testCylinderForm");
    if (testCylinderForm) {
        testCylinderForm.addEventListener("submit", async (e) => {
            e.preventDefault();

            if (!currentTestCylinderId) return;

            const formData = new FormData();
            formData.append("strength_kgcm2", document.getElementById("testStrength").value);
            formData.append("notes", document.getElementById("testNotes").value);
            formData.append("break_date", (window.AppGlobals && window.AppGlobals.getTodayCancun) ? window.AppGlobals.getTodayCancun() : new Date().toISOString().split("T")[0]);
            formData.append("status", "ensayado");

            if (currentCompressedFile) {
                formData.append("image", currentCompressedFile);
            }

            try {
                const response = await apiFetch(`/api/qclab/cylinders/${currentTestCylinderId}/test`, {
                    method: "POST",
                    body: formData
                });

                const data = await response.json();
                if (!data.ok) throw new Error(data.error);

                if (typeof setStatus === 'function') setStatus("Ruptura registrada correctamente.", 'ok');
                closeTestModal();
                loadLaboratoryData();
            } catch (err) {
                if (typeof setStatus === 'function') setStatus("Error al registrar ensaye: " + err.message, 'err');
            }
        });
    }
    const lookupBtn = document.getElementById("lookupRemisionBtn");
    if (lookupBtn) {
        lookupBtn.addEventListener("click", lookupRemision);
    }
}

window.openTestModal = function (cylinderId, sampleCode) {
    const testCylinderModal = document.getElementById("testCylinderModal");
    const testCylinderForm = document.getElementById("testCylinderForm");
    const compressPreviewImg = document.getElementById("compressPreviewImg");

    currentTestCylinderId = cylinderId;
    document.getElementById("testModalTitle").innerText = `Ensaye Cilindro: ${sampleCode}`;
    if (testCylinderForm) testCylinderForm.reset();
    if (compressPreviewImg) compressPreviewImg.style.display = "none";
    if (testCylinderModal) {
        testCylinderModal.classList.remove("is-hidden");
        testCylinderModal.classList.add("is-active");
    }
}

window.closeTestModal = function () {
    const testCylinderModal = document.getElementById("testCylinderModal");
    if (testCylinderModal) {
        testCylinderModal.classList.add("is-hidden");
        testCylinderModal.classList.remove("is-active");
    }
    currentTestCylinderId = null;
}

window.openChartModal = async function (sampleId, sampleCode) {
    const modal = document.getElementById("qcChartModal");
    if (!modal) return;

    document.getElementById("qcChartModalTitle").innerText = `Evolución: ${sampleCode}`;
    modal.classList.remove("is-hidden");
    modal.classList.add("is-active");

    renderEvolutionChart(sampleId);
}

window.closeChartModal = function () {
    const modal = document.getElementById("qcChartModal");
    if (modal) {
        modal.classList.add("is-hidden");
        modal.classList.remove("is-active");
    }
}

let activeChart = null;

async function renderEvolutionChart(sampleId) {
    try {
        const response = await apiFetch(`/api/qclab/samples/${sampleId}`);
        const res = await response.json();
        if (!res.ok) throw new Error(res.error);

        const sample = res.sample;
        const fcExpected = sample.fc_expected || 0;
        const cylinders = sample.cylinders || [];

        // Theoretical curve points (simplistic)
        const theoreticalPoints = [
            { x: 3, y: fcExpected * 0.5 },
            { x: 7, y: fcExpected * 0.7 },
            { x: 14, y: fcExpected * 0.85 },
            { x: 28, y: fcExpected * 1.0 }
        ];

        // Real points
        const realPoints = cylinders
            .filter(c => c.status === 'ensayado')
            .map(c => ({ x: c.target_age_days, y: c.strength_kgcm2 }))
            .sort((a, b) => a.x - b.x);

        const ctx = document.getElementById('qcEvolutionChart').getContext('2d');

        if (activeChart) activeChart.destroy();

        activeChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Curva Teórica Esperada',
                        data: theoreticalPoints,
                        borderColor: '#94a3b8',
                        backgroundColor: 'transparent',
                        borderDash: [5, 5],
                        tension: 0.3,
                        pointRadius: 0
                    },
                    {
                        label: 'Resultados Reales (kg/cm²)',
                        data: realPoints,
                        borderColor: '#2563eb', // Formix Brand
                        backgroundColor: '#2563eb',
                        tension: 0.1,
                        fill: false,
                        pointRadius: 6,
                        pointHoverRadius: 8
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        type: 'linear',
                        title: { display: true, text: 'Edad (Días)' },
                        min: 0,
                        max: 30
                    },
                    y: {
                        title: { display: true, text: 'Resistencia (kg/cm²)' },
                        min: 0,
                        suggestedMax: fcExpected * 1.2
                    }
                },
                plugins: {
                    legend: { position: 'top' }
                }
            }
        });

        // Details text
        const details = document.getElementById("qcChartDetails");
        if (details) {
            details.innerHTML = `
                <p><b>f'c de diseño:</b> ${fcExpected} kg/cm²</p>
                <p><b>Muestra:</b> ${sample.sample_code} | <b>Fecha colado:</b> ${sample.cast_date}</p>
                ${sample.formula ? `<p><b>Diseño:</b> ${sample.formula}</p>` : ''}
            `;
        }
    } catch (err) {
        console.error("Error rendering chart:", err);
    }
}

// Compress Image Logic
function compressImage(file, maxWidth, maxHeight, quality) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = event => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round(height *= maxWidth / width);
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round(width *= maxHeight / height);
                        height = maxHeight;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(blob => {
                    resolve(new File([blob], file.name, {
                        type: 'image/jpeg',
                        lastModified: Date.now()
                    }));
                }, 'image/jpeg', quality);
            };
            img.onerror = error => reject(error);
        };
        reader.onerror = error => reject(error);
    });
}

// Preview Compressed image
let currentCompressedFile = null;



window.loadQcLabData = loadLaboratoryData;
window.initQcLab = initQcLab;

// Trigger listeners setup
setupListeners();

// Auto-init on script load if the view is already active
const labView = document.getElementById("laboratorioView");
if (labView && !labView.classList.contains("is-hidden")) {
    initQcLab();
    loadLaboratoryData();
} else {
    initQcLab();
}
