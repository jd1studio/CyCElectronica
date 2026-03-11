# AppCyC — Sincronización de Inventarios SIESA → Shopify

Aplicación embebida de Shopify que sincroniza automáticamente el inventario desde el ERP **SIESA** hacia una tienda Shopify, usando un cron job configurable.

---

## ¿Qué hace?

- Consulta el inventario disponible desde la API de SIESA Cloud
- Actualiza las cantidades de inventario en Shopify vía Admin GraphQL API
- Ejecuta la sincronización automáticamente según un horario configurable (por defecto cada 3 horas)
- Registra logs diarios de cada sincronización
- Muestra el estado del último sync en el panel de administración de Shopify

---

## Tecnologías

- [React Router v7](https://reactrouter.com/) — Framework fullstack (SSR + cliente)
- [Shopify App React Router](https://shopify.dev/docs/api/shopify-app-react-router) — SDK oficial de Shopify
- [Prisma](https://www.prisma.io/) + SQLite — Base de datos para sesiones y estado del sync
- [node-cron](https://github.com/kelektiv/node-cron) — Scheduler para sincronización automática
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components) — UI embebida en Shopify Admin

---

## Requisitos

- Node.js 20+
- Cuenta en [Shopify Partners](https://partners.shopify.com/)
- Credenciales de acceso a la API de SIESA Cloud
- Shopify CLI (`npm install -g @shopify/cli`)

---

## Variables de entorno

Copiar `.env.example` a `.env` y rellenar los valores:

| Variable | Descripción |
|----------|-------------|
| `SHOPIFY_API_KEY` | API Key de la app en el Partner Dashboard |
| `SHOPIFY_API_SECRET` | API Secret de la app |
| `SHOPIFY_APP_URL` | URL pública de la app (ej: `https://api.tudominio.com`) |
| `SCOPES` | Permisos de Shopify requeridos |
| `CLIENT_ID` | Client ID de autenticación SIESA |
| `CONNIKEY` | Header de autenticación SIESA |
| `CONNITOKEN` | Token de autenticación SIESA |
| `URLSIESAINV` | URL del endpoint de inventarios SIESA |
| `IDCOMPANIA` | ID de compañía en SIESA |
| `DESCRIPCION` | Nombre del reporte de inventarios en SIESA |
| `PAGINACION` | Parámetros de paginación SIESA |
| `PARAMETROS` | Filtros SQL para la consulta SIESA |
| `IDLOCATION` | GID de la ubicación/bodega en Shopify |
| `SYNC_CRON` | Expresión cron para la sincronización (default: `0 */3 * * *`) |
| `NODE_ENV` | Entorno de ejecución (`production` en servidor) |

---

## Comandos

```bash
# Desarrollo local
npm run dev

# Build de producción
npm run build

# Iniciar servidor de producción
npm run start

# Configurar base de datos (primera vez o tras cambios de esquema)
npm run setup

# Lint
npm run lint

# Verificación de tipos
npm run typecheck

# Desplegar configuración a Shopify
npm run deploy
```

---

## Estructura principal

```
app/
├── shopify.server.ts       # Configuración central del SDK de Shopify
├── db.server.ts            # Cliente Prisma (singleton)
├── cron/
│   └── sync.server.ts      # Cron job de sincronización + limpieza de logs
├── services/
│   ├── siesa.server.ts     # Integración con la API de SIESA
│   └── logger.server.ts    # Logger de sincronizaciones
└── routes/
    ├── app.tsx             # Layout principal (autenticación)
    ├── app._index.tsx      # Panel de estado del sync
    └── app.sync.tsx        # Endpoint para sync manual
prisma/
└── schema.prisma           # Esquema SQLite (Session + SyncEstado)
```

---

## Base de datos

La app usa **SQLite** con dos tablas:

| Tabla | Propósito |
|-------|-----------|
| `Session` | Token OAuth de la tienda Shopify (requerido para el cron) |
| `SyncEstado` | Estado actual y último resultado de la sincronización |

La sesión se crea automáticamente cuando el cliente instala la app en su tienda Shopify.
