# SmartPort-Lib

Librería de caché inteligente y gestión de endpoints API para el sistema deportivo **SmartPort**.

## 🚀 Instalación

```bash
npm install smartport-lib
```

> ⚠️ Asegúrate de tener Node.js v16+ instalado.

## 📦 Uso básico

```js
const SmartPort = require('smartport-lib');

const smartCache = new SmartPort({
  ev: 'nac',
  apiUrl: 'https://api.smartportgms.com',
  endpoints: ['events', 'juegos', 'person', 'users', 'tourney']
});

smartCache.getData('juegos', { ev: 'nac' }).then(data => {
  console.log('Juegos del evento:', data);
});
```

## 📁 Métodos disponibles

### `getData(endpoint, options)`
- `ev`: Evento (ej. `nac`, `para`, etc.)
- `filter`, `sort`, `limit`, `skip`, `search`: Parámetros opcionales para filtrado avanzado

### `updateCache(endpoint, params)`
Actualiza manualmente el caché para un endpoint.

### `refresh(endpoint, params)`
Alias directo de `updateCache`.

### `getRouter()`
Devuelve un `express.Router()` con rutas para `/data`, `/update`, `/delete`, etc.

## 🔐 Variables de entorno requeridas (`.env`)

```
SmartPort-ApiURL=https://api.smartportgms.com
SmartPort-ev=nac
SmartPort-Key=123456
```

## 🧠 Autor

Desarrollado por **Alberto Toro**  
GitHub: [@toroalbert](https://github.com/toroalbert)

## 🪪 Licencia

MIT
