# Relojes Indestructibles — panel de catálogo + IA

Panel para gestionar:

- **Catálogo de productos** con variantes (modelos) y galería de imágenes
- **Sincronización con OpenAI Vector Store** — cada producto es un archivo en el VS que el agente IA consulta vía `file_search`
- **Historias de Instagram** — asignar texto que el agente devuelve cuando un cliente responde a la story
- **Publicaciones de Instagram** — mismo concepto, asignar texto que el agente devuelve cuando alguien comenta el post
- **Consumo de OpenAI** con markup configurable

Todo persiste en Postgres (incluyendo las imágenes en BYTEA).

## Setup local

1. Instalar dependencias:
   ```
   npm install
   ```

2. Levantar Postgres local (Docker):
   ```
   docker run --name relojes-pg \
     -e POSTGRES_USER=relojes \
     -e POSTGRES_PASSWORD=secret \
     -e POSTGRES_DB=relojes \
     -p 5432:5432 -d postgres:17
   ```

3. Copiar `.env.example` a `.env` y completar:
   ```
   cp .env.example .env
   # editar .env
   ```

4. Arrancar el server:
   ```
   npm run dev
   ```

   Las migraciones SQL se aplican automáticamente al iniciar.

## Setup en easypanel

1. **Crear servicio Postgres** en el panel
2. **Crear servicio app** apuntando a este repo
3. **Variables de entorno**: completar todas las del `.env.example`
4. El server al iniciar corre las migraciones y queda listo

## Endpoints públicos (para el agente IA)

- `GET /imagenes/<slug>/<file>` — imagen del producto
- `GET /api/stories/<id>/text` — texto de una story
- `GET /api/posts/<id>/text` — texto de un post
- `PUT /api/{stories,posts}/<id>/text` — escritura con `X-API-Key`

## Stack

- Node 20+ · Express 4
- Postgres + `postgres` (pg.js)
- OpenAI SDK (Vector Stores)
- Meta Graph API
- Sharp (thumbs)
