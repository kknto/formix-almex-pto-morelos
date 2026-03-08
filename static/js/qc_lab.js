let stateQcCylinders = [];
let sampleAges = [3, 7, 14, 28]; // Default ages for a native sample
let currentTestCylinderId = null;

async function lookupRemision() {
    const remNo = document.getElementById("qcRemisionNo").value.trim();
    if (!remNo) {
        if(typeof setStatus === 'function') setStatus("Ingresa un nº de remisión para buscar.", 'warn');
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
            if (rem.fc || rem.rev) {
                if(typeof setStatus === 'function') setStatus(`Datos cargados de remisión ${remNo}.`, 'ok');
            }
            // We could auto-fill more if we had more fields in the form
        } else {
            if(typeof setStatus === 'function') setStatus("Remisión no encontrada.", 'warn');
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
        if(typeof setStatus === 'function') setStatus("Error cargando laboratorio: " + err.message, 'err'); else console.error("Error cargando laboratorio: " + err.message);
    }
}

function renderQcDashboard() {
    const qcDashboardContainer = document.getElementById("qcDashboard");
    if(!qcDashboardContainer) return;
    
    let pendingToday = 0;
    let overdue = 0;
    let totalPending = 0;

    const todayStr = new Date().toISOString().split("T")[0];

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

    stateQcCylinders.forEach(cyl => {
        const tr = document.createElement("tr");
        const isPending = cyl.status === "pendiente";
        const badgeClass = isPending ? "qc-status-pendiente" : "qc-status-ensayado";
        
        const svgIcon = `<svg style="width:16px; height:16px; margin-right:6px; color:var(--brand); vertical-align:middle;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>`;

        const designInfo = (cyl.formula || cyl.fc || cyl.tma) ? 
            `<div style="font-size:0.75rem; color:var(--text-soft); font-weight:400; margin-top:4px; padding:2px 4px; background:var(--bg-1); border-radius:3px; display:inline-block;">
                ${cyl.formula ? `<b>${cyl.formula}</b>` : ''} 
                ${cyl.fc ? ` | f'c ${cyl.fc}` : ''}
                ${cyl.tma ? ` | TMA ${cyl.tma}` : ''}
                ${cyl.tipo ? ` | ${cyl.tipo}` : ''}
            </div>` : '';

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
            <td style="font-weight:600; color:var(--text-color);">
                <div>${svgIcon}${cyl.sample_code}</div>
                ${designInfo}
            </td>
            <td style="text-align:center;"><span style="background:var(--bg-hover); padding:2px 8px; border-radius:4px; font-size:0.9em;">${cyl.target_age_days} días</span></td>
            <td style="text-align:center; color:var(--text-soft);">${cyl.expected_test_date}</td>
            <td style="text-align:center;"><span class="qc-status-badge ${badgeClass}">${cyl.status.toUpperCase()}</span></td>
            <td style="text-align:center; font-weight:600; color:${isPending ? 'var(--text-muted)' : 'var(--color-success)'};">${isPending ? '<span style="opacity:0.5">-</span>' : cyl.strength_kgcm2 + ' kg/cm²'}</td>
            <td style="text-align:center;">${perfHtml}</td>
            <td style="text-align:center;">
                ${cyl.image_path ? `<img src="${cyl.image_path}" class="qc-thumbnail" onclick="window.open('${cyl.image_path}')" title="Ver Evidencia">` : '<span style="color:var(--text-muted); font-size:0.85em; opacity:0.6;">Sin foto</span>'}
            </td>
            <td style="text-align:center; display:flex; justify-content:center; gap:8px;">
                ${isPending ? `<button class="btn btn--primary btn--small" onclick="window.openTestModal(${cyl.id}, '${cyl.sample_code}')" style="display:inline-flex; align-items:center; gap:4px;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg> Ensaye</button>` : `<button class="btn btn--muted btn--small" onclick="window.openChartModal(${cyl.sample_id}, '${cyl.sample_code}')" title="Ver Gráfica de Evolución"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg></button>`}
                <button type="button" class="btn btn--muted btn--small" onclick="window.deleteQcSample(${cyl.sample_id})" title="Eliminar Muestra Completa" style="color:var(--color-danger); border-color:transparent; padding:4px 8px;"><svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
            </td>
        `;
        pendingCylindersTableBody.appendChild(tr);
    });
}

function renderAgesBadges() {
    const qcAgesList = document.getElementById("qcAgesList");
    if(!qcAgesList) {
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

window.removeQcAge = function(index) {
    sampleAges.splice(index, 1);
    renderAgesBadges();
}

window.deleteQcSample = async function(sampleId) {
    if(!confirm("¿Seguro que deseas eliminar toda la muestra y todos sus cilindros asociados? Esta acción no se puede deshacer.")) return;
    try {
        const response = await apiFetch("/api/qclab/samples/" + sampleId, { method: "DELETE" });
        const data = await response.json();
        if (data.ok) {
            if(typeof setStatus === 'function') setStatus("Muestra eliminada correctamente.", 'ok');
            loadLaboratoryData();
        } else {
            throw new Error(data.error || "Error al eliminar");
        }
    } catch(err) {
        if(typeof setStatus === 'function') setStatus("Error al eliminar: " + err.message, 'err');
    }
}

function setupListeners() {
    const addCylinderAgeBtn = document.getElementById("addCylinderAgeBtn");
    const cylinderAgeInput = document.getElementById("cylinderAgeInput");
    
    if(addCylinderAgeBtn && cylinderAgeInput) {
        addCylinderAgeBtn.addEventListener("click", () => {
            const val = parseInt(cylinderAgeInput.value);
            if(!isNaN(val) && val > 0) {
                if (sampleAges.includes(val)) {
                    if(typeof setStatus === 'function') setStatus("Esa edad ya esta en la lista.", 'warn');
                    return;
                }
                sampleAges.push(val);
                // Sort ascending
                sampleAges.sort((a,b) => a - b);
                renderAgesBadges();
                cylinderAgeInput.value = "";
            }
        });
    }

    const qcAddSampleForm = document.getElementById("addQcSampleForm");
    if(qcAddSampleForm) {
        qcAddSampleForm.addEventListener("submit", async(e) => {
            e.preventDefault();
            
            if (sampleAges.length === 0) {
                if(typeof setStatus === 'function') setStatus("Agrega al menos una edad de cilindro (Ej: 3, 7, 28).", 'err');
                return;
            }

            const payload = {
                sample_code: document.getElementById("qcSampleCode").value,
                remision_id: document.getElementById("qcRemisionNo").value,
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

                if(typeof setStatus === 'function') setStatus("Muestra guardada correctamente.", 'ok');
                qcAddSampleForm.reset();
                // Reset to defaults
                sampleAges = [3, 7, 14, 28];
                renderAgesBadges();
                loadLaboratoryData();
            } catch(err) {
                if(typeof setStatus === 'function') setStatus("Error al guardar muestra: " + err.message, 'err');
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
                if(typeof setStatus === 'function') setStatus("Error procesando imagen: " + error.message, 'err');
            }
        });
    }

    const testCylinderForm = document.getElementById("testCylinderForm");
    if(testCylinderForm) {
        testCylinderForm.addEventListener("submit", async(e) => {
            e.preventDefault();
            
            if(!currentTestCylinderId) return;

            const formData = new FormData();
            formData.append("strength_kgcm2", document.getElementById("testStrength").value);
            formData.append("notes", document.getElementById("testNotes").value);
            formData.append("break_date", new Date().toISOString().split("T")[0]);
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
                
                if(typeof setStatus === 'function') setStatus("Ruptura registrada correctamente.", 'ok');
                closeTestModal();
                loadLaboratoryData();
            } catch(err) {
                if(typeof setStatus === 'function') setStatus("Error al registrar ensaye: " + err.message, 'err');
            }
        });
    }
    const lookupBtn = document.getElementById("lookupRemisionBtn");
    if (lookupBtn) {
        lookupBtn.addEventListener("click", lookupRemision);
    }
}

window.openTestModal = function(cylinderId, sampleCode) {
    const testCylinderModal = document.getElementById("testCylinderModal");
    const testCylinderForm = document.getElementById("testCylinderForm");
    const compressPreviewImg = document.getElementById("compressPreviewImg");
    
    currentTestCylinderId = cylinderId;
    document.getElementById("testModalTitle").innerText = `Ensaye Cilindro: ${sampleCode}`;
    if (testCylinderForm) testCylinderForm.reset();
    if(compressPreviewImg) compressPreviewImg.style.display = "none";
    if (testCylinderModal) {
        testCylinderModal.classList.remove("is-hidden");
        testCylinderModal.classList.add("is-active");
    }
}

window.closeTestModal = function() {
    const testCylinderModal = document.getElementById("testCylinderModal");
    if (testCylinderModal) {
        testCylinderModal.classList.add("is-hidden");
        testCylinderModal.classList.remove("is-active");
    }
    currentTestCylinderId = null;
}

window.openChartModal = async function(sampleId, sampleCode) {
    const modal = document.getElementById("qcChartModal");
    if (!modal) return;

    document.getElementById("qcChartModalTitle").innerText = `Evolución: ${sampleCode}`;
    modal.classList.remove("is-hidden");
    modal.classList.add("is-active");

    renderEvolutionChart(sampleId);
}

window.closeChartModal = function() {
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
