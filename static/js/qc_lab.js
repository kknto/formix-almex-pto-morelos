// qc_lab.js
// Handles displaying and creating QC samples and testing cylinders

const qcDashboardContainer = document.getElementById("qcDashboard");
const pendingCylindersTableBody = document.getElementById("pendingCylindersTbody");
const qcAddSampleForm = document.getElementById("addQcSampleForm");
const qcAgesList = document.getElementById("qcAgesList");
const addCylinderAgeBtn = document.getElementById("addCylinderAgeBtn");
const cylinderAgeInput = document.getElementById("cylinderAgeInput");

// Test Cylinder Modal logic
const testCylinderModal = document.getElementById("testCylinderModal");
const testCylinderForm = document.getElementById("testCylinderForm");
const compressPreviewImg = document.getElementById("compressPreviewImg");
let currentTestCylinderId = null;

let stateQcCylinders = [];
let sampleAges = [3, 7, 14, 28]; // Default ages for a native sample

function initQcLab() {
    renderAgesBadges();
}

async function loadQcData() {
    try {
        const res = await apiFetch("/api/qclab/cylinders?pending_only=false");
        stateQcCylinders = res.cylinders || [];
        renderQcCylinders();
        renderQcDashboard();
    } catch (err) {
        if(typeof setStatus === 'function') setStatus("Error cargando laboratorio: " + err.message, 'err'); else alert("Error cargando laboratorio: " + err.message);
    }
}

function renderQcDashboard() {
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
    if (!pendingCylindersTableBody) return;
    pendingCylindersTableBody.innerHTML = "";

    stateQcCylinders.forEach(cyl => {
        const tr = document.createElement("tr");
        
        const badgeClass = cyl.status === "pendiente" ? "qc-status-pendiente" : "qc-status-ensayado";
        const isPending = cyl.status === "pendiente";

        tr.innerHTML = `
            <td><strong>${cyl.sample_code}</strong></td>
            <td>${cyl.target_age_days} días</td>
            <td>${cyl.expected_test_date}</td>
            <td><span class="qc-status-badge ${badgeClass}">${cyl.status.toUpperCase()}</span></td>
            <td>${isPending ? '-' : cyl.strength_kgcm2 + ' kg/cm²'}</td>
            <td>
                ${cyl.image_path ? `<img src="${cyl.image_path}" class="qc-thumbnail" onclick="window.open('${cyl.image_path}')" title="Ver foto">` : '-'}
            </td>
            <td>
                ${isPending ? `<button class="btn btn-primary" onclick="window.openTestModal(${cyl.id}, '${cyl.sample_code}')">Registrar Ruptura</button>` : ''}
            </td>
        `;
        pendingCylindersTableBody.appendChild(tr);
    });
}

function renderAgesBadges() {
    if(!qcAgesList) return;
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

if(addCylinderAgeBtn) {
    addCylinderAgeBtn.addEventListener("click", () => {
        const val = parseInt(cylinderAgeInput.value);
        if(!isNaN(val) && val > 0) {
            sampleAges.push(val);
            // Sort ascending
            sampleAges.sort((a,b) => a - b);
            renderAgesBadges();
            cylinderAgeInput.value = "";
        }
    });
}

if(qcAddSampleForm) {
    qcAddSampleForm.addEventListener("submit", async(e) => {
        e.preventDefault();
        
        if (sampleAges.length === 0) {
            if(typeof setStatus === 'function') setStatus("Agrega al menos una edad de cilindro (Ej: 3, 7, 28).", 'err'); else alert("Agrega al menos una edad de cilindro (Ej: 3, 7, 28).");
            return;
        }

        const payload = {
            sample_code: document.getElementById("qcSampleCode").value,
            cast_date: document.getElementById("qcCastDate").value,
            fc_expected: document.getElementById("qcFcExpected").value,
            slump_cm: document.getElementById("qcSlump").value,
            cylinder_ages: sampleAges
        };

        try {
            await apiFetch("/api/qclab/samples", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if(typeof setStatus === 'function') setStatus("Muestra guardada correctamente.", 'ok'); else alert("Muestra guardada correctamente.");
            qcAddSampleForm.reset();
            // Reset to defaults
            sampleAges = [3, 7, 14, 28];
            renderAgesBadges();
            loadQcData();
        } catch(err) {
            if(typeof setStatus === 'function') setStatus("Error al guardar muestra: " + err.message, 'err'); else alert("Error al guardar muestra: " + err.message);
        }
    });
}

window.openTestModal = function(cylinderId, sampleCode) {
    currentTestCylinderId = cylinderId;
    document.getElementById("testModalTitle").innerText = `Ensaye Cilindro: ${sampleCode}`;
    testCylinderForm.reset();
    if(compressPreviewImg) compressPreviewImg.style.display = "none";
    testCylinderModal.classList.add("is-active");
}

window.closeTestModal = function() {
    testCylinderModal.classList.remove("is-active");
    currentTestCylinderId = null;
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
const testImageInput = document.getElementById("testImageInput");
let currentCompressedFile = null;

if (testImageInput) {
    testImageInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
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
            if(typeof setStatus === 'function') setStatus("Error procesando imagen: " + error.message, 'err'); else alert("Error procesando imagen: " + error.message);
        }
    });
}

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
            const response = await fetch(`/api/qclab/cylinders/${currentTestCylinderId}/test`, {
                method: "POST",
                headers: { "X-CSRFToken": document.querySelector('meta[name="csrf-token"]').getAttribute('content') },
                body: formData
            });

            const data = await response.json();
            if (!data.ok) throw new Error(data.error);
            
            if(typeof setStatus === 'function') setStatus("Ruptura registrada correctamente.", 'ok'); else alert("Ruptura registrada correctamente.");
            closeTestModal();
            loadQcData();
        } catch(err) {
            if(typeof setStatus === 'function') setStatus("Error al registrar ensaye: " + err.message, 'err'); else alert("Error al registrar ensaye: " + err.message);
        }
    });
}

window.loadQcLabData = loadQcData;
window.initQcLab = initQcLab;
