# Plan: separar y unir PDFs con el asistente

Estado (2026-10-28): **fases 1 y 2 implementadas**; la 3 (robustez) y la 4 (evaluación con datos reales) quedan pendientes. Falta la revisión en Chrome con un paquete real (ver "Verificación"). Contexto general del fork en `docs/plane-latin-context.md`.

Dónde quedó cada pieza:

- Django: `plane/utils/pdf_ops.py` (cortes y límites), `plane/utils/assistant_pdf.py` (acciones, carpeta nueva, análisis como contratos, deshacer), endpoints internos `pages/` y `preview-pdf/` en `views/assistant/files.py`, migración `0163_assistant_action_pdf`.
- Worker: `src/pdf-tools.ts` (las cuatro herramientas y el prompt de visión), `src/lib/pdf-segments.ts` (lotes, traslape, reglas, validación de rangos), `src/lib/vision.ts`.
- Web: `components/assistant/pdf-cards.tsx`; la biblioteca abre `?folder=<id>` y `?preview=<id>&page=N`.
- Linaje (después del plan original): `FileDerivation` liga cada archivo nuevo con su origen; se ve en el panel del contrato y en el visor (`file-lineage.tsx`).
- Pruebas: `tests/unit/test_assistant_pdf.py`, `plane/tests/unit/utils/test_pdf_ops.py`, `test/pdf-segments.test.ts`.

## Objetivo

Pedirle al asistente operaciones sobre PDFs de la biblioteca, incluidos los escaneados:

- **Separar** un PDF que trae varios contratos y adendums en archivos individuales, encontrando dónde empieza cada documento.
- **Unir** varios archivos en uno, en el orden indicado.
- **Extraer, quitar o reordenar páginas**, generando un archivo nuevo.

Reglas (las mismas del resto del asistente):

- El asistente propone; la persona revisa y aplica en una tarjeta.
- Nada se escribe antes de confirmar, y todo se puede deshacer.
- El original nunca se modifica: siempre se crean archivos nuevos.

## Decisiones del usuario

1. **El original se queda igual.** No se mueve ni se borra después de separar o unir.
2. **Los archivos nuevos van a otra carpeta.**
   - Se crea una subcarpeta dentro de la carpeta del original:
     - al separar: "Separados de <nombre del original>";
     - al unir o editar páginas: "Unidos – <nombre final>" o "Páginas de <nombre del original>".
   - El nombre de la carpeta se puede editar en la tarjeta.
   - Si ya existe una carpeta con ese nombre, se le agrega un número; nunca se mezcla con otra.
3. **Los archivos nuevos se analizan automáticamente como contratos** (`ensure_contract_for_asset`).
   - La casilla de la tarjeta viene activada siempre y permite apagarlo en un caso puntual.
   - Cada análisis cuesta su procesamiento (OCR y modelo).
4. **Proveedor de visión: Gemini 3.1 Flash-Lite**, el que ya está configurado.
5. **Sin miniaturas de páginas.** La tarjeta muestra rangos, texto y evidencia, más un enlace para abrir el PDF en esa página. El paso placeholder de miniaturas se quita del worker (ver "Limpieza: miniaturas").

## Conclusiones de la investigación

- **Sí es factible.** La parte difícil no es cortar (eso es determinista y rápido) sino **decidir dónde cortar**.
- **Lo que el modelo ve.** Un modelo con visión que mira las páginas, más el texto OCR que ya tenemos (Textract), da mejores resultados que cualquiera de los dos por separado.
  - La imagen muestra portadas, bloques de firma, sellos, encabezados y numeración que reinicia.
  - El texto aporta "CONTRATO DE…", "ADENDUM", "ANEXO", nombres de partes y "1 de 5".
- **El sistema importa más que el modelo.** En el benchmark de Extend sobre paquetes de más de 100 páginas, los modelos usados solos encuentran la mitad de los documentos o menos (F1 entre 37 y 46 %). Fallan sobre todo por:
  - anexos absorbidos por el documento anterior;
  - documentos idénticos seguidos que se pegan;
  - contexto perdido en los bordes de cada lote.

  Lo que funciona: clasificar cada página, reconciliar en código con reglas y que una persona revise.

