# Plan: nuevas acciones del asistente en el workspace

Estado: implementado (2026-10-28), fases 0 a 5. Diferencias con lo escrito aquí:

- La tarjeta de gastos sigue el análisis con un endpoint propio (`assistant/expense-drafts/`), porque los pares PDF + XML se calculan en Django; el importador sigue con el suyo.
- Las fotos HEIC no las abre el OCR: el worker de gastos las lee con un modelo de visión (Gemini).
- La vista previa del contrato con valores usa `contract-templates/variants/<id>/assistant-contract-preview/` (no guarda nada).
- Poner un PDF en "Contratos" desde `ORGANIZE_FILES` inicia su análisis; deshacer quita la categoría pero el análisis ya iniciado se queda.
- Un ISRC que falta se llena solo si el usuario dio el código (`source_type: "user"`), como ya permitía `update_music_track`.

Estado original: propuesta (2026-10-28). Contexto general del fork en `docs/plane-latin-context.md`. Retoma y concreta los puntos 2, 3, 5 y 8 de `docs/assistant-edit-proposals.md` y suma el trabajo con plantillas.

Alcance, en el orden en que lo pidió el usuario:

1. **Plantillas de contrato:** entender el formato `{{}}`, editar el Word (variables, campos de firma, texto) y crear contratos desde una plantilla.
2. **Corregir los datos extraídos** de un contrato.
3. **Editar tareas**: campos, en lote, y comentarios.
4. **Ordenar la biblioteca**: renombrar, mover, carpetas, duplicados.
5. **Registrar gastos desde comprobantes**: foto, PDF, XML (CFDI) y más.
6. **Auditoría del catálogo musical.**

## Reglas comunes

Valen para todo lo de este plan. Las secciones solo dicen lo que cambia.

- **Tarjeta:** el asistente propone y la persona revisa, ajusta y aplica. Nada se escribe antes de aplicar.
- **Deshacer:** cada aplicación deja un `AssistantAction` con el "antes" guardado. El deshacer se niega, campo por campo, si alguien cambió el dato después; la tarjeta dice cuáles no se pudieron revertir.
- **Permisos de quien pide:** las herramientas solo aparecen si el rol alcanza. Los invitados solo leen; los gastos son solo para administradores, como el módulo.
- **El contenido es información:** el texto de documentos, contratos y comprobantes nunca se toma como instrucciones (regla que ya está en el prompt).
- **Datos con origen:** el asistente no inventa valores. Cada valor propuesto dice de dónde salió (la conversación, una etiqueta, otro contrato, el documento, el XML), y la tarjeta lo muestra.
- **Migraciones:** solo agregan (opciones de lista, columnas nuevas que aceptan vacío). Ningún despliegue cambia datos existentes.
- **i18n:** en/es, en `src/locales` y su espejo.

## Fase 0: base compartida

Antes de sumar acciones que tocan plantillas, gastos y archivos, hay que cerrar un hueco que ya existe: el resultado de cada tarjeta vive en el `sessionStorage` del navegador. En otra pestaña, una tarjeta aplicada aparece pendiente y se puede aplicar dos veces.

- `AssistantAction` gana `tool_call_id` y `chat_id`, que aceptan vacío. Una restricción única (workspace, tool_call_id) impide aplicar dos veces la misma tarjeta; un segundo intento devuelve la acción existente.
- `useOutcome` pregunta al servidor por el resultado de su `toolCallId` (una sola petición por chat, con todos los ids) y usa el `sessionStorage` solo como caché.
- Un helper común para el "antes/después" por campo y el deshacer con detección de conflictos (`plane/utils/assistant_undo.py`). Lo usan las secciones 2, 3, 4 y 6.

## 1. Plantillas de contrato

### 1.1 Lo que el asistente debe saber del formato

El Word de una variante lleva marcadores `{{Clave}}`. Al usar la plantilla, `plane/integrations/contract_docx.py` los clasifica por su nombre y los reemplaza. Esto va al prompt como referencia fija y a la descripción de las herramientas:

