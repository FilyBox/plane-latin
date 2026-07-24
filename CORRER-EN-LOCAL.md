# Cómo correr el proyecto en local (guía para principiantes)

Esta guía te lleva de cero a tener el proyecto corriendo en tu propia
computadora, **sin tocar la base de datos de producción**. Todo vive dentro de
Docker en tu máquina. No necesitas saber nada de Docker: copia y pega los
comandos en orden.

> **¿Qué es "correr en local"?** Levantas tu propia copia del sistema (base de
> datos, servidores, la web) en tu computadora. Es un patio de pruebas: puedes
> romper lo que quieras porque nada de esto toca a los usuarios reales.

---

## 1. Qué necesitas instalar (solo la primera vez)

Instala estas tres cosas antes de empezar.

### a) Docker Desktop

Es el programa que corre la base de datos y los servidores dentro de "cajas"
aisladas (contenedores) en tu máquina.

- Descárgalo de https://www.docker.com/products/docker-desktop/
- Instálalo y **ábrelo**. Espera a que el ícono de la ballena (arriba, en la
  barra del Mac) deje de animarse — eso significa que ya está listo.
- Docker Desktop tiene que estar **abierto** cada vez que trabajes en el
  proyecto. Si lo cierras, el proyecto se apaga.

### b) Node.js (versión 22.18 o mayor)

Es lo que corre la parte web.

- Descárgalo de https://nodejs.org/ (elige la versión "LTS").
- Para comprobar que quedó bien, abre la **Terminal** y escribe:
  ```bash
  node --version
  ```
  Debe decir `v22.18.0` o algo mayor.

### c) pnpm (el gestor de paquetes)

Node ya trae una herramienta llamada `corepack` que instala pnpm por ti. En la
Terminal:

```bash
corepack enable
```

Con eso queda. (El proyecto usa una versión específica de pnpm y `corepack` se
encarga de usar la correcta automáticamente.)

---

## 2. Preparar el proyecto (solo la primera vez)

Abre la **Terminal** y entra a la carpeta del proyecto. Si no sabes dónde está,
arrástrala a la ventana de Terminal después de escribir `cd ` (con espacio):

```bash
cd /ruta/a/plane-latin
```

Corre el script de preparación. Copia los archivos de configuración (`.env`) y
descarga las dependencias de la web:

```bash
./setup.sh
```

> **¿Qué hace esto?** Crea los archivos `.env` (que guardan claves y ajustes),
> genera una clave secreta para el servidor, y descarga las librerías de la web.
> Los archivos `.env` **no** se suben a git — son solo tuyos.

Si `./setup.sh` da un error de permisos, dale permiso de ejecución primero:

```bash
chmod +x setup.sh && ./setup.sh
```

---

## 3. Encender la base de datos y los servidores

Con **Docker Desktop abierto**, enciende los contenedores:

```bash
docker compose -f docker-compose-local.yml up -d
```

> **¿Qué levanta esto?**
>
> - `plane-db` — la base de datos (PostgreSQL)
> - `plane-redis` — memoria rápida / colas
> - `plane-mq` — cola de mensajes (RabbitMQ)
> - `plane-minio` — almacén de archivos (como un S3 local)
> - `api` — el servidor principal (Django)
> - `worker` / `beat-worker` — tareas en segundo plano
> - `migrator` — prepara la base de datos con las tablas necesarias
>
> La primera vez tarda varios minutos porque descarga y construye todo. Las
> siguientes veces es casi instantáneo.

Para ver que todo quedó "Up" (encendido):

```bash
docker compose -f docker-compose-local.yml ps
```

Todos deben decir `Up` (menos `migrator`, que corre una vez y se apaga — eso es
normal).

### Aplicar cambios de base de datos

Cada vez que traes cambios nuevos del equipo, puede que haya tablas nuevas que
crear. Corre esto (es seguro correrlo siempre, aunque no haya nada pendiente):

```bash
docker compose -f docker-compose-local.yml exec api python manage.py migrate
```