- **Productos que ya lo hacen:**
  - Google Document AI Splitter: unos $5 por cada 1000 páginas. Es la mejor opción si hubiera que comprar.
  - Azure Document Intelligence con `splitMode`.
  - El splitter de Bedrock Data Automation (máximo 20 páginas por documento: no sirve para contratos largos).
  - Extend `/split`, LlamaSplit y Reducto.
  - El modelo abierto `doc-split-v1` (Apache-2.0, ONNX en CPU), que marca qué páginas inician un documento nuevo.

  Para nuestro volumen conviene construirlo: cuesta centavos y se integra con la revisión y el deshacer que ya existen.

- **Modelo:** **Gemini 3.1 Flash-Lite** (decisión 4). Ya está en `GEMINI_MODEL_FALLBACK_LIST` y lo usa `read_file` para escaneos.
  - Acepta PDF directo: hasta 1000 páginas o 50 MB, unos 258 tokens por página.
  - Cuesta unos **$0.01–0.03 por cada 100 páginas**.
  - Para una segunda opinión en cortes dudosos (fase 3): Gemini 3.8 Flash o Claude Sonnet 5.5. El precio de Gemini Flash sube el 1 de enero de 2027.
- **Dónde se corta:** en **Django con PyMuPDF**.
  - Ya está instalado (`PyMuPDF==1.26.4`) y funciona en la imagen Alpine.
  - Convierte páginas a imagen y es el más rápido para unir.
  - Su licencia AGPL encaja con el repo.

  El worker de Cloudflare no sirve para el trabajo con bytes:
  - 128 MB de memoria, y un escaneo pesa entre 0.3 y 1 MB por página.
  - Sin canvas, no puede convertir páginas a imagen.
  - No tiene ninguna librería de PDF instalada.

- **Arquitectura:** coincide con la idea del usuario.
  - El **orquestador** es el modelo actual del asistente (DeepSeek, sin visión). Conversa, decide qué herramienta usar y arma la propuesta.
  - Un **clasificador con visión** (Gemini) devuelve JSON estructurado por página.
  - Las **herramientas deterministas** en Django hacen los cortes.

## Lo que ya existe y se reutiliza

| Pieza                                              | Dónde                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subir bytes a S3 y crear el `FileAsset`            | `_create_asset` y `_delete_uploaded` en `views/contract/workflow.py`. Usan el bucket de contratos; hace falta una versión para la biblioteca con `S3Storage()` y `folder`. |
| Convertir páginas a imagen (base de `preview_pdf`) | `ContractAssetThumbnailEndpoint` (`workflow.py` ~L1196): `page.get_pixmap(...)`                                                                                            |
| Crear carpetas de la biblioteca                    | El modelo y los endpoints de carpetas de `views/file_library/`                                                                                                             |
| Texto por página                                   | `Contract.extracted_text` con marcadores `[[p. N]]` (contratos analizados); `splitPages()` en `src/lib/contract-analysis.ts`                                               |
| Visión                                             | `visionModel(env)` en `src/assistant.ts` (Gemini, primera entrada de `GEMINI_MODEL_FALLBACK_LIST`)                                                                         |
| Analizar un PDF nuevo como contrato                | `ensure_contract_for_asset(asset, user)` en `views/contract/base.py` (así funcionan ya los PDF firmados)                                                                   |
| Tarjeta, acción y deshacer                         | `AssistantAction`, `utils/assistant_actions.py`, `views/assistant/actions.py`, `action-cards.tsx` (`useOutcome`, `Footer`)                                                 |
| Trabajo largo con progreso                         | `ExporterHistory` más tarea Celery más polling en la web (zip de la biblioteca)                                                                                            |

Huecos detectados:

