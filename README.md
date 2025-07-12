# SmartPort-Lib

**SmartPort-Lib** es una librería de Node.js para gestionar y servir datos cacheados desde endpoints externos (APIs) de forma eficiente, diseñada específicamente para el sistema deportivo SmartPort. Esta herramienta permite manejar datos temporales con soporte para filtros, ordenamientos, búsquedas, paginación y almacenamiento local en disco.

---

## 🚀 Instalación

```bash
npm install smartport-lib
```

---

## 🔧 Uso básico

```js
const SmartPort = require('smartport-lib');

const cache = new SmartPort({
  ev: 'nac', // Evento por defecto
  apiUrl: 'https://api.smartportgms.com',
  endpoints: ['events', 'juegos', 'person', 'users', 'tourney']
});
```

---

## 📁 Estructura de parámetros

```js
new SmartPort({
  ev: 'nac', // Opcional. Evento por defecto (también puede venir de process.env)
  apiUrl: 'https://tu.api.url',
  endpoints: ['events', 'juegos', 'person'],
  cacheDir: './cache', // Carpeta donde se guardan los archivos JSON cacheados
  cacheDuration: 600000 // Duración del caché en milisegundos
});
```

---

## 🧩 Métodos principales

### `getData(endpoint, options)`
Obtiene datos desde el caché (o fuerza lectura desde archivo si no está cargado).

**`options:`**
- `ev`: string — evento a consultar
- `filter`: object — filtros MongoDB-like (`$in`, `$gt`, `$lt`, `$regex`, etc.)
- `sort`: string — campo y orden (`nombre:asc`, `fecha:desc`, `random`)
- `limit`: number — cantidad máxima de resultados
- `skip`: number — resultados a omitir
- `search`: string — búsqueda libre por todos los campos

---

### `updateCache(endpoint, params)`
Fuerza actualización del caché desde la API.

### `refresh(endpoint, params)`
Alias de `updateCache`.

### `getRouter()`
Devuelve un `express.Router()` con endpoints listos para usar:

```
/SmartPort/data/:alias
/SmartPort/update/:alias
/SmartPort/delete/:alias
/SmartPort/update-multiple?endpoint[]=a&endpoint[]=b
/SmartPort/delete-multiple?endpoint[]=a&endpoint[]=b
```

---

## 📦 Variables de entorno compatibles

Puedes usar `.env` para centralizar configuración:

```
SmartPort-ApiURL=https://api.smartportgms.com
SmartPort-ev=nac
SmartPort-Key=123456
```

---

## 🛡️ Seguridad (actualización/eliminación)

Las rutas `/update` y `/delete` exigen `?smartport-key=...` y se validan contra `process.env['SmartPort-Key']`.

---

## 🧪 Ejemplo en Express

```js
const express = require('express');
const SmartPort = require('smartport-lib');

const app = express();
const cache = new SmartPort({
  endpoints: ['events', 'juegos']
});

app.use('/SmartPort', cache.getRouter());

app.listen(3000, () => {
  console.log('Servidor SmartPort corriendo en http://localhost:3000');
});
```

---

## 📚 Filtros compatibles (`filter`)

La función `getData()` soporta filtros tipo MongoDB para arrays y objetos simples. Los disponibles son:

- `$in`: Coincide si el valor está incluido en el array.
  ```js
  { alias: { $in: ['TRU', 'SUC'] } }
  ```

- `$nin`: Coincide si el valor **no** está en el array.
  ```js
  { picture: { $nin: ['url1', 'url2'] } }
  ```

- `$gt` / `$lt`: Comparaciones numéricas o por fecha.
  ```js
  { edad: { $gt: 18 } }
  { date: { $lt: '2025-01-01' } }
  ```

- `$ne`: Coincide si el valor es diferente.
  ```js
  { tipo: { $ne: 'admin' } }
  ```

- `$regex`: Coincidencia parcial insensible a mayúsculas.
  ```js
  { nombre: { $regex: 'alberto' } }
  ```

- Fechas MongoDB (`$date`): Comparadas automáticamente con formato `YYYY-MM-DD` o `DD/MM/YYYY`.
  ```js
  { fechaNacimiento: { $lt: '01/01/2025' } }
  ```

> 🧠 También se detectan y comparan automáticamente campos tipo `ObjectId` (`$oid`) y fechas con estructura Mongo (`$date`).


---


## 👤 Autor

**Alberto Toro**  
GitHub: [@toroalbert](https://github.com/toroalbert)

---

## 🪪 Licencia

MIT
