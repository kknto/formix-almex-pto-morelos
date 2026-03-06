# Editor Web de Disenos de Mezclas (Flask)

Aplicacion web para cargar, visualizar y editar el archivo CSV de disenos de mezcla de una planta de concreto.

## Requisitos

- Windows con Python (recomendado `py`)
- Dependencias:

```bash
py -m pip install -r requirements.txt
```

## Ejecutar

```bash
py app.py
```

Abrir en navegador:

```text
http://127.0.0.1:8080
```

## Persistencia

- La informacion se guarda en SQLite (`mix_data.sqlite3`) y no depende de escribir directo al CSV.
- El primer arranque toma un CSV de la carpeta para crear el dataset inicial (bootstrap).
- Los guardados en `Editor CSV` se almacenan en base de datos.

## Seguridad de Carga

- Importacion en dos pasos: `preview` + `commit`.
- Modo explicito de importacion: `new`, `replace` o `merge`.
- Validacion previa de esquema (columnas requeridas), limites de filas/columnas y errores de estructura.
- Deteccion de duplicados por `content_hash` (SHA-256) del dataset.
- Staging transaccional en SQLite (`upload_staging`) con expiracion.
- Sanitizacion de celdas para reducir riesgo de formula injection en futuras exportaciones.
- Control de concurrencia optimista por `version` al guardar/restaurar.
- Historial de revisiones y restauracion (`dataset_revisions`).
- Snapshot automatico de la BD antes de operaciones destructivas en `backups/db_snapshots` (con retencion).

## Autenticacion y Roles

- Login obligatorio para acceder al sistema.
- Sesion con cookie `HttpOnly` y `SameSite=Lax`.
- Bloqueo temporal por intentos fallidos de login (15 min).
- Roles:
- `administrador`: acceso total (`Editor CSV`, `Consulta Mix`, `Dosificador`).
- `jefe-de-planta`: acceso total (`Editor CSV`, `Consulta Mix`, `Dosificador`).
- `dosificador`: acceso solo a `Dosificador`.
- `presupuestador`: acceso solo a `Consulta Mix`.
- Usuarios iniciales:
- `admin / Admin#2026!`
- `jefe_planta / Planta#2026!`
- `dosificador / Dosi#2026!`
- `presupuestador / Presu#2026!`
- Recomendado: cambiar credenciales iniciales en despliegue productivo.

## Funcionalidades

- Carga automatica del `.csv` de la carpeta principal.
- Tres vistas: `Editor CSV`, `Consulta Mix` y `Dosificador`.
- Metadato de `Familia` por dataset (detectado del nombre del archivo y editable manualmente).
- Tabla editable con todas las columnas.
- Seccion de `Control de Calidad de Agregados` en `Editor CSV` (PVS, PVC, densidad, absorcion, humedad).
- Columna automatica `FECHA_MODIF` por fila (se actualiza al editar).
- Alta de filas.
- Eliminacion de filas seleccionadas.
- Busqueda global por texto.
- Ordenamiento por columna (clic en encabezado).
- Edicion de nombres de columnas (incluye tipo entre parentesis).
- Selector para abrir otro CSV existente.
- Carga de un CSV nuevo desde la interfaz web.
- Deteccion de familia durante `upload preview` y confirmacion manual antes del `commit`.
- Eliminacion de dataset desde la interfaz (borrado logico en SQLite).
- Consulta con filtros (familia, f'c, edad, tipo, TMA, rev, complemento).
- Receta de componentes y estimacion de costos por m3 usando cantidades finales ajustadas por control de calidad.
- Dosificador con:
- Buscador de mezcla por familia/f'c/tipo/colocacion/TMA/rev/complemento.
- Datos de control de calidad por agregado (PVS, PVC, densidad, absorcion y humedad).
- Carga teorica por dosificacion (m3) y ajuste por humedad/absorcion en agregados.
- Carga real con diferencial y estatus por tolerancias (cemento/agregados/agua/aditivo).
- Guardado persistente en SQLite con historial interno de revisiones.
- Datos de control de calidad persistidos en SQLite por dataset (`qc_profiles`) y compartidos entre Editor/Consulta/Dosificador.
- Aviso si intentas salir con cambios sin guardar.