- No se guarda el número de páginas.
- `read_file` lee siempre del bucket por defecto y falla con archivos del bucket de contratos. Debería usar `S3Storage.for_asset`.

Que los archivos de la biblioteca que no son contratos no tengan texto guardado es intencional: solo se extrae texto de los contratos. Para separar un PDF que no es contrato, `pages/` usa el texto digital de PyMuPDF si lo hay, y si no, la detección se apoya solo en visión.

## Diseño

### 1. Operaciones de PDF en Django (`plane/utils/pdf_ops.py`)

Funciones puras sobre bytes, probadas con PDFs generados con fitz:

- `page_count(data)`.
- `preview_pdf(data, start, end, width=800)`: un PDF liviano con cada página convertida a JPEG en escala de grises de ~800 px.
  - Cien páginas escaneadas quedan en unos 3–5 MB.
  - Es lo que se manda al modelo con visión: cabe en la memoria del worker y en una llamada a Gemini.
- `split(data, ranges)`, `merge(datas)` y `select(data, pages)`, que extrae, quita o reordena. Usan `Document.insert_pdf` y `select`.

Límites, definidos en un solo lugar:

- Hasta 300 páginas y 80 MB por archivo de entrada.
- Hasta 20 archivos al unir.
- Hasta 50 segmentos al separar.

### 2. Endpoints de Django

- **Internos** (para el worker, con el mismo usuario y los mismos permisos que `read_file`):
  - `GET internal/.../assistant/files/<id>/pages/` devuelve:
    - `page_count`;
    - el texto por página: sale de `extracted_text` si es un contrato analizado, de `page.get_text()` si es un PDF digital, o va vacío;
    - si hace falta visión;
    - el nombre, la carpeta y si es contrato.
  - `GET internal/.../assistant/files/<id>/preview-pdf/?from=&to=`: el PDF liviano de un rango de páginas.
- **Acciones nuevas** de `AssistantAction`: `SPLIT_PDF`, `MERGE_PDF` y `EDIT_PDF_PAGES`. Requieren una migración que solo agrega opciones a la lista, como la 0162.
- **Al aplicar:**
  1. Se verifica que el usuario pueda ver los archivos de origen (`REGISTRY` de archivos; los de música solo los ven administradores).
  2. Se crea la subcarpeta de destino (decisión 2) dentro de la carpeta del original, en el mismo bucket (`S3Storage.for_asset`).
  3. Se crean los archivos nuevos ahí, con los nombres editados en la tarjeta.
  4. Si la casilla está activada (por defecto sí), se analiza cada archivo como contrato con `ensure_contract_for_asset`.
  5. El `result` guarda los ids de los archivos, de los contratos y de la carpeta creada.
- **Deshacer:**
  - Manda a la papelera (`is_deleted`) los archivos creados y sus contratos.
  - Borra la carpeta creada si quedó vacía. Si alguien le agregó otros archivos, la deja.
  - El original nunca se tocó.
- **Dónde corre:** dentro de los límites del paso 1, en la misma petición. PyMuPDF corta cien páginas en milisegundos; el costo real es bajar y subir de S3. Si hace falta más (fase 3), pasa a Celery con el patrón de `ExporterHistory`.
- **Pendientes de paso:** usar `S3Storage.for_asset` en `read_file` y guardar `page_count` en `attributes` al analizar o leer un PDF.

### 3. Herramientas del asistente (worker, `src/assistant.ts`)