> **Señal de que lo necesitas:** si en los logs del `api` ves el mensaje
> _"Waiting for database migrations to complete"_ repetido, es exactamente esto.
> Corre el comando de arriba y el servidor arrancará.

---

## 4. Encender la web

La parte visual (lo que ves en el navegador) se corre aparte. En la Terminal,
desde la carpeta del proyecto:

```bash
pnpm dev --filter=web
```

> **Ojo con el orden de las palabras.** Usa `pnpm dev --filter=web` (con
> `--filter=web` al **final**). Ese comando construye primero las librerías
> internas que la web necesita y luego la enciende. Si lo escribes al revés,
> como `pnpm --filter web dev`, se salta ese paso y puede fallar en un equipo
> recién configurado.

Deja esa Terminal **abierta** — mientras corra, la web está viva. La primera vez
tarda un poco en compilar. Cuando veas algo como:

```
➜  Local:   http://localhost:3000/
```

ya está lista.

> **Consejo:** abre una **segunda pestaña de Terminal** para lo de Docker
> (comandos con `docker compose ...`) y deja la primera dedicada a `pnpm dev`.
> Así no tienes que apagar la web para correr otros comandos.

### Encender el panel de administración (god-mode) — opcional

El panel de administración (god-mode: donde activas las funciones por
workspace, subes la configuración de la instancia, etc.) es **otra app aparte**,
igual que la web. Solo la necesitas si vas a tocar ajustes de administrador.

Es el mismo patrón que la web, pero cambiando `web` por `admin`:

```bash
pnpm dev --filter=admin
```

Corre en un puerto distinto: **http://localhost:3001**. Déjala en su propia
Terminal, igual que la web.

> **Si sale "Port 3001 already in use":** otro programa ocupa ese puerto (a
> veces Grafana u otra herramienta). Ciérralo mientras trabajas con el admin, o
> revisa qué lo usa con `lsof -nP -iTCP:3001 -sTCP:LISTEN`.

---

## 5. Entrar por primera vez

Abre el navegador en:

```
http://localhost:3000
```

La primera vez el sistema te pedirá **crear una cuenta** (registro con correo y
contraseña) y **configurar la instancia**. Sigue los pasos en pantalla: creas tu
usuario, un espacio de trabajo (workspace), y listo.

### Direcciones útiles

| Para qué                           | Dirección             |
| ---------------------------------- | --------------------- |
| La app (lo que usas)               | http://localhost:3000 |
| Panel de administración (god-mode) | http://localhost:3001 |
| El servidor / API                  | http://localhost:8000 |
| Almacén de archivos (MinIO)        | http://localhost:9090 |

> El panel de administración solo está disponible si lo encendiste con
> `pnpm dev --filter=admin` (ver sección 4).

---

## 6. Apagar y volver a encender

**Para apagar** (al terminar de trabajar), en la Terminal de `pnpm dev` presiona
`Ctrl + C`. Luego, si quieres apagar también los contenedores:

```bash
docker compose -f docker-compose-local.yml stop
```

> `stop` apaga sin borrar nada — tus datos siguen ahí para la próxima vez.

**Para volver a encender** otro día (con Docker Desktop abierto):

```bash
docker compose -f docker-compose-local.yml start
pnpm dev --filter=web
```

---

## 7. Problemas comunes (y cómo resolverlos)

Estos son los tropiezos más frecuentes. Casi todo se arregla con uno de estos.

### "Cannot connect to the Docker daemon"

Docker Desktop no está abierto. Ábrelo, espera a que la ballena deje de
animarse, y vuelve a intentar.

### El `api` se queda en "Waiting for database migrations"

Faltan migraciones por aplicar. Corre:

```bash
docker compose -f docker-compose-local.yml exec api python manage.py migrate
```

### Cambié algo pero no se refleja en la web

El servidor de la web guarda cierta lógica en memoria. Un cambio en la lógica
interna (sobre todo de datos/estado) a veces **no** se aplica solo. Solución:
apaga la web con `Ctrl + C` en su Terminal y vuelve a correr
`pnpm dev --filter=web`.

