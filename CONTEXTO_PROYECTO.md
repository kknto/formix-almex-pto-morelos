# CONTEXTO_PROYECTO

Ultima actualizacion: 2026-03-06
Proyecto: Editor web de disenos de mezcla (Flask + SQLite)

## 1) Objetivo funcional
Aplicacion web para:
- Cargar datasets CSV de disenos de mezcla.
- Editar filas/columnas en interfaz (Editor CSV).
- Consultar mezclas y calcular receta/costos (Consulta Mix).
- Simular dosificacion real/teorica (Dosificador).
- Exportar reportes imprimibles (Consulta Mix y Dosificador).

## 2) Stack y ejecucion
- Backend: Flask (archivo principal `app.py`).
- Frontend: HTML + CSS + JS vanilla (`templates/index.html`, `static/js/app.js`, `static/css/styles.css`).
- Persistencia: SQLite (`mix_data.sqlite3`).
- Autenticacion: login por sesion (cookie segura de servidor).

Comandos:
- Instalar deps: `py -m pip install -r requirements.txt`
- Ejecutar: `py app.py`
- URL: `http://127.0.0.1:8080`

## 3) Estado actual de BD
Tablas principales:
- `datasets`: dataset activo y datasets cargados (con `family_code`, `version`, `deleted_at`, `content_hash`).
- `dataset_revisions`: historial de revisiones por dataset.
- `app_state`: estado general (dataset activo).
- `upload_staging`: staging temporal para carga segura (`preview`/`commit`).
- `qc_profiles`: Control de Calidad por dataset (PVS, PVC, densidad, absorcion, humedad + version).
- `doser_profiles`: parametros de dosificacion por dataset (`cemento_pesp`, `aire_pct`, `pasa_malla_200_pct`, `pxl_pond_pct`, `densidad_agregado_fallback` + version).
- `remisiones`: historial operativo de remisiones por dataset, con snapshot completo del reporte de dosificador.
- `users`: usuarios/roles con control de cambio forzoso de contrasena (`must_change_password`, `password_updated_at`).
- `audit_log`: bitacora de eventos criticos (quien, cuando, accion, entidad, detalles JSON).

Persistencia adicional:
- Snapshots automáticos de BD en `backups/db_snapshots` antes de operaciones criticas.
- API para respaldo manual y restauracion controlada (desde snapshots SQLite).

## 4) Endpoints API disponibles
Definidos en `app.py`:
- `GET /login`
- `POST /login`
- `POST /logout`
- `GET /api/session`
- `GET /change-password`
- `POST /change-password`
- `GET /api/data`
- `GET /api/qc`
- `POST /api/qc/save`
- `POST /api/qc/humidity/save`
- `GET /api/doser/params`
- `POST /api/doser/params/save`
- `POST /api/select`
- `POST /api/upload/preview`
- `POST /api/upload/commit`
- `POST /api/upload` (legacy)
- `POST /api/delete`
- `POST /api/family`
- `POST /api/save`
- `GET /api/history`
- `POST /api/history/restore`
- `GET /api/audit`
- `GET /api/remisiones`
- `POST /api/remisiones/save`
- `GET /api/remisiones/<id>`
- `DELETE /api/remisiones/<id>`
- `GET /api/backups`
- `POST /api/backups/create`
- `POST /api/backups/restore` (solo administrador)

## 5) Seguridad de carga y concurrencia
Implementado:
- Carga en dos pasos (`preview` + `commit`).
- Modos de importacion: `new`, `replace`, `merge`.
- Validacion de estructura y limites de CSV.
- Deteccion de duplicados por hash (`content_hash`).
- Staging con expiracion (`upload_staging`).
- Sanitizacion basica de celdas.
- Concurrencia optimista por `version` (save/restore y QC save).
- Bloqueo temporal de cuenta por intentos fallidos de login.
- Mapeo flexible de encabezados CSV en bootstrap y upload preview
  (normaliza alias comunes a encabezados canonicos antes de validar/guardar).
- Bitacora de auditoria para operaciones criticas:
  guardado dataset, carga/merge/replace CSV, cambios de familia, QC, restauraciones, remisiones, backup, cambio de contrasena.
- Cambio obligatorio de contrasena para usuarios con credenciales por defecto:
  redireccion a `/change-password` y bloqueo de API (excepto `GET /api/session`) hasta actualizar.
- Respaldo/restauracion:
  - crear respaldo manual desde UI/API.
  - listar respaldos disponibles.
  - restaurar respaldo (solo admin), con snapshot preventivo previo.