- **`analyze_pdf_segments(file_id, instrucciones?)`**: solo lectura, como `read_file`.
  1. Pide `pages/` a Django.
  2. Va por lotes de 25 páginas con 2 de traslape. De cada lote baja el `preview-pdf` y lo manda a Gemini junto con un recorte del texto de cada página (las primeras y últimas ~15 líneas).
  3. El modelo responde por página, con salida JSON estricta:
     `{page, starts_new_doc, doc_type (CONTRATO | ADENDUM | ANEXO | IDENTIFICACION | OTRO), title, parties, page_label ("1 de 5"), has_signature_block, confidence, evidence}`.
  4. **La reconciliación se hace en código puro** (`src/lib/pdf-segments.ts`, con pruebas unitarias, como `tagging-batch.ts`):
     - unir los lotes;
     - resolver el traslape;
     - aplicar reglas: las páginas después de un bloque de firma siguen al documento si son su anexo; un adendum firmado aparte es su propio documento; "1 de N" ancla los rangos;
     - producir segmentos `{start_page, end_page, doc_type, title, confidence, evidence}`.
  5. Las instrucciones del usuario ("cada adendum por separado", "deja los anexos con su contrato") van en el prompt como reglas, al estilo de los `splitRules` de Extend.
- **`propose_pdf_split(file_id, segments[], folder_name?)`**: valida los rangos (sin huecos ni encimados, dentro del total) y devuelve la propuesta para la tarjeta. Se usa después de `analyze_pdf_segments`, o directo cuando el usuario dicta los rangos ("separa 1–5, 6–8 y 9–20").
- **`propose_pdf_merge(file_ids[], name, folder_name?)`**: resuelve los archivos por id, mención o búsqueda.
- **`propose_pdf_pages(file_id, operation, pages[], name, folder_name?)`**: extraer, quitar o reordenar.
- **Reglas del prompt:**
  - Para separar, primero `analyze_pdf_segments` y después `propose_pdf_split`.
  - Nunca decir que ya quedó hecho.
  - Si la confianza de algún corte es baja, mencionarlo en una frase.
  - Los archivos nuevos quedan en una carpeta nueva y se analizan como contratos; decirlo al proponer.

Buenas prácticas de Workers que aplican (skill `workers-best-practices`):

- Revisar `content-length` antes de leer un PDF y rechazar lo que pase el límite. Todo cuerpo se lee con tope (128 MB de memoria).
- Cada lote se espera antes del siguiente, para respetar los límites del proveedor. Toda promesa se espera.
- Los logs JSON estructurados ya están habilitados (`observability`).
- Sin bindings nuevos y sin `nodejs_compat`.
- Los secretos siguen en `wrangler secret`; el modelo sale de una variable de entorno.
- Si se mueve a un Workflow (fase 3), cada paso devuelve como máximo 1 MiB: se devuelven solo los segmentos, sin imágenes. La CPU llega hasta 30 s por paso.

### 4. Tarjetas en la web (`components/assistant/pdf-cards.tsx`)

Sin miniaturas: cada página se identifica por número, texto y un enlace "Ver" que abre el PDF original en esa página (`#page=N` en la URL del visor).

- **Separar**: una fila por segmento, con:
  - rango editable (inicio y fin), título editable y tipo;
  - la primera línea de texto del segmento, si hay texto;
  - insignia de confianza y la evidencia ("Encabezado: ADENDUM 2…");
  - botones para mover un corte a la página anterior o siguiente, unir con el siguiente y partir en dos.

  Debajo de las filas:
  - el nombre editable de la carpeta de destino;
  - la casilla "Analizar como contratos", activada;
  - Aplicar, Descartar y Deshacer.

- **Unir**: lista ordenable de archivos con su número de páginas, el nombre final y la carpeta de destino.
- **Páginas**: campo de páginas ("1-3, 7, 9-12") con vista previa del resultado como lista de números, y la carpeta de destino.
- Registro en `chat.tsx`, tipos en `assistant.service.ts`, íconos en `actions-view.tsx` y pasos en `steps.tsx`.
- i18n en/es en `src/locales` y su espejo.

### 5. Limpieza: miniaturas

Las miniaturas de la biblioteca nunca se generaron: el paso del worker es un placeholder que no hace nada. Se quitan en la fase 1.

- **Worker:**
  - El paso `thumbnail placeholder` y la opción `extract_thumbnail` de `src/workflows/contract-pipeline.ts`.
  - `createThumbnailUpload` y `confirmThumbnail` de `src/lib/internal-api.ts`.