### Cambié algo y en el navegador se ve viejo

El navegador guarda una copia en caché. Fuerza una recarga limpia con:

- Mac: `Cmd + Shift + R`
- Windows/Linux: `Ctrl + Shift + R`

### Sale "Looks like Plane didn't start up correctly" o "CORS error"

La web está corriendo pero **no alcanza a la API**. Casi siempre se arregla
**reiniciando el servidor de la web**: apaga con `Ctrl + C` en su Terminal y
vuelve a correr `pnpm dev --filter=web`. (La web "fija" la dirección de la API
al arrancar; si arrancó en mal momento, se queda apuntando mal hasta reiniciar.)

Antes de reiniciar la web, confirma que la API sí esté viva: abre
http://localhost:8000/api/instances/ en el navegador. Si responde con texto
(JSON), la API está bien y el problema es solo la web. Si **no** carga, primero
arregla la API (mira las dos entradas siguientes).

> **Nota:** un "CORS error" justo después de reconstruir o reiniciar la API es
> normal y pasajero — la API tarda unos segundos en levantar y el navegador
> pega en ese hueco. Espera a que http://localhost:8000/api/instances/ responda
> y recarga.

### La API no arranca / falta un módulo (`ModuleNotFoundError`)

En los logs del `api` ves algo como `ModuleNotFoundError: No module named '...'`.
Significa que alguien agregó una **dependencia nueva** (una librería) y tu imagen
de Docker es vieja, de antes de ese cambio. Reconstruye la imagen:

```bash
docker compose -f docker-compose-local.yml up -d --build api worker beat-worker
```

> **Regla general al traer cambios del equipo (`git pull`):**
>
> - Cambió **código** (Python) → basta reiniciar: `docker compose -f docker-compose-local.yml restart api`
> - Cambiaron **dependencias** (archivos `requirements/*.txt`) → reconstruye con `--build` (comando de arriba).
> - Cambiaron **tablas** (migraciones nuevas) → `docker compose -f docker-compose-local.yml exec api python manage.py migrate`
>
> Si dudas, hacer los tres es seguro y resuelve la mayoría de los problemas al
> actualizar.

### "Port 5432 already in use" (o 3000, 8000, 9000)

Ya tienes otro programa usando ese puerto — típicamente **otra base de datos
PostgreSQL instalada directamente en tu Mac** ocupa el 5432. Dos opciones:

1. Apaga ese otro programa mientras trabajas en el proyecto, o
2. Si es Postgres nativo del Mac: `brew services stop postgresql` (si lo
   instalaste con Homebrew) o cierra Postgres.app.

### Ver qué está fallando (los logs)

Para leer lo que dice un servicio (por ejemplo el `api`):

```bash
docker compose -f docker-compose-local.yml logs api --tail=50
```

Cambia `api` por `worker`, `plane-db`, etc. según lo que quieras revisar.

### Empezar de cero (borrar TODO lo local)

Si algo quedó irreparable y quieres reiniciar la base de datos local desde cero
(**se pierden todos tus datos de prueba**):

```bash
docker compose -f docker-compose-local.yml down -v
```

Luego vuelve al **paso 3**. La bandera `-v` borra los volúmenes (la base de
datos). Úsala solo cuando de verdad quieras empezar limpio.

---

## Resumen rápido (para cuando ya lo sepas)

```bash
# 1. Abre Docker Desktop (a mano)

# 2. Enciende los contenedores
docker compose -f docker-compose-local.yml up -d

# 3. Aplica migraciones (por si hay tablas nuevas)
docker compose -f docker-compose-local.yml exec api python manage.py migrate

# 4. Enciende la web (deja esta Terminal abierta)
pnpm dev --filter=web

# 5. Abre http://localhost:3000

# (Opcional) Panel de administración / god-mode, en otra Terminal:
pnpm dev --filter=admin   # http://localhost:3001
```

Nada de esto toca producción: todo corre contra la base de datos local dentro de
Docker en tu computadora.