| Marcador                                                                                                                                                                                           | Qué es                                          | Qué pasa al usar la plantilla                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{NombreArtista}}`, `{{Regalias}}`, `{{Territorio}}`…                                                                                                                                             | **Variable** de texto                           | Se reemplaza por el valor que se llena al usar la plantilla                                                                                                |
| `{{FechaInicio}}`, `{{FechaContrato}}` (empieza con "Fecha")                                                                                                                                       | Variable de **fecha**                           | Se escribe en largo ("25 de octubre de 2026") salvo que la ficha diga ISO                                                                                  |
| `{{NumeroObras}}` (empieza con "Numero")                                                                                                                                                           | Variable **numérica**                           | Formato es-MX                                                                                                                                              |
| `{{NombreFirmante2}}`, `{{CorreoFirmante2}}`                                                                                                                                                       | **Datos de un firmante**                        | Se reemplazan por el nombre y el correo que se capturan al enviar                                                                                          |
| `{{FirmaFirmante2}}`, `{{InicialesFirmante2}}`, `{{FechaFirmaFirmante2}}`                                                                                                                          | **Campo de firma** del firmante 2               | No se escribe texto: el marcador se vuelve una marca invisible en el PDF y ahí se coloca el campo de Documenso. **El campo queda donde está el marcador.** |
| `{{CampoNombreFirmante1}}`, `{{CampoCorreoFirmante1}}`, `{{CampoFechaFirmante1}}`, `{{TextoFirmante1}}`, `{{NumeroFirmante1}}`, `{{CasillaFirmante1}}`, `{{RadioFirmante1}}`, `{{ListaFirmante1}}` | Otros campos que llena el firmante en Documenso | Igual que la firma: el campo se coloca en el lugar del marcador                                                                                            |
| `{{Firma}}`, `{{Iniciales}}`, `{{FechaFirma}}` sin número                                                                                                                                          | Campo del **firmante 1**                        | Funciona, pero genera aviso; el asistente siempre escribe el número                                                                                        |

Reglas de escritura que el asistente aplica y explica:

- La clave va **sin espacios**, con letras (acentos permitidos), números, `_`, `.` o `-`, hasta 100 caracteres. Se escribe en CamelCase en español: `NombreArtista`, `PorcentajeRegalias`.
- La **misma clave repetida** es el mismo dato: escribir `{{NombreArtista}}` en el proemio y en la hoja de firmas pide el valor una vez.
- Los **firmantes** se numeran desde 1, sin huecos (un Firmante 3 sin un Firmante 2 genera aviso). Los roles con nombre ("Representante", "Artista") viven en `recipient_roles` de la variante.
- **Campos de firma:** cada `{{FirmaFirmanteN}}` va en su propia línea, en el bloque de firmas, justo encima de la línea o del nombre de ese firmante, nunca dentro de una oración. Las cajas se acomodan solas sin encimarse (`place_auto_fields`). Para la fecha de firma, `{{FechaFirmaFirmanteN}}` debajo de la firma.
- **Ficha por variable** (`variable_settings`): etiqueta con acentos, tipo (texto, fecha, número, moneda, opción), obligatoria, valor por defecto, ayuda y opciones. El asistente la llena al crear una variable ("Nombre del artista", obligatoria).
- **Lo que no se detecta:** `{{Nombre Cliente}}` (con espacio) y llaves sueltas. `analyse_docx_warnings` ya los avisa, y el asistente lo corrige al editar.

### 1.2 Regla de guardado: nunca alterar lo existente

- **Por defecto, guardar crea una variante nueva** de la misma plantilla. Copia el Word y la configuración (firmantes, campos, fichas, roles) de la variante o versión que se usó como base, aplica los cambios y queda con su versión 1 lista para usar (el mismo camino que `ContractTemplateVariantsEndpoint.post`).
- **La base puede ser** la variante principal, otra variante o una versión concreta ("usa la versión 3"). El asistente lee y trabaja sobre cualquiera, pero no la modifica.
- **Editar una variante existente solo si el usuario lo pide explícitamente** ("cambia la variante Principal", "guárdalo en la variante X"). Aun así:
  - se crea una **versión nueva** (`_create_revision`); las versiones anteriores nunca se tocan, y los envíos ya hechos siguen apuntando a la suya;
  - si alguien tiene un borrador de Word abierto en esa variante (`draft_active_by`), la tarjeta se niega y dice quién lo está editando.
- Si la base tiene un borrador de Word sin publicar, el asistente trabaja sobre lo publicado y lo avisa en una frase.
- **Variantes generadas:** `ContractTemplateVariant` gana `origin` (JSON, vacío por defecto) con `{by: "assistant", from_variant, from_revision, action_id}`. El detalle de la plantilla las marca "Generada por el asistente".
- **Nombre (decidido):** "<base> – <cambio en pocas palabras>", por ejemplo "Principal – artista como variable" o "Principal – sin exclusividad". El asistente lo propone con lo que se cambió y la persona lo puede editar en la tarjeta antes de aplicar. Si ya existe, se le agrega un número ("Principal – artista como variable (2)"). También se puede renombrar después desde el detalle de la plantilla, como cualquier variante.

### 1.3 Cómo se modifica el archivo Word

Las plantillas son archivos Word `.docx`: el alta solo los acepta (`ContractTemplatesEndpoint` rechaza lo demás con `invalid_docx`), y cada variante y versión guarda su `.docx` en S3. El asistente nunca toca Word ni Collabora directamente ni recibe el archivo. Propone operaciones en texto ("reemplaza «Juan Pérez» por `{{NombreArtista}}`"), y Django las aplica sobre los bytes del `.docx` al aplicar la tarjeta.

**Qué es un `.docx` por dentro.** Es un ZIP de archivos XML:

- `word/document.xml`: el cuerpo, con tablas y cuadros de texto;
- `word/header*.xml` y `word/footer*.xml`: encabezados y pies;
- `word/footnotes.xml` y `word/endnotes.xml`: notas;
- `word/styles.xml` y `word/numbering.xml`: estilos y numeración automática;
- imágenes y relaciones en sus propias carpetas.

Dentro del XML, cada párrafo es un `w:p` con "corridas" `w:r`: tramos de texto con el mismo formato (negrita, fuente, tamaño). El texto vive en `w:t`. Word parte una misma palabra en varias corridas por razones invisibles: un cambio de formato, la corrección ortográfica (`w:proofErr`), el idioma o el historial de edición. Por eso "Juan Pérez" puede estar escrito como `Ju` + `an Pé` + `rez`.

**Cómo se edita.** Se usa **lxml**, la misma librería con la que `contract_docx.py` ya lee y reemplaza los marcadores al usar una plantilla; ya está instalada (`lxml==6.1.0`). No se agrega python-docx: no lee encabezados, pies ni cuadros de texto con el mismo detalle, y tiene el mismo problema de las corridas.

1. Se abre el ZIP en memoria y se recorren todos los `word/*.xml` con texto: cuerpo, tablas, cuadros de texto (`w:txbxContent`), encabezados, pies y notas.
2. Por cada párrafo se une el texto de sus corridas, se busca el texto pedido y se calcula qué corridas abarca.
3. **Reemplazar con el cambio mínimo:** se compara el texto viejo con el nuevo y solo se toca lo que difiere. "3 años" → "5 años" cambia un carácter dentro de su corrida, y el resto del texto y su formato quedan intactos. Cuando todo el texto cambia (un nombre por un marcador), el texto nuevo toma el formato de la corrida que cubría la mayor parte del texto original. Las demás corridas solo pierden las letras reemplazadas; nunca se borran ni se les cambian sus propiedades. Es la lógica de `_replace_in_paragraph`, generalizada y más cuidadosa (ver 1.3.1).
4. **Insertar un párrafo nuevo** (una cláusula, una línea de firma): se crea un párrafo con las propiedades de párrafo del ancla (estilo, sangría, alineación, espaciado, numeración) y las propiedades de letra de su primera corrida. Así la cláusula nueva se ve como sus vecinas, incluso con numeración automática. No se copia nada más del ancla (ver 1.3.1).
5. Se vuelve a escribir solo el XML que cambió. El resto de las entradas del ZIP (imágenes, estilos, relaciones, propiedades del documento) se copia byte a byte, con su mismo orden, compresión y fecha dentro del ZIP.

**Casos especiales de Word:**

| Caso                                                                                                                       | Cómo se trata                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numeración automática ("Cláusula 5." generada por Word, no escrita)                                                        | El número no está en el texto. El outline la muestra calculada para que el asistente se ubique, pero las anclas usan el texto del párrafo, nunca el número.            |
| Control de cambios (`w:ins`, `w:del`)                                                                                      | El outline lee el texto como quedaría aceptado. Si el ancla cae en un cambio pendiente, la operación se rechaza y pide aceptar o rechazar los cambios en Word primero. |
| Controles de contenido (`w:sdt`) y campos de Word (`w:fldSimple`, `w:instrText`: fechas automáticas, índices, referencias) | Se leen como texto. No se editan por dentro: el asistente puede reemplazar el texto visible de un control, pero nunca los códigos de campo.                            |
| Hipervínculos y marcadores (`w:hyperlink`, `w:bookmarkStart`)                                                              | El texto dentro de un vínculo se reemplaza conservando el vínculo; los marcadores no se mueven.                                                                        |
| Imágenes, logotipos y firmas escaneadas                                                                                    | No se tocan. Borrar un párrafo con imagen pide confirmarlo aparte en la tarjeta.                                                                                       |
| Texto que cruza dos párrafos                                                                                               | No se puede usar como ancla: cada ancla vive en un solo párrafo. El asistente usa dos operaciones.                                                                     |
| Archivos `.doc` antiguos o `.docx` con macros                                                                              | No llegan aquí, porque el alta ya solo acepta `.docx`.                                                                                                                 |

**Validación antes de guardar:**

- El XML resultante se vuelve a leer con lxml.
- `analyse_docx_variables` y `analyse_docx_warnings` se corren sobre el resultado.
- La vista previa y la versión nueva convierten el `.docx` a PDF con Collabora (`_create_revision` ya lo hace). Si la conversión falla, no se guarda nada y la tarjeta muestra el error.
- La variante o versión base nunca se escribe. Las pruebas comparan su hash antes y después de cada operación.

**Lo que el asistente no hace en el Word:** cambiar estilos globales, márgenes o fuentes del documento, mover imágenes, editar tablas por celda fuera del texto (agregar columnas) ni tocar la numeración. Para eso la persona abre el Word de la variante nueva en Collabora, como hoy.

### 1.3.1 Garantía de formato

Una edición del asistente **solo cambia el texto que la tarjeta muestra**. El formato del texto y todo lo demás del documento se conserva. Esto es una regla dura: si no se puede cumplir, la edición se rechaza y no se guarda nada.

**Lo que se conserva siempre:**

- **Formato de letra:** fuente, tamaño, negrita, cursiva, subrayado, color, resaltado, mayúsculas por formato (`w:caps`), versalitas, espaciado entre letras e idioma.
- **Formato de párrafo:** estilo, sangrías, alineación, interlineado, espaciado, tabulaciones, bordes, sombreado y numeración o viñetas.
- **Estructura:** tablas, celdas, cuadros de texto, saltos de página y de sección, columnas, márgenes y tamaño de página (`w:sectPr`).
- **Contenido no textual:** imágenes, logotipos, firmas escaneadas, formas, marcas de agua, encabezados y pies, notas al pie, comentarios, marcadores, hipervínculos, campos automáticos y controles de contenido.
- **Archivo:** estilos, temas, fuentes incrustadas, numeración, configuración, propiedades del documento (autor, fechas) y cualquier otra entrada del ZIP, byte a byte.

**Reglas que lo garantizan:**

| Situación                                                                                                                                  | Regla                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| El texto a cambiar tiene formatos mezclados ("**Juan** Pérez")                                                                             | Con un reemplazo mínimo ("Juan" → "José"), cada parte conserva el suyo. Si el texto entero se vuelve un marcador, el marcador toma el formato de la parte más larga y la tarjeta lo avisa ("el nombre tenía negrita parcial; el valor saldrá con el formato de «Pérez»"). |
| El texto cruza una tabulación, un salto de línea, una imagen, un campo o una nota al pie dentro del párrafo                                | La operación se rechaza: esos elementos nunca se borran como parte de un reemplazo. El asistente usa un ancla más corta.                                                                                                                                                  |
| Espacios al inicio o al final de un tramo                                                                                                  | Se marca `xml:space="preserve"` para que Word no los elimine.                                                                                                                                                                                                             |
| El texto original está en mayúsculas literales ("JUAN PÉREZ") y no por formato                                                             | La ficha de la variable nueva lleva `case: "upper"` (opción nueva de `variable_settings`, por defecto vacía), y al usar la plantilla el valor se escribe en mayúsculas igual que el original. Si las mayúsculas vienen del formato, el marcador lo hereda solo.           |
| Insertar un párrafo copiando el del ancla                                                                                                  | Solo se copian las propiedades de párrafo y de letra. No se copian imágenes, marcadores, comentarios, notas, campos ni saltos de sección, ni los identificadores internos de Word (`w14:paraId`, `w14:textId`, ids de marcadores), que no pueden repetirse.               |
| Borrar un párrafo que contiene un salto de sección (`w:sectPr`), el inicio o fin de un marcador o comentario, una nota al pie o una imagen | Se rechaza, o se pide confirmarlo aparte en la tarjeta. Un salto de sección nunca se borra, porque lleva los márgenes y la orientación de las páginas.                                                                                                                    |
| El documento tiene activado el control de cambios                                                                                          | Las ediciones se aplican directo, sin marcarse como cambios, y la configuración del documento no se modifica. La tarjeta lo avisa.                                                                                                                                        |
| Comillas tipográficas, guiones largos y acentos                                                                                            | El texto nuevo se escribe tal cual, en UTF-8, sin normalizar.                                                                                                                                                                                                             |

**Collabora solo convierte a PDF.** Nunca se guarda un `.docx` reescrito por Collabora: al reguardar, un procesador de texto puede cambiar estilos, numeración o compatibilidad. El `.docx` que se guarda es siempre el original con las ediciones de lxml.

**Verificación automática antes de guardar** (`docx_edit.verify_preserved(before, after, report)`):

1. **ZIP:** las mismas entradas, en el mismo orden. Cada entrada que no se editó es idéntica byte a byte.
2. **XML editados:** se recorren en paralelo antes y después. Todo elemento y atributo debe ser idéntico, salvo:
   - el texto de los `w:t` que el informe dice que cambiaron;
   - los párrafos que el informe dice que se insertaron o borraron;
   - `xml:space` en los tramos tocados.

   Cualquier otra diferencia (una propiedad de letra, un elemento perdido, un id) aborta la edición.

3. **Resultado en PDF:** se convierten la base y el resultado. Si cambia el número de páginas o se mueve texto fuera de los párrafos editados (comparando con `_pdf_layout_signature`), la tarjeta lo avisa antes de aplicar. Un nombre más corto que su marcador puede mover una línea, y eso no es un error, pero se muestra.
4. **Lectura:** el resultado se vuelve a abrir con lxml y con `analyse_docx_variables`, y la conversión a PDF de Collabora debe terminar sin error.

La tarjeta muestra el resumen de esa verificación: "Formato conservado: cambió el texto de 4 tramos en 3 párrafos; nada más en el documento".

### 1.3.2 Funciones (`plane/utils/docx_edit.py`)

Funciones puras sobre bytes, probadas con `.docx` reales de plantillas (anonimizados) y con documentos generados que parten el texto en varias corridas a propósito:

- `docx_outline(data)`: los párrafos numerados con su lugar (cuerpo, tabla, encabezado o pie) y su texto, más los marcadores de cada uno. Es lo que lee el asistente.
- `find_text(data, text, match="exact" | "loose")`: cada aparición con su contexto (unas 40 letras antes y después) y su párrafo. "loose" ignora mayúsculas, acentos y espacios repetidos, para encontrar "JUAN PÉREZ" en el encabezado y "Juan Perez" en el cuerpo.
- `apply_edits(data, edits)`: aplica en orden y devuelve los bytes más un informe por cambio. Operaciones:
  - `replace_text {find, replace, occurrences: "all" | [índices], match}`: reemplaza texto, aunque esté partido entre varias "corridas" de formato de Word (reusa la lógica de `_replace_in_paragraph`). El reemplazo hereda el formato de la primera corrida (negritas, tamaño).
  - `insert_text {anchor, position: before | after, text}`: dentro del párrafo del ancla.
  - `insert_paragraph {anchor, position, text, style_from: anchor}`: un párrafo nuevo con el formato del párrafo del ancla; sirve para una cláusula nueva o una línea de firma.
  - `delete_paragraph {anchor}`.
  - `rename_token {from, to}`: cambia un marcador en todas partes y mueve su ficha.
- **Errores accionables:** un ancla que no aparece, o que aparece varias veces sin decir cuál, devuelve un error con las apariciones encontradas para que el asistente elija. Un ancla debe estar dentro de un solo párrafo.
- Después de editar: `analyse_docx_variables`, `schema_changes` (lo que se agregó o quitó) y `analyse_docx_warnings`, que ya existen.

### 1.4 Endpoints de Django

- **Internos** (para el worker, con los permisos de quien pide):
  - `GET .../assistant/contract-templates/`: plantillas con variantes, versiones, resumen del esquema, roles y si hay borrador abierto.
  - `GET .../assistant/contract-templates/variants/<id>/outline/?revision=`: el `docx_outline`, el esquema, las fichas y los avisos.
  - `POST .../assistant/contract-templates/variants/<id>/dry-run/`: aplica las operaciones en memoria. Devuelve el informe (cada aparición con su contexto), los cambios del esquema y los avisos, sin guardar nada.
- **Para la web:** `POST .../contract-templates/variants/<id>/assistant-preview/` convierte en memoria el Word editado a PDF con Collabora (`_pdf_for_content`, `store=False`), para que la tarjeta lo muestre antes de aplicar. Lleva caché por hash, como el resto de las conversiones.
- **Acciones nuevas:**
  - `CREATE_TEMPLATE_VARIANT`: la variante nueva con su versión 1 y su `origin`. **Deshacer** la borra (con sus archivos) si ningún envío usa sus versiones; si ya se usó, se niega y propone archivarla.
  - `EDIT_TEMPLATE_VARIANT`: versión nueva en una variante existente, solo con pedido explícito. **Deshacer** devuelve el Word anterior a la variante y borra esa versión si no se usó y no hay otra posterior; si no, se niega.
  - `CREATE_CONTRACT_DRAFT`: la solicitud de firma lista para revisar (ver 1.6). **Deshacer** la borra si no se ha enviado; si ya se envió, se niega y ofrece "Cancelar".

### 1.5 Herramientas del asistente (worker, `src/template-tools.ts`)

- `find_contract_templates(query?)`: lista o búsqueda.
- `read_contract_template(variant_id, revision?)`: el outline, el esquema, las fichas y los avisos.
- `propose_template_edit(base: {variant_id, revision?}, edits[], save: "new_variant" | "this_variant", name?, variable_settings?, recipient_roles?)`:
  - `save` es `new_variant` salvo que el usuario haya pedido editar esa variante; el prompt lo exige.
  - Corre el dry-run antes de devolver la tarjeta. Si un ancla falla, el asistente recibe el error con las apariciones y corrige antes de proponer.
- `propose_contract_from_template(...)` (1.6).

**Tarjeta de edición:**

- Cada cambio con su contexto: "…que celebra el C. [Juan Pérez → `{{NombreArtista}}`] en su carácter de…", con casilla por aparición. Las encontradas en modo "loose" vienen marcadas; las parciales ("el Sr. Pérez") vienen sin marcar, para que la persona decida.
- Los cambios del esquema: "Variable nueva: Nombre del artista (obligatoria)", "Firmante 2 gana campo de firma".
- Los avisos, el botón "Vista previa (PDF)" y el destino: variante nueva (nombre editable) o "versión nueva de <variante>" cuando se pidió.
- Aplicar, Descartar y Deshacer. Después de aplicar: enlaces a la variante y a "Configurar campos".

**Ejemplo, el caso del usuario:** una plantilla salió de un contrato real y se quiere reutilizar.

1. "En la plantilla Edición Juan Pérez, cambia el nombre del artista por una variable."
2. El asistente lee el outline y busca "Juan Pérez" en modo loose. Encuentra 4 apariciones: proemio, cláusula 2, encabezado en mayúsculas y bloque de firmas. Además ve "el Sr. Pérez" en la cláusula 7.
3. Propone `replace_text` de las 4 por `{{NombreArtista}}`, con la ficha "Nombre del artista", obligatoria. "el Sr. Pérez" queda sin marcar en la tarjeta.
4. Si en el bloque de firmas el nombre está bajo la línea de firma del artista, sugiere `{{NombreFirmante2}}` ahí en vez de la variable (el nombre del firmante se captura al enviar) y `{{FirmaFirmante2}}` encima de la línea, si no estaba.
5. Al aplicar se crea la variante "Principal – artista como variable". La Principal no cambia.

### 1.6 Crear un contrato desde una plantilla

- `propose_contract_from_template(variant_id, revision?, values{}, recipients[], title?, document_edits?)`:
  - **Valores:** salen de la conversación y de datos del workspace: la etiqueta del artista y su ficha del catálogo, o "usa los datos del contrato anterior de X" (campos extraídos de ese contrato). Cada valor lleva su origen. Lo que falta queda vacío y marcado en la tarjeta; el asistente pregunta solo lo indispensable.
  - **Cambios al texto solo para este contrato** ("quita la cláusula de exclusividad", "pon 5 años en vez de 3") pasan por la regla 1.2: se genera una variante nueva con esos cambios y el contrato se crea sobre ella. Llenar variables no cambia la plantilla y no genera variante.
- **Tarjeta:**
  - Plantilla, variante y versión.
  - Formulario de valores según la ficha: tipo, obligatoria, opciones y fecha con calendario.
  - Firmantes con sus roles (nombre y correo).
  - Avisos, y vista previa con los valores puestos (el render del diálogo "Usar").
  - "Crear borrador" crea la solicitud lista para revisar y abre la pantalla de envío, donde la persona revisa los campos y pulsa "Enviar a firma". **El asistente nunca envía.**
- **Django:** la lógica de `ContractSignatureRequestsEndpoint.post` pasa a una función (`create_signature_request(...)`) que usan el endpoint y la acción. Los errores (`Falta el valor de X`) llegan con su clave i18n.

## 2. Corregir los datos extraídos de un contrato

- `propose_contract_edit(items[{contract_id, changes{campo: valor}, reason, quote?}])`, hasta 50 contratos por tarjeta. Sirve para un dato ("la fecha de inicio es 1 de marzo") o en lote ("estos 5 son de edición").
  - Campos permitidos: `CONTRACT_EDITABLE_FIELDS`. Las opciones (tipo, estatus, periodos) se validan contra las listas del modelo.
  - Fechas en ISO; listas de personas (`artistas`, `involucrados`) como texto separado por comas, igual que hoy.
- **Tarjeta:** por contrato, una tabla campo / antes / después con la cita del texto y su página ("Ver" abre el PDF en esa página). Casilla por cambio. Si el contrato tiene un reanálisis pendiente de confirmar (`proposed_data`), lo avisa.
- **Django, acción `EDIT_CONTRACT`**, con el mismo camino que el panel:
  - `ContractUpdateSerializer` parcial;
  - `shifted_effective_end` si cambia `fecha_fin`;
  - `refresh_status`;
  - `resync_tags_if_changed` (las etiquetas de artista siguen al cambio).
  - Cada campo editado queda en `evidence[campo] = {manual: true, quote, by, at}`. El panel muestra "corregido a mano" y el reanálisis lo marca al proponer cambios sobre él.
  - **Deshacer:** campo por campo, solo si sigue con el valor aplicado. Restaura también la evidencia anterior y vuelve a sincronizar las etiquetas.

## 3. Editar tareas

- **Lectura:** `query_work_items(project?, assignee?, state_group?, labels?, due_before?, due_after?, text?, limit≤100)`, con la visibilidad de quien pide. Sirve para "todas las tareas de Ana en Lanzamientos".
- `propose_work_item_update(items[{issue_id, set{...}}])`, hasta 100 tareas:
  - Campos: estado (por nombre dentro del proyecto), prioridad, fechas, título, responsables (agregar o quitar), etiquetas (agregar o quitar), ciclo, módulo, tarea padre y agregar texto al final de la descripción.
  - La descripción completa solo se reescribe si se pide explícitamente.
  - Django resuelve los nombres en un dry-run (estado "Hecho", "Ana", etiqueta "renovación"). Si un nombre es ambiguo, la tarjeta muestra un selector.
- `propose_work_item_comment(issue_id, markdown)`: el comentario con menciones, convertidas con `markdown_to_html`.
- **Tarjeta:** tabla tarea / campo / antes / después, con casilla por fila; o el comentario renderizado.
- **Django, acciones `EDIT_WORK_ITEMS` y `COMMENT_WORK_ITEM`:**
  - El camino es el del PATCH de Plane: el serializer parcial más `issue_activity` con `current_instance`. Así el historial, las notificaciones y los webhooks se comportan igual que una edición a mano.
  - Permiso: miembro o administrador del proyecto.
  - **Deshacer:** campo por campo con detección de conflictos, registrando la actividad otra vez; un comentario se borra si nadie lo editó.

## 4. Ordenar la biblioteca

- **Lectura:**
  - `list_folder(folder_id | path, recursive?)`: archivos y subcarpetas, con contrato, etiquetas y tamaño.
  - `find_duplicate_files(folder?)`:
    - **exactos**, por `attributes.content_hash`. Para archivos viejos sin hash, se calcula al pedirlo, solo en la carpeta revisada, y se guarda como dato nuevo; el archivo no cambia;
    - **posibles**, por mismo nombre y tamaño.
- `propose_file_organization(ops[])`, hasta 200 operaciones:
  - `rename`: el nombre visible; el objeto en S3 no cambia.
  - `move` a una carpeta existente o nueva, aceptando rutas ("Contratos/2024/Juan Pérez").
  - `create_folder`.
  - `categorize`: poner en "Contratos" arranca el análisis, y la tarjeta lo dice con su costo.
  - `tag`.
  - `trash`.
  - Nombres desde el contenido: el asistente usa el título y los artistas del contrato, o `read_file`, con un patrón consistente ("Contrato de edición – Juan Pérez – 2024.pdf").
- **Duplicados:** se conserva el archivo con más vínculos (contrato, etiquetas, referencias, gasto) y, si empatan, el más antiguo. Los demás se proponen a la papelera.
- **Límites de seguridad:**
  - `trash` nunca toca archivos que son contratos analizados: borrar un contrato elimina su análisis y no se puede deshacer, así que eso sigue en el panel de contratos.
  - Tampoco toca comprobantes de gastos ni archivos de plantillas.
  - La tarjeta separa por tipo de operación y pide confirmar aparte la papelera.
- **Django, acción `ORGANIZE_FILES`:** reusa la lógica de renombrar, mover y etiquetar de la biblioteca. **Deshacer** restaura nombres y carpetas, saca de la papelera y borra las carpetas creadas que quedaron vacías.

## 5. Gastos desde comprobantes (foto, PDF, XML y más)

Ya existe la extracción: `ExpenseImport`, `/trigger/extract` del worker, sugerencias de presupuesto y categoría (`_suggestions`) y duplicados (`_duplicates`). El asistente la usa en lugar de duplicarla. Solo para administradores, como el módulo.

- **Formatos aceptados:**
  - Imágenes: JPG, PNG, WebP, TIFF y HEIC (fotos de iPhone).
  - PDF digital o escaneado.
  - **XML CFDI 3.3 y 4.0.**
  - **Pares PDF + XML de la misma factura**, que se vuelven un solo gasto con los dos documentos.

  Hay que agregar `.xml`, `.tif`/`.tiff` y HEIC donde falten: los adjuntos del chat (`ACCEPTED` en `attachments.tsx`) y la lista permitida de `ExpenseImportEndpoint`.

- **CFDI determinista** (`plane/utils/cfdi.py`): el XML se lee con lxml sin entidades ni red (`resolve_entities=False`, `no_network=True`, tope de 2 MB). No pasa por el modelo: los montos salen exactos.

  | CFDI                                               | Gasto                                                                               |
  | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `Total`, `Moneda`, `TipoCambio`                    | `amount`, `currency`                                                                |
  | `Fecha`                                            | `expense_date`                                                                      |
  | `Emisor@Nombre` (más RFC)                          | `vendor` (RFC en la descripción)                                                    |
  | `Serie` + `Folio`                                  | `reference`                                                                         |
  | `Conceptos/Concepto@Descripcion`                   | `concept` y `description`                                                           |
  | `TimbreFiscalDigital@UUID`                         | `cfdi_uuid` (columna nueva)                                                         |
  | `MetodoPago` PUE / PPD                             | sugerencia: pagado / pendiente (la persona decide; por defecto pendiente, como hoy) |
  | `TipoDeComprobante` E (nota de crédito) o P (pago) | aviso: no es un gasto normal                                                        |

- **Pares:** se emparejan por el UUID impreso en el PDF; si no lo trae, por nombre de archivo igual o por mismo total, RFC y fecha.
- **Duplicados:** `Expense` gana `cfdi_uuid` (acepta vacío, con índice). Un UUID repetido es duplicado seguro; lo demás sigue con `_duplicates`.
- **Herramienta** `propose_expenses_from_documents(asset_ids[], scenario?, notes?)`:
  - Un endpoint interno crea o reusa el `ExpenseImport` de cada archivo (el XML queda listo al instante) y devuelve los trabajos.
  - La tarjeta consulta su estado con el endpoint que ya existe, hasta que estén listos.
  - Cada gasto muestra los campos extraídos (editables), el presupuesto y la categoría sugeridos, el aviso de duplicado y sus documentos.
- **Django, acción `CREATE_EXPENSES`:** usa el mismo camino de guardado del importador: `ExpenseSerializer`, un `ExpenseDocument` por cada documento del par, y el trabajo pasa a IMPORTED. **Deshacer** borra (soft) los gastos que nadie editó y regresa sus trabajos a READY.
- **Después** (decisión 3): un ZIP con varias facturas (las descargas del SAT) y una hoja de cálculo con varios gastos, que llegarían a la misma tarjeta con una fila por gasto.

## 6. Auditoría del catálogo musical

- **Herramienta** `audit_catalog(checks?, artist?, release?)`: un endpoint interno calcula todo de forma determinista y devuelve, por revisión, el conteo, hasta 50 ejemplos y los ids. Revisiones:
  1. **Canciones sin contrato** que las cubra (sin vínculo `LINKED`), o cubiertas solo por contratos vencidos (`fecha_fin_efectiva`).
  2. **Contratos editoriales sin obras** ligadas, y sugerencias de vínculo pendientes de revisar.
  3. **ISRC:** falta, formato inválido o repetido en canciones distintas. **UPC:** falta o tiene el dígito verificador mal en lanzamientos.
  4. **Créditos:** porcentajes editoriales que no suman 100, porcentajes mayores a 100, canciones sin artista principal o sin autor.
  5. **Porcentajes de la canción** (artista, sello, distribuidora, agregadora) que suman más de 100.
  6. **Desajustes contrato ↔ catálogo:** el contrato dice artista X y las canciones ligadas acreditan a otro.
  7. **Etiquetas:** artistas acreditados sin etiqueta de artista, o etiqueta sin artista del catálogo.
  8. **Huecos:** lanzamientos sin canciones, canciones sin lanzamiento, sin fecha o sin portada.
- **Salida:** un resumen en el chat y, si se pide, una página de reporte (`propose_report`). De ahí salen las correcciones:
  - Ligar contratos: `propose_work_links` (ya existe).
  - Corregir datos: `propose_catalog_fixes(items[{entity, id, changes, source}])`, con la acción `CATALOG_FIXES` y su deshacer. Solo valores con origen (el texto del contrato, otra canción con el mismo ISRC, lo que dictó el usuario); nunca inventados. Un ISRC que falta se reporta, no se llena.
  - Ligar etiquetas: `link_artist_tags` (ya existe).
  - Lo que requiere trabajo humano: una tarea por hallazgo o una por artista (`propose_work_item`).
- Retomar el punto 1 de `assistant-edit-proposals.md`: `update_music_track` hoy aplica directo y sin deshacer. Pasa a la misma acción `CATALOG_FIXES`.

## Fases

Cada fase se puede subir por separado. Se empieza por plantillas, después de la base.

0. **Base:** tarjetas guardadas en el servidor y el helper de deshacer con conflictos.
1. **Plantillas:**
   - 1a: `docx_edit.py`, outline y dry-run, `read_contract_template`, `propose_template_edit` con variante nueva y edición explícita, vista previa, y el formato `{{}}` en el prompt.
   - 1b: `propose_contract_from_template` y la refactorización de `create_signature_request`.
2. **Datos de contratos y tareas** (misma mecánica): `EDIT_CONTRACT`, `query_work_items`, `EDIT_WORK_ITEMS` y `COMMENT_WORK_ITEM`.
3. **Gastos:** `cfdi.py`, pares, `cfdi_uuid`, formatos nuevos y `CREATE_EXPENSES`.
4. **Biblioteca:** lectura, duplicados y `ORGANIZE_FILES`.
5. **Auditoría:** `audit_catalog`, reporte y `CATALOG_FIXES` (incluye pasar `update_music_track` a deshacer).

## Migraciones (todas solo agregan)

- `AssistantAction`: opciones nuevas de `kind` (`CREATE_TEMPLATE_VARIANT`, `EDIT_TEMPLATE_VARIANT`, `CREATE_CONTRACT_DRAFT`, `EDIT_CONTRACT`, `EDIT_WORK_ITEMS`, `COMMENT_WORK_ITEM`, `ORGANIZE_FILES`, `CREATE_EXPENSES`, `CATALOG_FIXES`), más `tool_call_id` y `chat_id`, que aceptan vacío, con restricción única condicional.
- `ContractTemplateVariant.origin`: JSON, por defecto `{}`.
- `Expense.cfdi_uuid`: texto vacío por defecto, con índice.

Ninguna rellena ni modifica filas existentes.

## Verificación

- **Django:**
  - `docx_edit`: reemplazo partido entre corridas, encabezados, pies, tablas, cuadros de texto y notas, formato heredado, anclas ambiguas, renombrar marcador, párrafo nuevo con estilo y numeración, rechazo dentro de control de cambios, vínculos conservados, y entradas del ZIP no editadas idénticas byte a byte.
  - **Formato** (1.3.1), con un `.docx` de prueba que junta todo lo difícil: texto con formatos mezclados, mayúsculas literales y por formato, tabulaciones y saltos dentro del párrafo, imágenes, notas al pie, marcadores, comentarios, campos, controles de contenido, saltos de sección y control de cambios activado. Después de cada operación, `verify_preserved` no debe encontrar diferencias fuera de lo informado, y cada caso que debe rechazarse se rechaza.
  - Sobre las plantillas reales del workspace (copias locales anonimizadas): cada operación típica (nombre → marcador, cambiar una cifra, agregar una cláusula, agregar una firma) pasa `verify_preserved`, y el PDF de base y resultado se compara página por página.
  - Abrir cada `.docx` editado en Collabora (conversión a PDF sin error) con 3 o 4 plantillas reales del workspace.
  - La regla de guardado: la variante base y sus versiones quedan idénticas byte a byte; una edición explícita crea una versión nueva; un borrador abierto bloquea; deshacer con y sin envíos.
  - `create_signature_request` sin regresiones.
  - `EDIT_CONTRACT` (fin efectivo, etiquetas, deshacer con conflicto), `EDIT_WORK_ITEMS` (actividad registrada, permisos), `cfdi.py` (CFDI 3.3 y 4.0 reales anonimizados, nota de crédito, XML malicioso con entidades), pares, `ORGANIZE_FILES` (nunca manda contratos a la papelera) y las revisiones de la auditoría.
  - `makemigrations --check`.
- **Worker:** pruebas de validación de operaciones y del armado de tarjetas; `check:types` y `pnpm test`.
- **Chrome**, por fase:
  - el caso de "Juan Pérez → `{{NombreArtista}}`" de punta a punta, hasta enviar a firma en Documenso local;
  - corregir una fecha y deshacer;
  - pasar 5 tareas a Hecho;
  - un CFDI con su PDF que queda como un solo gasto;
  - ordenar una carpeta con duplicados;
  - una auditoría con reporte.

## Decisiones

Tomadas:

- **Se empieza por plantillas** (fase 1), después de la base (fase 0).
- **Las variantes generadas se nombran "<base> – <cambio>"** y el nombre se puede editar en la tarjeta (1.2).

Pendientes:

1. **Contrato desde plantilla sin cambios al texto:** usar la variante tal cual (recomendado: llenar variables no altera la plantilla) o generar siempre una variante.
2. **ZIP de facturas y hoja de cálculo de gastos:** después de la fase 3 (recomendado) o dentro de ella.
