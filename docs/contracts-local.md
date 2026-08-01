# Contratos: entorno local

El flujo usa tres responsabilidades separadas:

- Plane conserva plantillas DOCX, variantes, revisiones, solicitudes y el PDF final.
- Collabora edita el DOCX mediante WOPI y lo convierte a PDF.
- Documenso recibe el PDF y los campos por su API OSS, envía correos, recoge firmas y sella el documento.

El editor embebido de Documenso no se utiliza: su documentación lo clasifica como Enterprise. El autorado vive en Plane y porta únicamente el flujo Community/AGPL documentado en `apps/remix`, `packages/ui` y `packages/lib`: destinatarios, diez tipos de campo, ajustes avanzados, orden de firma, correo, recordatorios, notificaciones y métodos de firma. No se modificó `CRM/packages/ee` ni se habilitaron sus funciones comerciales. El fork de Documenso conserva sus módulos opcionales de Enterprise tal como vienen en el proyecto original.

## Arranque

Los repositorios deben conservar esta disposición:

```text
seanalytics/
  plane-latin/
  CRM/
  libreoffice/
```

Desde `plane-latin`:

```powershell
docker compose -f docker-compose-local.yml -f docker-compose-contracts-local.yml --profile contracts up --build
```

Después inicia el frontend de Plane en otra terminal:

```powershell
pnpm.cmd dev
```

Servicios locales:

- Plane API: http://localhost:8000
- Plane web: http://localhost:3000
- Documenso: http://localhost:3004
- PostgreSQL de Documenso: `localhost:55432`
- Bandeja de correo de prueba: http://localhost:9005
- Collabora: http://localhost:9981
- MinIO: http://localhost:9000 (consola http://localhost:9090)

El seed de Documenso crea `admin@documenso.com` con contraseña `password`, el token local
`api_plane_local_development` y el webhook hacia Plane. Son credenciales exclusivas de desarrollo;
producción debe proporcionar secretos distintos.

## Prueba completa

1. En Plane abre `Archivos > Contratos > Crear y firmar`.
2. Sube una plantilla `.docx`.
3. Abre `Editar`, realiza cambios en Collabora y pulsa `Guardar`.
4. Crea variantes cuando un encabezado u otra presentación deba mantenerse por separado.
5. Pulsa `Configurar` sobre la variante y define los roles reutilizables (por ejemplo, Cliente y Representante), sus campos y los valores que podrán prellenarse. Guarda la plantilla.
6. Pulsa `Usar`, asigna un título y genera el PDF. Plane recupera el mapeo compatible y solo pide completar los nombres, correos y datos variables.
7. En el editor de tres pasos revisa destinatarios, arrastra o ajusta campos y personaliza asunto, mensaje, orden, recordatorios y métodos de firma. Las posiciones X/Y/ancho/alto son porcentajes de la página PDF.
8. En `Enviar documento` elige una distribución:
   - `Correo`: Documenso envía la invitación al SMTP local. En desarrollo el mensaje se captura en Inbucket y deliberadamente no llega a Gmail u otro proveedor público.
   - `Sin correo`: Documenso activa el sobre sin mandar mensajes y Plane muestra un enlace de firma individual para cada destinatario, con copia individual o masiva.
9. Para correo, abre el mensaje en Inbucket; para enlace, abre la URL copiada. Completa la firma.
10. El webhook descarga el PDF sellado al bucket `plane-contracts`, crea el contrato en Plane e inicia automáticamente el análisis de IA existente.

Si el webhook estuvo temporalmente inaccesible, pulsa `Sincronizar` en la solicitud pendiente.

## Variables

El overlay local inyecta:

```dotenv
CONTRACTS_S3_BUCKET_NAME=plane-contracts
COLLABORA_URL=http://localhost:9981
COLLABORA_INTERNAL_URL=http://collabora:9980
WOPI_HOST_URL=http://api:8000
DOCUMENSO_URL=http://localhost:3004
DOCUMENSO_INTERNAL_URL=http://documenso:3000
DOCUMENSO_API_TOKEN=api_plane_local_development
DOCUMENSO_WEBHOOK_SECRET=documenso-plane-local-secret
```

Documenso recibe además `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS=api` únicamente en este overlay. Esto permite que el webhook alcance el hostname privado de Plane dentro de Docker; no debe copiarse a producción cuando se use una URL pública HTTPS.

El bucket de contratos está separado del bucket general `uploads`. `storage_metadata.bucket` permite que las descargas, WOPI y el análisis de IA resuelvan el bucket correcto por archivo.

Los campos manuales guardados se reutilizan únicamente desde la versión de Word donde fueron configurados y cuando la geometría del PDF sigue siendo compatible. Si cambia el contenido fuente o la paginación, Plane evita copiar coordenadas potencialmente incorrectas.

## Variables dentro de Word

Plane detecta marcadores escritos directamente en párrafos, tablas, encabezados y pies de página del `.docx`. Pueden estar divididos entre varios segmentos de formato de Word.

Variables de personas:

```text
{{NombreFirmante1}}
{{CorreoFirmante1}}
{{FirmaFirmante1}}
{{InicialesFirmante1}}
{{FechaFirmaFirmante1}}
```

El número identifica al destinatario y puede crecer dinámicamente: `Firmante2`, `Firmante3`, etc. También están disponibles `Texto`, `Numero`, `Radio`, `Casilla`, `Lista`, `CampoNombre`, `CampoCorreo` y `CampoFecha`, seguidos de `FirmanteN`.

Cualquier otro marcador, por ejemplo `{{MontoTotal}}`, `{{FechaInicio}}` o `{{NombreEmpresa}}`, se convierte en una entrada del formulario. Plane sustituye estos valores en el Word antes de convertirlo, por lo que el texto se pagina como contenido nativo y no como una capa sobre el PDF.

Los marcadores de firma se sustituyen temporalmente, se localizan después de la conversión y se eliminan del PDF. Sus campos se regeneran aunque se agreguen párrafos o páginas.

Cada variante permite usar el Word actual o una versión inmutable anterior. Los campos colocados manualmente quedan asociados a la versión configurada. Si el Word cambia, Plane conserva las versiones anteriores, recalcula los campos semánticos y evita copiar coordenadas manuales incompatibles.

## Producción

Este overlay no despliega nada y no toca Railway. Antes de producción se deben sustituir todos los secretos, usar HTTPS para Plane/Collabora/Documenso, crear un bucket privado de contratos, configurar dominios públicos/internos y validar el webhook con un secreto fuerte.