## 5.1 Autenticacion y autorizacion
- Login obligatorio para entrar a la app (`/` redirige a `/login` si no hay sesion).
- Sesion con `HttpOnly` + `SameSite=Lax`.
- Roles y vistas permitidas:
- `administrador`: `editor`, `consulta`, `dosificador`.
- `jefe-de-planta`: `editor`, `consulta`, `dosificador`.
- `dosificador`: `dosificador`.
- `presupuestador`: `consulta`.
- Roles con permisos de edicion de datos: `administrador`, `jefe-de-planta`.
- Bloqueo de login: 5 intentos fallidos -> 15 minutos.
- Usuarios iniciales:
- `admin / Admin#2026!`
- `jefe_planta / Planta#2026!`
- `dosificador / Dosi#2026!`
- `presupuestador / Presu#2026!`
- Nota: se recomienda cambio de credenciales en produccion.

## 6) Reglas funcionales clave (estado actual)

### 6.1 Editor CSV
- Tabla editable con columna automatica `FECHA_MODIF`.
- Renombrado de encabezados permitido (incluyendo etiqueta de tipo en parentesis).
- Gestion de datasets (abrir, cargar nuevo, eliminar logico).
- Campo `Familia` por dataset (persistido en SQLite y editable desde UI).
- Historial/restauracion por dataset.
- Botones adicionales de operacion segura:
  - `Bitacora` (consulta de eventos recientes),
  - `Crear respaldo`,
  - `Restaurar respaldo` (solo administrador).
- En carga CSV se informa en UI el mapeo automatico de encabezados detectado.

### 6.2 Control de Calidad (QC)
- Fuente unica por dataset (`qc_profiles`).
- Se captura desde Editor CSV.
- Se refleja en Dosificador y Consulta Mix.
- Reglas de edicion por rol/campo:
- `PVS`, `PVC`, `Densidad`, `Absorcion`: se editan en `Editor CSV` (roles de edicion).
- `Humedad`: se edita y guarda desde `Dosificador` (rol `dosificador`).
- En `Editor CSV`, `Humedad` queda en solo lectura.
- Endpoint dedicado para humedad: `POST /api/qc/humidity/save` (solo `dosificador`).

### 6.3 Consulta Mix - Receta
- Muestra receta seleccionada y metadatos.
- `Familia` en consultas prioriza: columna `Familia/FAMILY` del CSV -> `family_code` del dataset -> fallback por formula.
- En tabla `Buscador` se muestran 5 filas visibles con scroll interno.
- Encabezados de `Buscador` en Consulta Mix con unidades:
  - `f'c (kg/cm2)`, `Edad (dias)`, `T.M.A. (MM)`, `Rev (cm)`.
- Estilo de unidades en encabezados de `Buscador` (Consulta Mix) compactado con fuente menor para mejorar legibilidad y reducir saltos de linea.
- Etiquetas de filtros en `Buscador` (Consulta Mix y Dosificador) tambien muestran unidades compactas en tamaño menor.
- Encabezados de tabla de `Buscador` en Dosificador tambien muestran unidades en el mismo formato compacto.
- Layout visual en `Consulta Mix` con carrusel de 2 pasos:
- Paso 1: `Familias Mix por T.M.A.` + `Buscador`.
- Paso 2: `Receta` + `Costos por m³`.
- Navegacion con botones `Anterior` / `Siguiente`.
- Al seleccionar una fila en `Buscador`, la vista avanza a Paso 2.
- Tablas de Consulta Mix compactadas para evitar scroll horizontal:
- `table-layout: fixed`, ajuste de anchos por columna, texto envolvente y tipografia compacta.
- Inputs de costos/acarreo mas compactos para mejorar visibilidad de toda la fila.
- Se retiro el selector de `Modo basico/avanzado`; queda una sola vista estable.
- `Fino 1`, `Fino 2`, `Grueso 1`, `Grueso 2` se muestran aunque valgan 0.
- Columna `Vol. Est. m³`: SOLO calcula para agregados (Fino/Grueso). Resto muestra `-`.
- `Reductor` y `Retardante` se muestran como `cc/kg-cto` y su cantidad se divide entre 1000.
- `Peso aproximado por m3` suma cantidades tal cual (sin convertir litros).

### 6.4 Consulta Mix - Costos por m³
Columnas actuales:
- Componente
- Cant. Final
- m³
- U.M.
- Acarreo ($)
- Costo Unit. ($)
- Subtotal

Reglas de calculo:
- `Cant. Final` usa ajuste por humedad/absorcion (para agregados) y correccion de agua.
- `m³` en costos SOLO para agregados (Fino/Grueso). Resto `-`.
- Para agregados: `m³ = kg_final / PV`.
- `PV` se toma por prioridad: `PVC` -> `PVS` -> `densidad` -> fallback default.
- Subtotal agregados: `m³ * (Costo Unit. + Acarreo)`.
- Subtotal no agregados: `Cant. Final * Costo Unit.`.
- Se muestra:
  - `Sub-Total acarreo m³`
  - `Sub-Total materiales m³`
  - `Total por m³` (materiales + acarreo).