- **Django:**
  - `InternalContractThumbnailEndpoint` y su URL.
  - `"extract_thumbnail"` de `RETRY_OPTION_KEYS`. Los trabajos viejos que lo tengan guardado lo ignoran sin fallar.
  - Su clave en `tests/unit/utils/test_contract_classification.py`.
- **Web:**
  - La opción `extract_thumbnail` de `contracts/constants.ts` y su texto i18n en/es.
  - La rama `has_thumbnail` del zip en `file-library/root.tsx`, que hoy nunca se cumple.
- **Se queda:**
  - La columna `Contract.thumbnail_asset`: las migraciones solo agregan, nunca borran.
  - El campo `has_thumbnail` del serializer y `FileLibraryAssetThumbnailEndpoint`, que siempre responden "sin miniatura". Se pueden quitar después, junto con la web.
  - Las miniaturas de plantillas (`ContractAssetThumbnailEndpoint`), que sí se generan al vuelo y se usan en el detalle de plantillas.

## Fases

1. **Base y operaciones manuales**:
   - `pdf_ops.py`;
   - los endpoints de páginas y preview;
   - las acciones `SPLIT_PDF`, `MERGE_PDF` y `EDIT_PDF_PAGES`, con la carpeta nueva, el análisis como contratos y el deshacer;
   - las herramientas `propose_pdf_split`, `propose_pdf_merge` y `propose_pdf_pages` con rangos dictados por el usuario;
   - las tarjetas;
   - el arreglo del bucket en `read_file` y `page_count`;
   - la limpieza de miniaturas.

   Esta fase ya da valor: "une estos 3", "separa 1–5 y 6–12".

2. **Detección con visión**:
   - `analyze_pdf_segments`, con lotes, traslape y reconciliación probada;
   - confianza, evidencia y ajuste de cortes en la tarjeta;
   - las reglas del usuario en el prompt.
3. **Robustez**:
   - segunda pasada con un modelo más fuerte, solo en los cortes de baja confianza;
   - Workflow de Cloudflare para PDFs de más de ~150 páginas, con progreso en la tarjeta como la revisión profunda;
   - Celery si el corte supera los límites de la misma petición;
   - reutilizar el texto OCR del original (marcadores `[[p. N]]`) para los archivos separados, de modo que su análisis como contrato se salte el OCR y cueste menos;
   - opcional: `doc-split-v1` como verificación cruzada. Antes hay que comprobar si onnxruntime tiene wheels para Alpine (musl).
4. **Evaluación con datos reales**: 10–20 paquetes reales de la disquera con sus cortes correctos.
   - Medir precisión y recall de inicios de documento, y el porcentaje de PDFs separados perfectamente.
   - Comparar solo texto, solo visión y texto más visión.
   - Ajustar reglas y prompt con esos números, no con los benchmarks en inglés.

## Verificación

- **Django:** pruebas de:
  - `pdf_ops`: separar, unir, extraer y reordenar con PDFs generados, y los límites;
  - las acciones: permisos, la subcarpeta creada con nombre único, el análisis como contrato, el deshacer (archivos, contratos y carpeta vacía) y los rangos inválidos;
  - los endpoints de páginas;
  - los trabajos viejos con `extract_thumbnail` guardado.
- **Worker:** pruebas unitarias de la reconciliación (traslape, reglas de firma y anexo, "1 de N", huecos) y de la validación de rangos. Más `pnpm run check:types` y `pnpm test`.
- **Chrome**, con un PDF de prueba que junte 3 contratos escaneados y 2 adendums:
  1. pedir "sepáralo";
  2. revisar los cortes propuestos, ajustar uno y abrir "Ver" en una página;
  3. aplicar y ver la carpeta "Separados de…" con los archivos nuevos analizándose como contratos, y el original intacto;
  4. deshacer;
  5. unir 3 archivos y comprobar el orden y la carpeta.
- **Costo:** registrar los tokens por llamada en el uso del asistente. Objetivo: menos de $0.05 por cada 100 páginas, sin contar el análisis como contrato.
