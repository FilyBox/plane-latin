# Asistente: lo que crea pero no edita, y qué agregar

Estado: propuesta (2026-10-28). Implementado después, con el plan de `docs/assistant-workspace-actions.md`: el punto 1 para canciones (`update_music_track` → `CATALOG_FIXES`), tareas (2), contratos (3, sin reanalizar), archivos (5), gastos desde comprobantes y auditoría del catálogo; además las tarjetas guardan su estado en el servidor. Lo demás sigue pendiente. Contexto general en `docs/plane-latin-context.md` (5.7).

Todas las propuestas siguen las reglas del asistente: propone en una tarjeta, la persona revisa y aplica, queda un `AssistantAction` con deshacer, y se respetan los permisos de quien pide.

## 1. Inventario actual

| Elemento              | Qué crea                                                                                        | Qué edita                                         | Qué no puede                                                                              | ¿Deshacer? |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| Tareas                | `propose_work_item` (título, descripción, proyecto, responsable, prioridad, fecha, referencias) | nada                                              | estado, responsable, fechas, prioridad, etiquetas, descripción, comentarios, ciclo/módulo | sí (crear) |
| Páginas               | `propose_page`, `propose_report`                                                                | `propose_page_edit` (vía Live)                    | —                                                                                         | sí         |
| Etiquetas             | etiqueta nueva al etiquetar; fusiones                                                           | poner/quitar en elementos                         | renombrar, cambiar tipo, borrar, ligar a un artista                                       | sí         |
| Memoria               | `propose_memory`                                                                                | nada                                              | corregir o retirar una memoria                                                            | —          |
| Canciones             | (importación por el importador)                                                                 | `update_music_track`: fechas, ISRC, agregar video | título, versión, créditos, estado, enlaces, quitar video                                  | **no**     |
| Lanzamientos          | `propose_album_grouping` (crea, agrupa, une duplicados)                                         | nada                                              | título, tipo, UPC, fecha, sello, distribuidora                                            | **no**     |
| Contrato ⇄ obras      | `propose_work_links` (liga y agrega al catálogo)                                                | nada                                              | cambiar tipo de derechos, desligar, descartar sugerencias                                 | **no**     |
| Contratos             | revisión profunda; PDFs separados/unidos                                                        | nada                                              | campos extraídos, estatus, editorial, reanalizar, enviar a firma                          | —          |
| Archivos              | PDFs (separar, unir, páginas)                                                                   | nada                                              | renombrar, mover, categorizar, borrar                                                     | sí (PDFs)  |
| Gastos y presupuestos | nada                                                                                            | nada                                              | todo                                                                                      | —          |

Además, el estado de cada tarjeta vive en el `sessionStorage` del navegador: en otra pestaña una tarjeta ya aplicada aparece pendiente y se puede aplicar dos veces.

## 2. Ediciones a agregar (por prioridad)

1. **Registrar con deshacer lo que hoy aplica directo** (canciones, agrupar álbumes, ligar obras). Es la base de todo lo demás: mismo patrón que `EDIT_PAGE`, guardando el "antes" y negándose a deshacer si alguien cambió el dato después. Riesgo bajo, valor alto: hoy esos cambios no se ven en "Cambios del asistente".
2. **Tareas: `EDIT_WORK_ITEM` y `COMMENT_WORK_ITEM`.** Estado, responsable, prioridad, fechas, etiquetas y agregar texto a la descripción, también en lote ("pasa a Hecho todas las tareas de renovación de X"). Usa la actividad de Plane (`issue_activity`) para que quede en el historial de la tarea.
3. **Contratos: `EDIT_CONTRACT`.** Corregir campos que la IA leyó mal, con la cita como evidencia en la tarjeta (antes/después). Reusa `ContractUpdateSerializer`, el recálculo de fin efectivo y el resync de etiquetas del panel. Incluir mover a o sacar de Editoriales y "reanalizar" (crea el trabajo de reintento, con su costo visible).
4. **Lanzamientos y canciones completos:** `EDIT_RELEASE` (título, tipo, UPC, fecha, sello, distribuidora) y ampliar `update_music_track` a título, versión, créditos (`Nombre <Rol>`), estado y enlaces; quitar un video. En lote: "ponle la agregadora Virgin a todo el álbum".
5. **Archivos: `RENAME_FILES`, `MOVE_FILES`, `CATEGORIZE_FILES`, `TRASH_FILES`.** Encaja con separar PDFs ("ponle a cada parte el nombre del artista y muévelas a su carpeta"). Poner en "Contratos" arranca el análisis: la tarjeta lo dice.
6. **Etiquetas:** renombrar, cambiar el tipo (ARTIST, GROUP…), ligar a un artista del catálogo y borrar una sin uso. Solo administradores, como las fusiones.
7. **Memoria:** corregir o retirar una memoria cuando el usuario corrige un dato guardado, en vez de crear una duplicada. Administradores aprueban; los demás sugieren.
8. **Gastos:** crear un gasto desde un comprobante adjunto (la extracción con IA ya existe en el worker) y editar sus campos. Presupuestos después; nómina queda fuera, por decisión anterior.

## 3. Otras capacidades útiles para el agente

- **Guardar el resultado de cada tarjeta en el servidor** (el `AssistantAction` ligado al `toolCallId`): un chat reabierto en cualquier pestaña muestra lo aplicado y no permite aplicarlo dos veces.
- **Contratos por vencer → tareas:** "¿qué vence en los próximos 90 días?" y proponer una tarea por contrato, con responsable y fecha antes del vencimiento.
- **Después de separar un paquete:** cuando terminen los análisis, proponer en una sola tarjeta nombres limpios ("Contrato de edición – Juan Pérez") y las etiquetas de artista de cada parte.
- **Contrato desde plantilla:** llenar las variables con datos de la conversación o de otro contrato y dejar un borrador listo para revisar y enviar a firma (nunca envía solo).
- **Estado de firmas:** "¿quién no ha firmado el contrato de X?", con la opción de proponer un recordatorio.
- **Auditorías del catálogo:** canciones sin ISRC, sin contrato que las cubra o sin créditos; contratos sin obras ligadas. Termina en un reporte (página) y, si se pide, en tareas o propuestas en lote.
- **Duplicados:** contratos con el mismo contenido (`content_hash`), canciones o lanzamientos repetidos, con propuesta de unir o descartar.
- **Resumen semanal programado:** una página con vencimientos, importaciones, análisis con error y cambios del asistente.

## 4. Orden sugerido

1 (deshacer para lo que ya existe) y la persistencia de tarjetas primero; luego 2 (tareas) y 3 (contratos), que son las ediciones que más se piden; después 4 y 5.