### 6.5 Dosificador
Incluye:
- Tabla de QC (solo lectura en esta vista, editable en Editor).
- Tolerancias de carga.
- Parametros de calculo por dataset (persistidos en SQLite y versionados):
  `Peso esp. cemento`, `Aire`, `Pasa malla 200`, `PxL pond.`, `Densidad agg fallback`.
- Buscador de mezcla.
- Receta.
- Carga teorica detallada (flujo tipo Excel):
  `Diseno A`, `Diseno SSS`, `Agua libre H.R.`, `Vol. Abs.`, `Diseno H.R.`, `Mezcla Prueba`, `U.M.`, `Obs`.
- Carga real y diferencial con estatus por tolerancia.
- Manejo seguro de divisiones por cero (fallback configurable) para evitar errores cuando faltan datos base.
- Aditivos (`Reductor`, `Retardante`) se calculan desde dosis en `cc/kg-cto` a litros con base en kg de cemento.
- Se unifico la normalizacion de aditivos entre `Consulta Mix` y `Dosificador`:
  ambos usan la misma conversion de origen para evitar inflar 1000x los litros teoricos.
- Ajuste posterior para alinear al Excel del usuario final:
  en `Dosificador` los aditivos se interpretan como `Lts/m3` en diseno, y la mezcla de prueba
  se calcula con el flujo `=(m3/1000)*aditivo*(1000)` (equivalente a `m3 * aditivo`).
- Control de acceso: `Tolerancias de Carga` solo editable por rol `jefe-de-planta`.
- Para `dosificador` queda bloqueado en UI (solo lectura).
- Buscador de `Dosificador` alineado con `Consulta Mix`:
- mismos filtros y columnas (`Familia`, `f'c`, `Edad`, `Tipo`, `T.M.A.`, `Rev`, `Complemento`).
- Registro de remisiones:
- Campo `No. Remision` en Dosificador + boton `Guardar Remision`.
- Se guarda snapshot de datos clave del reporte (metadatos, receta, carga teorica/real, QC, tolerancias y totales).
- Listado de remisiones recientes por dataset en la misma pestaña.
- Desde el listado de remisiones se puede abrir el `Reporte de Dosificador` completo con el snapshot guardado (`Ver reporte`).
- En el listado de remisiones se puede `Eliminar` una remision (con confirmacion) desde la columna de acciones.
- En `Carga Real y Diferencial`, la captura del valor real ya no re-renderiza en cada tecla:
  confirma valor en `change`/`blur`/`Enter` para permitir ingresar numeros completos sin corte.
- Mejora visual en `Dosificador`:
  - grillas superior/inferior con alturas mas consistentes,
  - tablas con anchos de columna definidos,
  - encabezados sticky dentro de cada tabla,
  - alineacion numerica uniforme (con numeros tabulares),
  - ajustes responsive para evitar descuadres al apilar paneles.
- Ajuste posterior de layout en `Dosificador`:
  - `Receta` se mantiene en la fila superior de resultados.
  - `Carga Teorica Detallada` y `Carga Real y Diferencial` se agrupan juntas al final para comparacion directa.
  - Se reforzo el ancho/nowrap de columnas numericas en `Carga Teorica Detallada` para evitar sobreposicion visual.
- Ajuste visual adicional en tabla `Receta` (Dosificador):
  - se simplifico a 2 columnas (`Componente`, `Cantidad`),
  - unidad integrada en la misma celda de cantidad (`valor + unidad`),
  - contenedor compacto/centrado para evitar espacios vacios excesivos.
- Correccion de visibilidad entre pestañas:
  - se ajusto CSS de `#dosificadorView` para no anular `.is-hidden`.
  - el contenido de Dosificador vuelve a mostrarse solo en su pestaña.

### 6.6 Notificaciones UI
- Se reemplazaron dialogos nativos del navegador (`prompt/confirm`) por modales propios de la app
  para mantener coherencia visual.
- El estado global (`statusBar`) ahora usa estilo de aviso visual (ok/warn/err) con mejor contraste.
- Se agregaron toasts visuales para avisos de `warn/err`.
- Se agregaron variantes por severidad (`ok`, `warn`, `err`, `info`) en:
  - encabezado/chip del modal,
  - boton principal de confirmacion,
  - estilo de toast.
- Se agregaron iconos SVG por severidad en modales y toasts para mejorar lectura visual.
- Limpieza de codificacion en textos UI/reporte:
  se corrigieron cadenas con mojibake (`mÃ‚Â³`, `DiseÃ±o`, etc.) en plantillas y JS.

