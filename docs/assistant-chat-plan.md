# Asistente IA general (assistant-ui + AI SDK + tools) — plan de implementación

> Estado: en implementación. Este documento es la fuente de verdad del plan;
> se actualiza conforme avanza cada fase.

## Contexto real del código (auditado)

Lo que YA existe y se reutiliza (no se reinventa):

| Pieza | Dónde | Se reutiliza para |
|---|---|---|
| RAG de contratos (chunks + pgvector + embed en worker) | `apps/workers/contracts-pipeline/src/chat.ts`, `InternalChunkSearchEndpoint` | tool `search_contracts` |
| Filtros ricos de tracks (artista, rango fechas, video, ISRC…) | `_filter_tracks` en `apps/api/plane/app/views/music/base.py` | tool `query_music_tracks` |
| Export CSV/**XLSX** con esos mismos filtros (openpyxl) | `MusicReportEndpoint` (`/music/reports/?format=xlsx`) | botón "Descargar Excel" del chat — **cero backend nuevo** |
| Import CSV/XLSX con mapeo heurístico + dedupe ISRC→(título+fecha) + estrategias skip/update/error + `dry_run` transaccional | `MusicImportPreviewEndpoint` / `MusicImportEndpoint` | flujo de import por chat: la IA solo aporta el **mapping**; el import determinista hace el resto |
| Upsert anidado de track (créditos, links, videos, distribuciones) | `MusicTrackEndpoint._sync_relations` | tool `update_music_track` |
| Presigned URL interna de assets | `InternalAssetPresignedUrlEndpoint` | el worker lee archivos subidos a Files |
| Auth worker↔Django | `X-Plane-Internal-Key` / `X-Trigger-Secret` (timing-safe) | igual para los endpoints nuevos |
| Proveedores IA (Gemini + DeepSeek con fallback) | `apps/workers/contracts-pipeline/src/lib/ai.ts` (fetch crudo) | el chat nuevo usa **AI SDK** (`@ai-sdk/google`, `@ai-sdk/deepseek`) con la misma config de env |

## Decisiones de arquitectura

1. **El agente corre en el Cloudflare Worker** (no en Django): el AI SDK es
   fetch-based y edge-compatible; el worker ya tiene los secretos de IA y el
   acceso interno a Django. Nuevo endpoint `POST /assistant/chat` que hace
   `streamText` con tools y responde `toUIMessageStreamResponse()` (SSE).
2. **Django es proxy de streaming + auth**: `POST /api/workspaces/:slug/assistant/chat/`
   valida sesión/rol/feature-flags, inyecta `workspace_id`, y hace pipe del
   SSE del worker con `StreamingHttpResponse` (requests stream=True).
   Sin CORS, sin tokens nuevos en el navegador. Trade-off aceptado: un thread
   de gunicorn por stream activo (escala del equipo actual: OK).
3. **Frontend obligatorio assistant-ui**: `@assistant-ui/react` +
   `@assistant-ui/react-ai-sdk` (+ `ai@^7`, `@ai-sdk/react@^4`).
   `useChatRuntime({ transport: new AssistantChatTransport({ api: <proxy> }) })`.
   UI del thread con primitives (ThreadPrimitive/MessagePrimitive/ComposerPrimitive)
   estilizados con el design system del repo (NO el plugin de build
   `"use generative"`/`aui()` de Vite: demasiado invasivo para este monorepo;
   los tool UIs se registran con `makeAssistantToolUI`, que es API estable).
4. **Human-in-the-loop pragmático**: las mutaciones (aplicar import, aplicar
   update) NO las ejecuta el modelo. Los tools de servidor devuelven una
   **propuesta** (dry-run/diff); el tool UI renderiza un botón "Aplicar" que
   llama al endpoint REST de Django con la sesión del usuario. Auditable y
   sin depender de APIs de aprobación nuevas.
5. **Multi-step**: `stopWhen: stepCountIs(8)` para que el modelo encadene
   búsqueda → refinamiento → respuesta.

## Tools del agente (worker)

| Tool | inputSchema (zod) | Ejecuta | Devuelve |
|---|---|---|---|
| `search_contracts` | `query`, `top_k?` | embed + `searchChunks` interno (igual que chat GENERAL actual) | fragmentos + fuentes (contract_id, título, similitud) |
| `query_music_tracks` | `search?`, `artist_name?`, `from?`, `to?`, `year?`, `has_video?`, `isrc?`, `status?`, `limit?` | **nuevo** `GET /internal/music/tracks/` (envuelve `_filter_tracks` + `artist_name` icontains) | filas compactas (título, artistas, isrc, fechas, videos, links) + total |
| `export_music_excel` | mismos filtros | nada remoto — construye los query params del `MusicReportEndpoint` | `{count, params}` → el tool UI arma `/music/reports/?format=xlsx&…` (descarga con cookie) |
| `propose_music_import` | `asset_id`, `sheet?`, `duplicate_strategy?` | presigned URL interna → parsea CSV/XLSX en el worker (SheetJS) → IA genera `mapping` hacia los `IMPORT_FIELDS` canónicos → **nuevo** `POST /internal/music/import/` con `dry_run=true` | headers detectados, mapping propuesto, `{created,updated,skipped,errors}` del dry-run |
| `update_music_track` | `track_query` (isrc o título+artista), `set` (fechas, isrc, video_url+fecha+isrc…) | **nuevo** `GET /internal/music/tracks/` para resolver el track + construir diff | diff propuesto `{track_id, before, after}` |
| `list_music_files` | `search?` | `GET` interno de assets del file library (filtra por nombre) | candidatos con asset_id para encadenar con `propose_music_import` |

Endpoints REST nuevos en Django (sesión de usuario, para los botones "Aplicar"):
- `POST /api/workspaces/:slug/music/import/asset/` — igual a `MusicImportEndpoint`
  pero leyendo el archivo desde S3 por `asset_id` (reusa `_read_table` +
  `_import_row` tal cual), con `mapping`/`defaults`/`duplicate_strategy`/`dry_run`.
- `PATCH /music/tracks/:id/` ya existe → el botón de update usa eso + `video_entries`.

Endpoints internos nuevos (permiso `WorkerServicePermission`):
- `GET /api/internal/workspaces/:workspace_id/music/tracks/` (filtros de arriba)
- `POST /api/internal/workspaces/:workspace_id/music/import/` (asset_id + mapping + dry_run)
- `GET /api/internal/workspaces/:workspace_id/assets/` (búsqueda por nombre para `list_music_files`)

## Frontend (web)

- Ruta nueva `/:workspaceSlug/assistant` (layout + page), gated: feature
  `file_library` **o** `music` habilitada; sidebar item "Asistente" con icono
  `Sparkles` — tocando los 5 puntos conocidos: `WORKSPACE_SIDEBAR_DYNAMIC_NAVIGATION_ITEMS`,
  helper de iconos, filtro en `sidebar-menu-items.tsx`, `extended-sidebar.tsx`,
  `customize-navigation-dialog.tsx`, **y** `UserPreferenceKeys` en el backend
  (sin esa clave el pin hace no-op silencioso).
- `AssistantRuntimeProvider` + Thread propio (primitives + Tailwind del repo).
- Tool UIs (`makeAssistantToolUI`):
  - `query_music_tracks` → tabla compacta de resultados.
  - `export_music_excel` → card con conteo + botón **Descargar Excel** (anchor
    al report endpoint con los params; cookie auth, descarga directa).
  - `search_contracts` → chips de fuentes (link al peek del contrato).
  - `propose_music_import` → card de propuesta (mapping + conteos del dry-run +
    errores) con botón **Aplicar importación** → `POST /music/import/asset/`
    (dry_run=false) → toast + resumen.
  - `update_music_track` → card de diff con botón **Aplicar cambios** →
    `PATCH /music/tracks/:id/`.
- Selector de modelo (reusa `/models` del worker vía el endpoint existente).

## Config / env

- Worker: reutiliza `GOOGLE_GENERATIVE_AI_API_KEY` (nombre que `@ai-sdk/google`
  lee por defecto), `DEEPSEEK_API_KEY`, `AI_PROVIDER` (default deepseek),
  `PLANE_INTERNAL_API_URL/SECRET`. Sin bindings nuevos.
- Django: `CF_WORKER_TRIGGER_URL/SECRET` ya existen (el proxy los reusa).

## Fases

1. **F1 — Query + Export (valor inmediato)**: proxy Django, worker `/assistant/chat`
   con `search_contracts` + `query_music_tracks` + `export_music_excel`,
   página assistant-ui con esas tool UIs. ✅ criterio: preguntar "canciones de
   X artista entre fecha A y B" → tabla + botón Excel que descarga.
2. **F2 — Import sin estándar**: `list_music_files` + `propose_music_import`
   (mapping por IA + dry-run) + endpoint import-by-asset + tool UI con Aplicar.
3. **F3 — Updates guiados**: `update_music_track` + tool UI de diff + Aplicar.
4. **F4 — Pulido**: persistencia de conversaciones (modelos AssistantChat/Message),
   attachments directos en el chat, import de PDF/imagen vía Textract,
   sugerencias de prompts, historial.

## Estado de implementación

- ✅ Django F1: `apps/api/plane/app/views/music/internal.py` (InternalMusicTracksEndpoint
  con `artist_name`+`_filter_tracks`+`_compact_track`; InternalWorkspaceAssetsEndpoint;
  InternalMusicImportEndpoint modo read/import con dry_run reutilizando
  `MusicImportEndpoint._import_row` y `_read_table` sobre S3). URLs internas en
  `urls/music.py`. Proxy `apps/api/plane/app/views/assistant/base.py`
  (AssistantChatEndpoint streaming + AssistantModelsEndpoint; gating por
  FeatureKey FILE_LIBRARY/MUSIC_CATALOG; manda `capabilities` al worker).
  Helper `stream_assistant_chat` en `worker_client.py`. `urls/assistant.py`
  registrado. `manage.py check` OK.
- ✅ Worker: `src/assistant.ts` (streamText + 6 tools + stepCountIs(8) +
  toUIMessageStreamResponse; pickModel Gemini/DeepSeek desde env; system
  prompt gated por capabilities; `handleAssistantChat` async). Ruta
  `/assistant/chat` en `index.ts`. `internalApi` ahora expone `request`
  genérico. Deps: ai@7, @ai-sdk/google@4, @ai-sdk/deepseek@3, zod (catalog).
  `tsc --noEmit` y `wrangler deploy --dry-run` OK (sin nodejs_compat).
  Versiones finales: ai@6 (alineado al transport del cliente), @ai-sdk/google@3,
  @ai-sdk/deepseek@2.
- ✅ Web: `core/components/assistant/` (root con AssistantChatTransport →
  proxy Django + credentials include; thread.tsx con primitives; tool-uis.tsx
  con tabla de tracks, botón Excel → `/music/reports/?format=xlsx`, chips de
  contratos, card de import con botón "Aplicar importación" →
  `POST /assistant/music-import/`, card de update con botón PATCH). Ruta
  `/:workspaceSlug/assistant` en routes/core.ts. Paquetes:
  @assistant-ui/react@0.14 + @assistant-ui/react-ai-sdk@1.3.
- ✅ Django extra: `AssistantMusicImportEndpoint` (aplica el proposal con la
  sesión ADMIN del usuario, mismo importador determinista).
- ✅ Nav: item "assistant" en constants + icono Sparkles + filtros en
  sidebar-menu-items/extended-sidebar/customize-dialog + claves
  MUSIC_CATALOG y ASSISTANT en UserPreferenceKeys (el pin de music-catalog
  estaba silenciosamente roto igual que payments) + i18n sidebar.assistant y
  sidebar.music_catalog en/es + espejo (sync:check 100%).
- Verificado: tsc web/worker OK, wrangler dry-run OK, manage.py check OK,
  makemigrations --check sin cambios, smoke del endpoint interno de música
  (200 con secret + filtro artist_name; 403 sin secret).
- F2/F3 quedan cubiertos en v1 (import + update por chat); F4 pendiente:
  persistencia de hilos, attachments directos, selector de modelo, markdown
  renderer, import de PDF/imagen vía Textract.

## Riesgos y mitigaciones

- **SSE a través de gunicorn**: streams largos ocupan workers → timeout del
  proxy = 120s y `stepCountIs(8)`; si crece el uso, mover el endpoint del
  navegador directo al worker con token corto firmado por Django (diseño ya
  compatible).
- **Tool calling en DeepSeek**: `deepseek-chat` soporta function calling;
  `deepseek-reasoner` NO → el selector de modelos del asistente solo lista
  modelos tool-capable (gemini-2.x + deepseek-chat).
- **SheetJS en Workers**: `xlsx` es JS puro (sin fs) — validado en bundle;
  fallback: pedir CSV.
- **Tamaño de respuesta de tools**: `query_music_tracks` limita a 50 filas
  hacia el modelo (el Excel no tiene límite — usa el endpoint con filtros).
