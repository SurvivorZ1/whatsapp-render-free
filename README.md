# WhatsApp Bot gratis en Render + panel PHP en tu hosting

Esta versión está pensada para lo que pediste:

- **Node.js en Render Free**
- **panel/admin en PHP** en tu hosting actual
- **sin plan pagado**
- **sesiones de WhatsApp guardadas fuera de Render** usando **MongoDB Atlas**
- **keepalive** desde tu hosting con cron para que Render no se duerma

## Arquitectura

1. **Render Free** corre `server.js`.
2. **MongoDB Atlas** guarda:
   - sesiones de WhatsApp (RemoteAuth)
   - agentes
   - historial básico
3. **Tu hosting PHP** sirve:
   - `php-panel/index.php`
   - `php-panel/api.php`
   - `php-panel/keepalive.php`
4. **Cron de Hostinger** llama `keepalive.php` cada 10 minutos.

## Por qué esta versión sí funciona en free

Render Free:
- se duerme si no recibe tráfico por 15 minutos
- no tiene disco persistente

Por eso aquí:
- **NO** usamos `LocalAuth`
- **SÍ** usamos `RemoteAuth + MongoDB`
- **SÍ** usamos un cron externo para mantener el servicio activo

## 1) Crear MongoDB Atlas

Crea un clúster gratuito y obtén tu `MONGODB_URI`.

Base sugerida:

```text
whatsapp_bot
```

## 2) Subir a GitHub

Sube esta carpeta como un repositorio nuevo.

## 3) Deploy en Render

### Opción A: Blueprint
Sube el repo y deja que Render lea `render.yaml`.

### Opción B: manual
Crea un **Web Service** con:

- Runtime: Docker
- Plan: Free
- Branch: main
- Health check path: `/health`

Variables de entorno obligatorias:

- `APP_URL=https://tu-app.onrender.com`
- `APP_TOKEN=un-token-largo-y-seguro`
- `OPENAI_API_KEY=...`
- `MONGODB_URI=...`
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable`
- `HEADLESS=true`

## 4) Configurar el panel PHP

Dentro de `php-panel/`:

1. copia `config.example.php` como `config.php`
2. edita:

```php
<?php
define('NODE_API_URL', 'https://tu-app.onrender.com');
define('APP_TOKEN', 'el-mismo-token-de-render');
?>
```

3. sube `php-panel/` a tu hosting

## 5) Configurar keepalive en Hostinger

Crea un cron cada **10 minutos** apuntando a:

```text
https://tu-dominio.com/ruta-del-panel/keepalive.php
```

Si tu hosting permite comando en vez de URL, también puedes usar algo como esto:

```bash
wget -q -O - https://tu-app.onrender.com/health
```

## 6) Primer arranque

1. abre tu panel PHP
2. crea una sesión: `ventas`, `soporte`, etc.
3. espera el QR
4. escanea con WhatsApp Business
5. deja el servicio activo algunos minutos para que `RemoteAuth` alcance a sincronizar la sesión a MongoDB

## Rutas útiles

### En Render
- `/health`
- `/app` → panel web directo del Node (opcional)
- `/api/agents`

### En PHP
- `index.php`
- `api.php`
- `keepalive.php`

## Limitaciones reales de esta solución gratis

- si el cron falla, Render se dormirá
- si Render reinicia, el bot tardará un poco en volver a levantar
- mientras el servicio esté dormido, no responderá mensajes
- no es la arquitectura ideal para producción crítica

## Recomendación práctica

Para comenzar gratis, esta es la forma más estable dentro de las limitaciones:

- Render Free
- MongoDB Atlas Free
- panel PHP en tu hosting
- cron cada 10 minutos desde Hostinger

Cuando ya quieras algo más serio, el siguiente paso natural es:

- Render Starter o VPS
- o migrar a la API oficial de WhatsApp Business