### 6.6 Remisiones (SQLite)
- Nueva tabla: `remisiones`.
- Clave unica: `remision_no`.
- Campos principales: `formula`, `fc`, `edad`, `tipo`, `tma`, `rev`, `comp`, `dosificacion_m3`,
  `peso_receta`, `peso_teorico_total`, `peso_real_total`, `status`, `created_by`, `created_at`.
- Campo `snapshot_json` para conservar el detalle completo del reporte de dosificador al momento de guardar.
- Endpoints:
- `GET /api/remisiones` (lista por dataset activo/seleccionado).
- `POST /api/remisiones/save` (alta de remision).
- `GET /api/remisiones/<id>` (detalle + snapshot para reimprimir reporte).
- `DELETE /api/remisiones/<id>` (eliminacion de remision por dataset activo/seleccionado).

## 7) Reportes

### 7.1 Reporte Consulta Mix
- Boton: `Exportar Reporte`.
- Contenido:
  - Encabezado de mezcla y metadatos.
  - Tabla Receta.
  - Tabla Costos por m³.
  - Totales (receta, Sub-Total acarreo m³, Sub-Total materiales m³, Total por m³).
- Firma: `ForMix by Labsico - Disena-Dosifica-Calcula`.
- Diseno compactado para imprimir en una sola hoja (landscape).
- En columna Componente del reporte se usa etiqueta expandida para agregados,
  por ejemplo: `Fino 1 (Lavada)` y `Grava 1 (...)`.

### 7.2 Reporte Dosificador
- Boton: `Exportar Reporte Dosificador`.
- Contenido:
  - Numero de remision (cuando este capturado en Dosificador).
  - Datos de Control de Calidad.
  - Tolerancias de Carga.
  - Parametros de calculo activos.
  - Receta.
  - Carga Teorica Detallada.
  - Carga Real y Diferencial.
- Firma incluida.
- Diseno de impresion compactado para reducir espacios vacios:
  - Formato A4 horizontal.
  - Margen de pagina en impresion configurado en `0` para maximizar area util.
  - Encabezado y metadatos en tabla compacta.
  - Bloques en rejilla (QC + Tolerancias, Receta + Carga Teorica, Carga Real ancho completo).
  - Filas/celdas densas para mejor legibilidad en una sola hoja.

## 8) Decisiones del negocio ya aplicadas
- Eliminar CSV en UI = borrado logico de dataset, no destruccion fisica de BD.
- Familia principal de cada dataset se identifica por nombre de archivo al cargar (con opcion de ajuste manual).
- Se registra fecha de modificacion por fila (`FECHA_MODIF`).
- Litros NO se convierten para el total de peso aproximado en Receta (Consulta Mix).
- m³ de costos se limita a agregados.
- Acarreo se maneja por m³ y se integra en subtotal de agregados.

## 9) Pendientes / puntos abiertos
1. Validar con operacion si se mantiene definitivamente la logica actual de aditivos:
   `kg cemento * dosis(cc/kg) -> ml -> L`, ya implementada en Dosificador.
2. Validar rangos permitidos para QC (hoy solo valida no negativos y limite alto).
3. Definir migracion futura de SQLite a PostgreSQL.
4. Si se requiere, agregar exportacion PDF directa (hoy se imprime desde navegador).

## 10) Archivos clave para continuar
- Backend: `app.py`
- Frontend JS: `static/js/app.js`
- Vista: `templates/index.html`
- Estilos: `static/css/styles.css`
- Documentacion base: `README.md`
- Assets de marca cargados:
  - `static/img/logo_almex.png`
  - `static/img/logo_almex.svg`
- Integracion visual de marca ALMEX aplicada en:
  - barra superior de la app (`index.html`),
  - pantalla de login (`login.html`),
  - favicon en app/login,
  - encabezado de reportes (Consulta Mix y Dosificador).

## 11) Checklist rapido antes de continuar desarrollo
- Probar login por rol y restricciones de pestañas.
- Probar bloqueo por intentos fallidos.
- Levantar app: `py app.py`
- Probar carga CSV (preview/commit).
- Probar mapeo de encabezados (CSV con nombres alternativos).
- Probar guardado Editor CSV y FECHA_MODIF.
- Probar guardado QC y reflejo en Consulta/Dosificador.
- Probar bitacora (`/api/audit`) en acciones criticas.
- Probar backup manual y restore (admin).
- Probar login con usuario por defecto -> cambio de contrasena obligatorio.
- Probar calculos de costos (m3, acarreo, total).
- Probar reportes de Consulta Mix y Dosificador.
