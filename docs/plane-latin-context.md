# plane-latin: contexto del fork

Qué es este fork, qué se le ha construido encima de Plane, cómo funciona cada pieza y cómo se trabaja en él. Escrito para que una sesión nueva (otra cuenta, otro chat) retome el trabajo sin perder contexto. Para la arquitectura genérica de Plane (capas de paquetes, colores, estilos) ver `docs/plane-context.md`; para correr en local, `CORRER-EN-LOCAL.md` y `docs/contracts-local.md`.

Última actualización: 2026-10-28 (separar y unir PDFs con el asistente).

---

## 1. Qué es

Fork de [Plane](https://github.com/makeplane/plane) (gestión de proyectos open source) adaptado para **Latin Power Music**, una disquera y editora musical mexicana. Repositorio: `github.com/FilyBox/plane-latin`. Workspace de producción: `latin-power-music`. Los usuarios hablan español.

Sobre Plane se añadieron módulos propios, cada uno activable por workspace (`WorkspaceFeature`, en `apps/api/plane/db/models/file_library.py`; se encienden desde el panel de administración, "god mode"):

| Clave           | Módulo                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| `file_library`  | Biblioteca de archivos y **contratos** (analizados con IA y creados desde plantillas) |
| `payments`      | Presupuestos, gastos y nómina                                                         |
| `music_catalog` | Catálogo musical (canciones, lanzamientos, artistas, créditos, importación)           |
| `references`    | Menciones entre módulos, referencias y **etiquetas compartidas**                      |

El **asistente** (chat lateral con IA) está siempre disponible y usa lo que el workspace tenga activo.

---

## 2. Reglas de trabajo con el usuario

Vienen de instrucciones explícitas del usuario; se aplican siempre.

- **Commits sin atribución**: nunca agregar `Co-Authored-By`, "Generated with" ni ninguna mención a Claude en commits o PRs.
- **Commit y push solo cuando el usuario lo pide.** Suele pedirlo como "has commit y sube a preview": commit en `feat/universal-references` y push de esa rama **y** de `preview` (`git push origin feat/universal-references:preview`). Nunca `--no-verify`.
- **Push a `preview` despliega producción** (Railway construye desde `preview`). No hay entorno de staging.
- **Cero pérdida de datos**: contratos, tareas, páginas y proyectos de producción no se pueden perder. Migraciones solo aditivas (columnas/tablas nuevas, choices); nada de RunPython/RunSQL que modifique datos al desplegar; backfills como comandos manuales con `--dry-run`.
- **Nada automático sobre datos de producción al desplegar** (p. ej. inferir tipos de lanzamiento o agrupar álbumes se hace solo cuando un usuario lo aplica).
- **Las plantillas de contrato existentes no se deben romper.**
- **Preguntar antes de cambiar algo en producción** (variables de Railway, datos). El usuario despliega el worker de Cloudflare él mismo: `cd apps/workers/contracts-pipeline && pnpm run deploy`.
- **i18n solo en/es**: textos nuevos en `packages/i18n/src/locales/{en,es}/*.json` **y** en el espejo `packages/i18n/locales/{en,es}/*.json`; después `pnpm --filter @plane/i18n run generate:types`. No copiar inglés a los otros 17 idiomas.
- **Revisar la UI en Chrome**, no solo el código, cuando se trabaja en flujos de interfaz.
- **Comunicación**: en español, directo, resultado primero.
- Al terminar trabajo de web: `npx oxfmt <archivos>` y `npx oxlint --deny-warnings <archivos>` (el hook de pre-commit rechaza avisos), y `cd apps/web && npx tsc --noEmit -p tsconfig.json`.

---

## 3. Arquitectura y servicios

```
Navegador ──► Proxy Caddy (servicio "Plane" en Railway)
               ├─ /         → Web (React Router + Vite, apps/web)
               ├─ /api      → API (Django, apps/api)  ──► Postgres, Redis, RabbitMQ, S3
               ├─ /live     → Live (Hocuspocus, apps/live): edición colaborativa de páginas
               └─ /god-mode → Admin
API ──► Worker de Cloudflare (apps/workers/contracts-pipeline): IA, Workflows
Worker ──► API por /api/internal/* (secreto compartido)
API ──► Collabora (edición de Word, WOPI) y Documenso (firma), en otros repos
Celery (Worker y Beat Worker) ──► tareas en segundo plano (firma, zips, etiquetas, gastos)
```

- **apps/api** (Django): todos los módulos propios en `plane/app/views/{contract,music,references,assistant,finance,payroll,file_library}`, utilidades en `plane/utils/*` y tareas Celery en `plane/bgtasks/*`. Los endpoints `internal/...` los llama el worker de Cloudflare con `PLANE_INTERNAL_API_SECRET` (`app/permissions/internal.py`).
- **apps/web**: componentes propios en `core/components/{file-library,music-catalog,payments,references,assistant,entity-peek,panel-stack}`.
- **apps/workers/contracts-pipeline** (Cloudflare Workers + Workflows). Antes de tocarlo, cargar las skills `cloudflare` / `workers-best-practices` (ver `CLAUDE.md`).
  - Workflows: `ContractPipelineWorkflow` (análisis de contratos), `ContractQueryWorkflow` (preguntas sobre contratos), `TaggingWorkflow` (mapeo y combinación de etiquetas), `DeepReviewWorkflow` + `DeepReviewLaneWorkflow` (revisión profunda).
  - Rutas: `/trigger/extract`, `/trigger/query`, `/trigger/tagging`, `/trigger/deep-review`, `/assistant/chat`, `/contracts/agent`, `/music/ai-map`, `/chat`.
  - IA: **DeepSeek** (`deepseek-flash`) por defecto, con cadena de respaldo Gemini (`src/lib/ai.ts`). `generateStructuredJson(..., { thinking: false })` apaga el razonamiento de DeepSeek: sin eso, en listas largas el razonamiento consume todos los tokens y la respuesta llega vacía. Se usa en el mapeo de etiquetas.
  - OCR: AWS Textract.
- **apps/live** (Hocuspocus): servidor de edición colaborativa de páginas. Endpoint propio `POST /live/pages/replace-content` (protegido con `LIVE_SERVER_SECRET_KEY`) para que el asistente reescriba una página a través del documento vivo.
- **Repos hermanos** (se despliegan aparte): `../libreoffice` (imagen de Collabora) y `../CRM` (fork de Documenso).

### Producción (Railway)

Proyecto **`latin crm`** (`566daa78-0152-48a2-bb1e-447e8296d39a`), entorno `production`. Servicios: Plane (proxy Caddy, repo `FilyBox/plane-caddy-proxy`), Web, API, Live, Admin, Space, Worker, Beat Worker, Migrator, Postgres, Redis, RabbitMQ, Collabora, CRM (Documenso), Console.

- Web, API, Live, Admin, Space, Worker, Beat Worker y Migrator construyen desde la rama **`preview`**. El **Migrator** aplica las migraciones en cada despliegue.
- El servicio **Worker** (Celery) tiene una lista de variables más corta que API. Si una tarea Celery nueva lee variables (Documenso, `WEB_URL`, claves de IA…), hay que agregarlas al Worker (por referencia, `${{API.X}}`), con permiso del usuario.
- Variable `LIVE_INTERNAL_URL=http://live.railway.internal:80/live` en API, para que la API llame a Live por la red privada. Live escucha en el puerto 80.
- El worker de Cloudflare **no** se despliega con el push: lo despliega el usuario a mano.

---

## 4. Entorno local

Guías completas: `CORRER-EN-LOCAL.md` (desde cero) y `docs/contracts-local.md` (Collabora y Documenso en local). Lo que suele hacer falta:

- **Docker**: contenedores `plane-latin-api-1` (Django, código montado en `/code`, puerto 8000), `plane-latin-worker-1`, `plane-latin-plane-db-1` (Postgres, usuario/db `plane`), `plane-latin-plane-redis-1`, `plane-latin-plane-mq-1`, `plane-latin-qa-minio` (S3 local; tiene que estar arriba para subir archivos y ver PDFs).
- **Web**: `cd apps/web && node node_modules/@react-router/dev/bin.js dev --port 3100 --strictPort` → `http://localhost:3100`. Workspace de pruebas local: `test`.
- **Worker de Cloudflare**: `cd apps/workers/contracts-pipeline && pnpm exec wrangler dev --port 8787` (claves en `.dev.vars`).
- **Live**: `cd apps/live && pnpm exec tsdown && PORT=3103 API_BASE_URL=http://localhost:8000 node --env-file=.env dist/start.mjs` (el `.env` local trae valores pensados para Docker; las variables del comando los sobrescriben). Tarda unos segundos en responder y casi no imprime nada.
- **Pruebas de Django**: `docker exec plane-latin-api-1 sh -c "cd /code && python -m pytest <ruta> -q -p no:cacheprovider"`. Sin Docker (sesión en la nube): Postgres 16 con pgvector y un venv con `requirements/test.txt` (sin `psycopg-c`) bastan; unas 25 pruebas que necesitan Redis o RabbitMQ fallan sin ellos.
- **Pruebas del worker**: `cd apps/workers/contracts-pipeline && pnpm run check:types && pnpm test`.
- **Sin Collabora en local**: la conversión a PDF (`/cool/convert-to/pdf`) se puede imitar con un servidor HTTP mínimo que llame a `soffice --headless --convert-to pdf` y `COLLABORA_URL` apuntando a él. Sirve para probar plantillas y borradores; LibreOffice no abre los .docx mínimos de las pruebas, solo documentos completos (python-docx).

Trampas conocidas:

- **Recompilar `@plane/types`** (`pnpm --filter @plane/types run build`) rompe el Vite que está corriendo ("Failed to load url …/packages/types/dist/index.mjs") hasta que se reinicia. Cuando cambien los tipos, compilarlos una vez al final y reiniciar la web.
- **i18n en local**: Vite a veces sirve el JSON de traducciones viejo y las claves nuevas salen sin traducir. Reiniciar el servidor web. No correr el `build` de `@plane/i18n` solo por agregar claves (recrea la carpeta `locales/` y Vite pierde el seguimiento); basta con editar `src/locales` y el espejo, y correr `generate:types`.
- **Subidas a MinIO**: `apps/api/.env` usa `AWS_S3_ENDPOINT_URL=http://plane-minio:9000` (servidor) y `AWS_S3_PUBLIC_ENDPOINT_URL=http://localhost:9000` (navegador). Tras cambiar `.env`, recrear los contenedores (`up -d --force-recreate`); `restart` no recarga el archivo.
- **Filtros de tareas en dev**: el `StrictMode` desmonta una vez; ya está corregido en `work-item-filters/filters-hoc/base.tsx`.
- **Chrome DevTools (MCP)**: si la pestaña queda en segundo plano, las animaciones no avanzan y las capturas fallan. Traerla al frente (`select_page` con `bringToFront`) antes de medir tiempos.

---

## 5. Módulos

### 5.1 Biblioteca de archivos

`views/file_library`, `components/file-library`.

- Archivos del workspace con carpetas (modelo propio, no categorías), categorías, etiquetas y miniaturas.
- Vista previa de PDF, imagen y CSV; edición de Word en el navegador con Collabora (WOPI, `views/file_library/collabora.py`).
- Selección múltiple con barra de acciones y acciones masivas. Las descargas masivas las arma el backend en un zip en S3 (tarea Celery).
- Enlaces directos: `?preview=<id>` abre el visor (`&page=N` en una página del PDF) y `?folder=<id>` entra a una carpeta.
- Sin miniaturas de PDF: el paso placeholder del pipeline se quitó. `has_thumbnail` y el endpoint de miniatura siguen y responden "sin miniatura".

### 5.2 Contratos analizados con IA

`views/contract/*`, `utils/contract_*`, `components/file-library/contracts`, `workflows/contract-pipeline.ts`.

- **Acceso: solo admins del workspace.** Contratos analizados, plantillas, firma y sus PDF (`utils/contract_access.py`). Los miembros e invitados no ven el menú ni la ruta, la API les responde 403, la biblioteca les oculta los archivos de contratos y la categoría "Contratos", las menciones los muestran como restringidos y el asistente no les da herramientas de contratos (`capabilities.contracts`; `capabilities.library` sigue para miembros). `tests/unit/test_contract_access.py` recorre todas las rutas de contratos.
- **Pipeline**: al subir un contrato, la API lanza `ContractPipelineWorkflow`. Etapas: `extracting_text` → `waiting_ocr` (Textract) → `collecting_text` → `embedding` → `analyzing` → `saving` → `classifying` → `done`. Cada paso reporta progreso y costo; el panel muestra los pasos y permite reintentar etapas.
- **Análisis**: varios prompts (principal, secundario, artistas, obras). Cada campo trae la cita textual que lo respalda (`_evidence`) y se valida contra el texto.
- **Etiquetas automáticas**: el análisis crea etiquetas de artista, grupo y persona (`link_contract_tag` en `views/contract/internal.py`). Reusa la etiqueta existente aunque el nombre cambie en mayúsculas, espacios, acentos o puntuación (`tag_name_key`): "3ball Mty" reusa "3BallMTY".
- **Vistas**: analizados, vigentes, vencidos y editoriales (mover contratos a editoriales y sacarlos de ahí).
- **Búsqueda**: sin acentos y por palabra completa, con escaneo por proximidad y conteos.
- **Panel**: URL compartible, campos editables en el lugar y descarga.
- **Chat**: por contrato y general. Agente con herramientas en `src/contracts-agent.ts`.
- **Obras**: el contrato se liga a canciones y lanzamientos del catálogo. La IA sugiere las obras que el contrato nombra y la persona las aplica; las sugerencias se guardan.
- **Revisión profunda**: lee _todos_ los contratos contra una pregunta. Se lanza desde el asistente, muestra estimado de costo y progreso en vivo, y termina en una tabla exportable.

### 5.3 Contratos creados (plantillas y firma)

`views/contract/workflow.py`, `template_drafts.py`, `bgtasks/contract_signature_task.py`, `components/file-library/contracts/contract-*`.

- **Plantillas**: un .docx con variables `{{Nombre}}`, firmantes y campos de firma. Tienen variantes y versiones.
- **Edición del Word**: se edita en Collabora sobre un **borrador**; al cerrar se publica como versión, se guarda para después o se descarta.
- **Usar**: rellena las variables, genera el PDF y lo envía a firma en **Documenso**. El envío corre en segundo plano (Celery), y la finalización y la reconciliación llegan por webhook y tarea periódica.
- **Identidad**: hay un comprobante de identidad del firmante (INE).
- **Plan**: existe un plan de mejoras en 5 fases (errores y textos, borrador real, campos automáticos, envío robusto, seguridad WOPI). Los commits `cf87496de` y `d2b619a92` implementaron borradores, WOPI más seguro, firma en segundo plano, configuración de campos y seguimiento. No está verificado qué queda pendiente: revisar con el usuario antes de asumirlo.

### 5.4 Presupuestos, gastos y nómina

`views/finance`, `views/payroll`, `utils/budget*`, `utils/expense_recurrence.py`, `components/payments`, `src/expenses` (worker).

- **Presupuestos**: con líneas planeado vs. real, categorías y oficinas reales y selectores de catálogo.
- **Gastos**: con recurrencia y extracción con IA de comprobantes (worker de gastos, `bgtasks/expense_task.py`). Sus etiquetas se reflejan en `Expense.tags`.
- **Nómina**: empleados y salarios. No es referenciable ni mencionable, por decisión del usuario.

### 5.5 Catálogo musical

`views/music/*`, `utils/music_*`, `components/music-catalog`.

- **Datos**: `MusicTrack` (canciones y videos) y `MusicRelease`, unidos por `MusicReleaseTrack`. `MusicParty` (artistas y personas) se liga a canciones con `MusicCredit` y rol, y a lanzamientos con `MusicReleaseArtist`. Además `MusicCompany` (agregadora, distribuidora, sello, editora…), `MusicDistribution`, géneros, videos y enlaces.
- **Roles de crédito**: viven en una tabla, `MusicCreditRole` (key, label, category, source_tags). Los roles del archivo se conservan en inglés, como vienen ("Primary Artist", "Drums"…); no hay un enum fijo.
- **Importación** (CSV/XLSX, p. ej. el export de un distribuidor, `views/music/importer.py`):
  - Mapeo de columnas, con valores fijos para cualquier campo y sugerencias de valores existentes para no crear casi-duplicados.
  - Mapa de roles para etiquetas ambiguas y conservación de columnas sin mapear.
  - "Mapear con IA" con diferencias contra el mapeo del sistema y deshacer.
  - Duplicados en el archivo y en la base, progreso en streaming y validación previa (dry run).
  - Cada importación queda registrada y cada canción sabe de qué archivo y fila vino.
  - Infiere el tipo de los lanzamientos nuevos sin tipo: 1 canción = single, 2–6 = EP, 7 o más = álbum, o por el título ("Single…", "… EP").
  - **Liga los artistas de las canciones a la etiqueta existente con su nombre** (`link_artist_tags` en `utils/tagging_music.py`, vía `FileTag.party`). No crea etiquetas.
- **Lista**: estilo "contratos analizados", con salto a cualquier página y filtro por archivo de importación, contrato, etiquetas, ISRC/UPC del video, etc.
- **Edición masiva** (p. ej. poner la agregadora "Virgin"), **ligar a contrato** en masa y **exportación configurable** (columnas elegibles; créditos en formato `Nombre <Rol>`, como el CSV de origen).
- **Lanzamientos**:
  - Panel propio.
  - "Corregir tipo de lanzamientos": vista previa y aplicar; nunca corre solo.
  - Agrupar canciones en álbumes desde una lista o un PDF (vía asistente) y unir lanzamientos duplicados (`views/music/grouping.py`).

### 5.6 Referencias y etiquetas compartidas

`views/references/*`, `utils/shared_tags.py`, `utils/tagging*.py`, `utils/entities.py`, `utils/references.py`, `components/references`, `workflows/tagging.ts`.

- **Registro de entidades** (`utils/entities.py`, `REGISTRY`): define para cada tipo (contract, file, music_track, music_release, music_artist, issue, page, budget, expense…) quién puede verlo, cómo se busca y cómo se describe. Las menciones y las referencias pasan por ahí. Lo que alguien no puede abrir se muestra como "Elemento restringido".
- **Etiquetas compartidas**: una sola etiqueta para todos los módulos, construida sobre `FileTag`.
  - Tipos: ARTIST, GROUP, PERSON, TYPE, CUSTOM.
  - Se ligan con `FileTagLink` en archivos y contratos, y con `EntityTagLink` en lo demás.
  - Las canciones y lanzamientos de un artista cuentan como etiquetados con la etiqueta ligada a ese artista (`FileTag.party`), sin guardar filas.
  - En las tareas, el selector combina las etiquetas de Plane del proyecto con las del espacio de trabajo; las etiquetas de Plane no se convierten.
- **Nombres iguales**: `tag_name_key` compara solo letras y números, sin mayúsculas ni acentos. `find_or_create_tag` y `find_tag_by_name` reusan la etiqueta existente.
- **Vista de etiquetas** (`/tags`): búsqueda sin acentos, combinar varias etiquetas (todas o cualquiera) y exportar.
- **Mapear con IA** (`TaggingWorkflow`, modo `map`):
  - Un agente por tipo de elemento clasifica qué es y de quién es, y elige etiquetas existentes. Canciones y lanzamientos son opcionales.
  - Después une variantes de nombres: las que solo cambian en formato se juntan sin IA y la IA solo revisa los parecidos (`clusterNames` en `src/lib/tagging-batch.ts`).
  - Todo queda como propuesta: la persona revisa y aplica, y se puede deshacer.
  - Tolera respuestas cortadas o vacías del modelo: rescata las filas completas y reintenta en lotes más chicos.
- **Combinar con IA** (modo `merge`):
  - Busca etiquetas duplicadas en todo el workspace y propone fusiones, con el nombre final editable y la opción de dejar una etiqueta aparte.
  - Al aplicar, todo pasa a la etiqueta final una sola vez y las demás se eliminan (`merge_into` / `merge_tags`). Se puede deshacer desde el historial.
- **Automático al subir archivos**: las subidas nuevas pueden generar una corrida de etiquetado que queda "por revisar".

### 5.7 Asistente

`views/assistant/*`, `utils/assistant_*.py`, `utils/page_markdown.py`, `components/assistant`, `src/assistant.ts` (worker).

- **Chat** con assistant-ui (ver `CLAUDE.md`):
  - Conversaciones guardadas, adjuntos, elección de modelo, saldo y costo por respuesta.
  - Pasos visibles de lo que hace el agente.
  - "Preguntar a la IA" desde cada módulo.
- **Menciones**:
  - El usuario menciona con `@`.
  - El modelo escribe `:tipo[Nombre]{name=<id>}`, que se muestra como chip clicable (`mentions.tsx`).
  - Mientras una mención llega por streaming se ve como chip pendiente; el efecto de escritura corre antes de convertirla, así el texto no se reinicia.
- **Acciones con tarjeta**: el asistente nunca cambia nada directamente. Propone en una tarjeta, la persona revisa y aplica, y queda un registro con deshacer (`AssistantAction`). Hay una vista "Cambios del asistente".
  - Tipos: TAG_ITEMS, UNTAG_ITEMS, CREATE_WORK_ITEM, CREATE_PAGE, EDIT_PAGE, SPLIT_PDF, MERGE_PDF, EDIT_PDF_PAGES, y desde la migración 0165 CREATE_TEMPLATE_VARIANT, EDIT_TEMPLATE_VARIANT, CREATE_CONTRACT_DRAFT, EDIT_CONTRACT, EDIT_WORK_ITEMS, COMMENT_WORK_ITEM, ORGANIZE_FILES, CREATE_EXPENSES, CATALOG_FIXES.
  - **El estado de cada tarjeta vive en el servidor**: la acción guarda `tool_call_id` y `chat`; el chat pide `GET assistant/actions/?tool_call_ids=…` al abrirse (`outcome-store.ts`). Una tarjeta aplicada en otra pestaña sale aplicada, y aplicar dos veces devuelve la misma acción (candado por `tool_call_id`). El `sessionStorage` es solo caché.
  - Los tipos nuevos se registran en `utils/assistant_workspace.py` (`register_apply`) y su deshacer con `register_undo` (`utils/assistant_actions.py`). Un módulo nuevo se importa en `_load()`.
  - **Deshacer por campo** (`utils/assistant_undo.py`): se guarda antes/después de cada campo y deshacer solo regresa lo que sigue con el valor del asistente; lo demás queda como conflicto y la tarjeta lo lista ("se quedó: alguien lo cambió después").
  - Piezas comunes de la web: `card-kit.tsx` (aplicar y deshacer, lista de conflictos).
- **Herramientas del agente** (`src/assistant.ts`):
  - **Generales**: `ask_user`, `search_memory`, `propose_memory`, `search_workspace`, `get_references`, `read_file`.
  - **Tareas**: `propose_work_item`.
  - **Páginas**: `propose_page`, `read_page`, `propose_page_edit`, `propose_report`.
  - **Contratos**: herramientas de consulta, `find_contract_works`, `propose_work_links`, `get_track_contracts`, `propose_deep_review`, `read_deep_review`.
  - **Música**: `query_music_tracks`, `export_music_excel`, `list_music_files`, `read_import_file`, `plan_music_import`, `update_music_track`, `propose_album_grouping`.
  - **Etiquetas**: `find_tags`, `find_by_tag`, `propose_tagging`, `propose_tag_merge`, `start_tag_mapping`.
  - **PDFs** (`src/pdf-tools.ts`): `analyze_pdf_segments`, `propose_pdf_split`, `propose_pdf_merge`, `propose_pdf_pages`.
  - **Plantillas** (`src/template-tools.ts`): `find_contract_templates`, `read_contract_template`, `propose_template_edit`, `propose_contract_from_template`.
  - **Edición en el workspace** (`src/workspace-edit-tools.ts`): `propose_contract_edit`, `query_work_items`, `propose_work_item_update`, `propose_work_item_comment`.
  - **Gastos** (`src/expense-tools.ts`, solo administradores con Pagos): `propose_expenses_from_documents`.
  - **Biblioteca** (`src/library-tools.ts`): `list_folder`, `find_duplicate_files`, `propose_file_organization`.
  - **Catálogo** (`src/catalog-tools.ts`, administradores): `audit_catalog`, `propose_catalog_fixes`.
- **Separar y unir PDFs** (plan en `docs/pdf-split-merge.md`):
  - `analyze_pdf_segments` lee el PDF en lotes de 25 páginas con 2 de traslape: Django manda una versión liviana (`preview-pdf/`, JPEG en grises) y Gemini clasifica cada página con su texto. La reconciliación (`src/lib/pdf-segments.ts`) une los lotes y aplica reglas: "1 de N", anexos con su documento, adendum después de firmas.
  - Al aplicar, Django corta con PyMuPDF (`utils/pdf_ops.py`, `utils/assistant_pdf.py`). El original no cambia; los archivos nuevos van a una carpeta nueva dentro de la del original ("Separados de…", "Unidos – …", "Páginas de…", con número si ya existe) y se analizan como contratos (casilla activada por defecto).
  - Deshacer manda a la papelera los archivos y sus contratos (detiene análisis activos) y borra la carpeta si quedó vacía.
  - **Linaje** (`FileDerivation`, migración 0164): cada archivo nuevo apunta a su origen (tipo SPLIT, MERGE o PAGES, páginas y número de parte). El panel del contrato y el visor muestran "Separado de…" y "N archivos salieron de este", agrupados por carpeta (`components/file-library/file-lineage.tsx`, endpoint `file-library/files/<id>/lineage/`). El asistente lo ve como `origen` y `documentos_derivados` en `get_contract_details` y `read_file`.
  - Límites: 300 páginas y 80 MB por archivo, 20 archivos al unir, 50 partes al separar.
- **Editar páginas** (desde el commit `c7ed6d6c4`):
  - `read_page` convierte la página a Markdown (`utils/page_markdown.py`). Lo que el Markdown no puede representar (imágenes, listas de tareas, código, texto con color) viaja como marcador `[[bloque:<hash>]]` y vuelve intacto.
  - `propose_page_edit` propone reemplazos puntuales, añadir al final o reescribir.
  - Al aplicar (`edit_page` en `utils/assistant_actions.py`), la API llama a Live (`utils/assistant_pages.py`), que cambia el documento vivo: quien tenga la página abierta lo ve y nada se pisa.
  - Se niega si la página cambió desde que se leyó (huella del texto) y respeta los permisos de la página (privada, bloqueada, archivada). Sin Live configurado, reescribe el HTML guardado y vacía el binario colaborativo.
- **Memoria del workspace**: datos, reglas y glosario que el asistente usa en cada conversación. Los administradores aprueban; los demás sugieren.
- **Acciones sobre el workspace** (plan en `docs/assistant-workspace-actions.md`, implementado el 28 de octubre):
  - **Plantillas de contrato** (`utils/docx_edit.py`, `utils/assistant_templates.py`): el asistente lee el Word como párrafos numerados y propone operaciones de texto (reemplazar, insertar texto o párrafos, borrar un párrafo, renombrar un marcador). Django las aplica con lxml sobre las corridas del .docx cambiando el mínimo de caracteres, respeta campos, control de cambios, cuadros de texto (las dos copias), notas y encabezados, y `verify_preserved` comprueba que nada más cambió (entradas del ZIP sin tocar idénticas byte a byte, esqueleto XML igual). Guardar crea **una variante nueva** por defecto (`ContractTemplateVariant.origin`, "Generada por el asistente"); cambiar una variante existente solo si se pide, y entonces es una versión nueva. Un borrador de Word abierto lo bloquea. Vista previa en PDF desde la tarjeta. `{{Variable}}` con `case: "upper"` se escribe en mayúsculas si la plantilla las tenía.
  - **Contrato desde plantilla** (`utils/assistant_contract_drafts.py`): valores con su origen y firmantes por rol; "Crear borrador" deja la solicitud lista (READY) y abre la pantalla de envío. **El asistente nunca envía.** La lógica del POST de solicitudes de firma vive en `create_signature_request()` (`views/contract/workflow.py`), que usan el diálogo "Usar" y la acción. Cambios al texto solo para ese contrato crean primero una variante nueva.
  - **Datos de contratos** (`utils/assistant_contract_edits.py`): mismo camino que el panel (serializer parcial, fin efectivo, estatus, etiquetas). Cada campo corregido queda en `evidence[campo]` con `manual: true`, cita, página, quién y cuándo; el panel muestra "corregido a mano" y un reanálisis lo marca y lo deja sin seleccionar.
  - **Tareas** (`utils/assistant_work_items.py`): consulta con filtros y visibilidad de quien pide; cambios por el camino del PATCH de Plane (serializer más `issue_activity` con la instancia actual, así el historial y las notificaciones son iguales que a mano); nombres resueltos en Django con selector si son ambiguos; comentarios con menciones. Permiso: miembro del proyecto.
  - **Gastos desde comprobantes** (`utils/cfdi.py`, `utils/assistant_expenses.py`): un CFDI 3.3/4.0 se lee con lxml seguro (sin entidades, DTD ni red, tope 2 MB) y queda listo al instante con montos exactos; fotos (incluye HEIC, que se lee con Gemini) y PDF van al análisis existente. PDF y XML de la misma factura se emparejan (UUID impreso, nombre de archivo o total y fecha) y se vuelven un solo gasto con los dos documentos. `Expense.cfdi_uuid`: un UUID repetido es duplicado seguro. El importador de la web también lee CFDI.
  - **Biblioteca** (`utils/assistant_files.py`): listar carpetas por ruta, duplicados exactos (hash calculado al pedirlo para archivos viejos, como dato nuevo) y posibles (nombre y tamaño), y una tarjeta con renombrar, mover (crea la ruta), categorizar, etiquetar y papelera (se confirma aparte). La papelera nunca toma contratos analizados, comprobantes de gastos ni archivos de plantillas. Deshacer regresa todo y borra las carpetas creadas si quedaron vacías.
  - **Auditoría del catálogo** (`utils/assistant_catalog.py`): 8 revisiones deterministas (canciones sin contrato o solo con vencidos, editoriales sin obras, ISRC/UPC, créditos, porcentajes, contrato vs. artista acreditado, etiquetas, huecos). Las correcciones (`CATALOG_FIXES`) llevan su origen; un ISRC faltante se reporta y solo se llena si el usuario da el código. `update_music_track` pasó a esta misma acción, con deshacer.
- **Lo que todavía no edita**: memoria (corregir o retirar), etiquetas (renombrar, borrar, tipo), lanzamientos completos y créditos, presupuestos. ZIP de facturas del SAT y hojas de cálculo de gastos quedaron para después. Ver `docs/assistant-edit-proposals.md`.

### 5.8 Paneles laterales

`components/panel-stack/*`, `components/entity-peek/*`.

- **Apilado**: los paneles abiertos desde otro panel se apilan, al estilo de los drawers anidados de Base UI. El de abajo retrocede y deja una franja visible.
  - Store a nivel de módulo, `usePanelLayer` y `<StackLayer>`, que aporta animación, `inert` en las capas de abajo, fondo oscurecido sobre toda el área y la sombra común `PANEL_SHADOW`.
- **Esc**: `usePanelEscape` es la regla única para todos los paneles. Cierra solo el de arriba. Un menú, lista, popover o modal abierto se lleva el Esc primero. En un campo de texto, el primer Esc sale del campo.
- **Abrir en cualquier lugar**: contrato, canción, lanzamiento y gasto se abren desde cualquier página con `?open=<tipo>:<id>` (se pueden apilar varios). `entity-peek/open-store.ts` escribe esa URL con la History API y no con el router, para que la página de fondo no se vuelva a dibujar; desde la vista de tareas eso bajó la apertura de ~5 s a ~150 ms. Atrás y Adelante siguen funcionando.
- Las páginas con panel propio (contratos `?peek=`, música `?track=` / `?release=`) siguen usando el router.

### 5.9 Exportación de páginas

`apps/web/core/hooks/use-parse-editor-content.ts`.

- El PDF y el Markdown de una página resuelven el nombre de cada mención en una sola consulta.
- Personas: su nombre. Canciones, contratos y demás: su título. Lo borrado o sin acceso: el tipo ("@Canción").

---

## 6. Cosas abiertas o por confirmar

- **"Connection lost" en páginas** (producción, 2026-10-27): apareció y luego dejó de pasar tras un redespliegue de Live, sin cambios en su código. Lo observado:
  - Cuando el editor da el websocket por perdido, no reintenta hasta que la pestaña vuelve a tener foco.
  - Su mecanismo de respaldo (`use-page-fallback.ts`) hizo 8 guardados en un segundo.
  - Si vuelve a pasar, pedir la consola del navegador.
- **Pendientes de producción sin confirmar** (vienen de sesiones anteriores; verificar con el usuario): `extra_params` de Collabora en Railway, webhook `RECIPIENT_EXPIRED` en el seed de Documenso (`../CRM`), reiniciar el Beat Worker, flag `references` del workspace `latin-power-music`.
- **Plan de plantillas de contrato**: ver 5.3; confirmar qué fases faltan.
- **Ideas que el usuario pidió considerar**: lo que sigue de `docs/assistant-edit-proposals.md` (memoria, etiquetas, lanzamientos) y, de gastos, ZIP de facturas y hojas de cálculo.

---

## 7. Historial (151 commits propios, 2026-07-06 → 2026-10-27)

- **Julio**:
  - Despliegue en Railway (Docker, subidas presignadas detrás del proxy).
  - Módulo de archivos con carpetas, vistas y acciones masivas.
  - Primer pipeline de contratos en Cloudflare (Textract + IA) y chat de contratos.
  - Etiquetas en contratos.
  - Módulo de pagos y presupuestos con nómina.
  - Borrador del catálogo musical y su separación de archivos.
  - Primer asistente que importa música; AI SDK v7.
- **Agosto**:
  - Creación y edición de contratos desde plantillas, con Word en Collabora y visor de PDF.
  - Evidencia de identidad del firmante.
  - Ajustes de memoria de Celery.
- **Septiembre**:
  - Agente de contratos con herramientas y streaming.
  - Presupuestos y gastos rediseñados, con IA para gastos.
  - Categorías y oficinas reales.
  - URLs compartibles del panel de contratos.
- **20–23 de octubre**:
  - Vistas vigentes, vencidos y editoriales.
  - Importación de música a página completa con streaming.
  - Planeado vs. real en presupuestos.
  - Etiquetas compartidas entre módulos y referencias.
  - Asistente rediseñado: menciones, memoria, acciones con deshacer, archivos, páginas y reportes.
- **24–25 de octubre**:
  - Búsqueda de contratos sin acentos.
  - Saldo y costo del asistente.
  - Revisión profunda de todos los contratos.
  - Paneles abribles desde cualquier lugar y apilados.
  - Extracción de contratos validada, con pasos y costo.
  - Borradores de Word, WOPI más seguro y firma en segundo plano.
  - Contratos ligados a canciones.
  - Roles de crédito propios del archivo y valores fijos en la importación.
- **26 de octubre**:
  - Edición masiva y exportación configurable en música; salto de página.
  - Agrupar y unir álbumes, tipos de lanzamiento.
  - Canciones en el mapeo de etiquetas; filtros de etiquetas combinadas.
  - Mapeo con IA tolerante a respuestas cortadas.
- **27 de octubre**:
  - Combinar etiquetas con IA, nombres sin acentos y mapeo más rápido (razonamiento apagado).
  - Sombra común y Esc unificado en los paneles.
  - Paneles instantáneos sobre tareas.
  - Menciones con nombre en exportaciones.
  - Streaming del asistente sin saltos.
  - El asistente edita páginas existentes a través de Live.
- **28 de octubre**:
  - Separar, unir y editar páginas de PDFs con el asistente (detección de documentos con visión).
  - Limpieza de las miniaturas que nunca se generaron.
  - Relación padre–hijo entre el PDF original y lo que sale de él (linaje).
  - El asistente edita en el workspace: plantillas de contrato (variante nueva o versión), borradores de contrato, datos de contratos, tareas y comentarios, gastos desde comprobantes (CFDI), orden de la biblioteca y auditoría del catálogo; tarjetas con estado en el servidor y deshacer por campo.

Para el detalle: `git log --author=FilyBox --format='%h %ad %s' --date=short`.
