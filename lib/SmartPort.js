// SmartPort.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const FormData = require('form-data');

class SmartPort {
    constructor({ ev, apiUrl, endpoints, token, cacheDir = './cache', cacheDuration = 600000 }) {
        this.apiUrl = apiUrl || process.env['SmartPort-ApiURL'] || '';
        this.endpoints = endpoints;
        this.token = token || process.env['SmartPort-Token'] || null;
        this.cacheDir = cacheDir;
        this.cacheDuration = cacheDuration;
        this.cache = {};
        this.defaultEv = ev || process.env['SmartPort-ev'] || 'undefined';
        this.initCache(this.defaultEv);
    }

    async initCache(ev = 'undefined') {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        for (const endpoint of this.endpoints) {
            if (!this.cache[ev]) this.cache[ev] = {};
            this.cache[ev][endpoint] = { data: [], timestamp: 0 };
            await this.loadFromStorage(endpoint, ev);
        }
    }

    _buildHeaders(token, contentType) {
        const headers = {};
        if (contentType) headers['Content-Type'] = contentType;
        const tk = token || this.token;
        if (tk) {
            headers['Authorization'] = 'Basic ' + Buffer.from(tk).toString('base64');
        }
        return headers;
    }

    async fetchFromAPI(endpoint, params = {}, { token, method = 'GET', body, files } = {}) {
        try {
            if (!params.ev) params.ev = this.defaultEv;
            const fetch = (await import('node-fetch')).default;
            const url = new URL(`${this.apiUrl}/${endpoint}`);

            const fetchOptions = { method };

            if (method === 'GET') {
                fetchOptions.headers = this._buildHeaders(token);
                Object.entries(params).forEach(([key, value]) => {
                    url.searchParams.append(key, value);
                });
            } else if (files && Object.keys(files).length > 0) {
                // Multipart: archivos + campos POST
                const form = new FormData();
                const data = body ?? params;
                for (const [key, val] of Object.entries(data)) {
                    if (val !== undefined && val !== null) {
                        form.append(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
                    }
                }
                for (const [key, filePath] of Object.entries(files)) {
                    if (Array.isArray(filePath)) {
                        for (const fp of filePath) {
                            form.append(key, fs.createReadStream(fp), path.basename(fp));
                        }
                    } else {
                        form.append(key, fs.createReadStream(filePath), path.basename(filePath));
                    }
                }
                const tk = token || this.token;
                const authHeaders = tk ? { 'Authorization': 'Basic ' + Buffer.from(tk).toString('base64') } : {};
                fetchOptions.headers = { ...form.getHeaders(), ...authHeaders };
                fetchOptions.body = form;
            } else {
                // POST sin archivos: form-encoded
                const formData = new URLSearchParams();
                const data = body ?? params;
                for (const [key, val] of Object.entries(data)) {
                    if (val !== undefined && val !== null) {
                        formData.append(key, typeof val === 'object' ? JSON.stringify(val) : val);
                    }
                }
                fetchOptions.headers = this._buildHeaders(token, 'application/x-www-form-urlencoded');
                fetchOptions.body = formData.toString();
            }

            console.log("URL: " + url);
            const response = await fetch(url.toString(), fetchOptions);

            if (method !== 'GET') {
                // POST: siempre leer el body (puede tener mensaje de error útil)
                const json = await response.json();
                if (!response.ok) json._status = response.status;
                return json;
            }

            if (!response.ok) throw new Error(`Error en ${endpoint}`);
            return await response.json();
        } catch (error) {
            console.error(`Error obteniendo datos de ${endpoint}:`, error);
            return null;
        }
    }

    async postToAPI(endpoint, body = {}, { token, files } = {}) {
        return this.fetchFromAPI(endpoint, {}, { token, method: 'POST', body, files });
    }

    // Genera ruta de archivo basada en segmentos del endpoint (mantiene subcarpetas)
    getFilePathForEndpoint(endpoint, ev = 'undefined') {
        const segments = String(endpoint).split('/').filter(s => s.length > 0).map(s => s.replace(/\W/g, '_'));
        const dir = segments.length > 1
            ? path.join(this.cacheDir, ev, ...segments.slice(0, -1))
            : path.join(this.cacheDir, ev);
        const filename = (segments.length ? segments[segments.length - 1] : String(endpoint).replace(/\W/g, '_')) + '.json';
        const filePath = path.join(dir, filename);
        return { dir, filePath };
    }

    saveToStorage(endpoint, ev = 'undefined') {
        const { dir, filePath } = this.getFilePathForEndpoint(endpoint, ev);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        let toTransform = this.cache[ev]?.[endpoint]?.data?.answer ?? this.cache[ev]?.[endpoint]?.data ?? this.cache[ev]?.[endpoint];
        fs.writeFileSync(filePath, JSON.stringify(toTransform, null, 2));
    }

    loadFromStorage(endpoint, ev = 'undefined') {
        const { filePath } = this.getFilePathForEndpoint(endpoint, ev);
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!this.cache[ev]) this.cache[ev] = {};
            this.cache[ev][endpoint] = {
                data, // permite objeto o array
                timestamp: Date.now()
            };
        }
    }

    async updateCache(endpoint, params = {}) {
        const ev = params.ev || this.defaultEv || 'undefined';
        const data = await this.fetchFromAPI(endpoint, params);
        if (data) {
            if (!this.cache[ev]) this.cache[ev] = {};
            this.cache[ev][endpoint] = { data: data.answer ?? data, timestamp: Date.now() };
            this.saveToStorage(endpoint, ev);
        }
    }

    async refresh(endpoint, params = {}) {
        await this.updateCache(endpoint, params);
    }

    // Actualiza un solo documento (por _id) dentro del JSON cacheado y persiste en disco
    async updateDocument(endpoint, id, updateObj = {}, params = {}) {
        const ev = params.ev || this.defaultEv || 'undefined';

        // Asegurar que la entrada está cargada
        this.loadFromStorage(endpoint, ev);
        if (!this.cache[ev]) this.cache[ev] = {};
        const entry = this.cache[ev][endpoint];
        if (!entry || !Array.isArray(entry.data)) {
            return { success: false, error: 'No hay datos tipo array para este endpoint' };
        }

        const arr = entry.data;
        const idx = arr.findIndex(item => {
            if (!item) return false;
            const _id = item._id ?? item.id ?? null;
            if (!_id) return false;
            if (typeof _id === 'object' && _id.$oid) return String(_id.$oid) === String(id);
            return String(_id) === String(id);
        });

        if (idx === -1) return { success: false, error: 'Documento no encontrado' };

        const existing = arr[idx];
        const merged = Object.assign({}, existing, updateObj);
        arr[idx] = merged;
        this.cache[ev][endpoint].timestamp = Date.now();
        this.saveToStorage(endpoint, ev);

        return { success: true, item: merged };
    }

    async getData(endpoint, { ev = "undefined", limit, skip = 0, sort, filter, search } = {}) {
        if (!this.cache[ev] || !this.cache[ev][endpoint]) {
            // this.loadFromStorage(endpoint, ev);
            this.loadFromStorage(endpoint, ev);
            // 🔁 Si aún así no existe, forzar actualización desde API
            if (!this.cache[ev]?.[endpoint]) {
                try {
                    // await this.initCache(ev);
                    await this.refresh(endpoint, {
                        ev,
                        // 'smartport-key': process.env['SmartPort-Key']
                    });

                    // Volver a intentar cargar desde disco
                    this.loadFromStorage(endpoint, ev);
                } catch (err) {
                    console.error(`⚠️ Error forzando refresh de ${endpoint}:`, err.message);
                }
            }
        }

        const cached = this.cache[ev]?.[endpoint];
        if (!cached || !cached.data) return [];

        // let result = Array.isArray(cached.data)
        //     ? [...cached.data]
        //     : Object.values(cached.data);

        let result = cached.data; // puede ser array o objeto

        if (Array.isArray(result)) {
            if (filter) {
                if (filter.$or && Array.isArray(filter.$or)) {
                    result = result.filter(item =>
                        filter.$or.some(cond =>
                            Object.entries(cond).every(([key, val]) => {
                                const fieldVal = item[key];

                                // 🔍 Si no existe ese campo, no pasa
                                if (typeof fieldVal === 'undefined') return false;

                                // 🎯 Soporte para condiciones tipo { key: { $op: val } }
                                if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                                    return Object.entries(val).every(([op, v]) => {
                                        let compareVal = fieldVal;
                                        if (compareVal?.$date?.$numberLong) compareVal = parseInt(compareVal.$date.$numberLong);
                                        if (compareVal?.$oid) compareVal = compareVal.$oid;

                                        switch (op) {
                                            case '$in': return Array.isArray(v) && v.map(String).includes(String(compareVal));
                                            case '$ne': return compareVal != v;
                                            case '$regex': return new RegExp(v, 'i').test(compareVal);
                                            default: return compareVal == v;
                                        }
                                    });
                                }

                                // 👇 Comparación directa
                                if (fieldVal?.$oid) return fieldVal.$oid == val;
                                if (typeof fieldVal === 'object' && '$date' in fieldVal)
                                    return new Date(parseInt(fieldVal.$date.$numberLong)).getTime() == new Date(val).getTime();

                                return String(fieldVal) == String(val);
                            })
                        )
                    );

                    delete filter.$or;
                }

                result = result.filter(item =>
                    Object.entries(filter).every(([key, condition]) => {
                        // if(key == 'smartport-key') return;
                        const fieldVal = item[key];
                        if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
                            return Object.entries(condition).every(([op, val]) => {
                                let compareVal = fieldVal;
                                if (fieldVal?.$date?.$numberLong) {
                                    compareVal = parseInt(fieldVal.$date.$numberLong);
                                }
                                if (fieldVal?.$oid) {
                                    compareVal = fieldVal.$oid;
                                }
                                if ((op === '$gt' || op === '$lt') && typeof compareVal === 'number' && typeof val === 'string') {
                                    if (val.includes('/')) {
                                        const [day, month, year] = val.split('/');
                                        val = new Date(`${year}-${month}-${day}`).getTime();
                                    } else {
                                        val = new Date(val).getTime();
                                    }
                                }
                                switch (op) {
                                    case '$in':
                                        return Array.isArray(val) && val.map(v => String(v)).includes(String(compareVal));
                                    case '$gt':
                                        return compareVal > val;
                                    case '$lt':
                                        return compareVal < val;
                                    case '$regex':
                                        return new RegExp(val, 'i').test(compareVal);
                                    case '$ne':
                                        return compareVal !== val && compareVal != null;
                                    case '$nin':
                                        return Array.isArray(val) && !val.map(v => String(v)).includes(String(compareVal));

                                }
                            });
                        }

                        if (typeof condition === 'string') {
                            if (typeof fieldVal === 'string') return fieldVal.startsWith(condition);
                            if (Array.isArray(fieldVal)) return fieldVal.some(v => v.startsWith(condition));
                            if (typeof fieldVal === 'object') {
                                if ('$oid' in fieldVal) return fieldVal.$oid === condition;
                                if (fieldVal?.$date?.$numberLong) {
                                    const itemDate = new Date(parseInt(fieldVal.$date.$numberLong));
                                    let inputDate;
                                    if (condition.includes('/')) {
                                        const [day, month, year] = condition.split('/');
                                        inputDate = new Date(`${year}-${month}-${day}`);
                                    } else {
                                        inputDate = new Date(condition);
                                    }
                                    return (
                                        itemDate.getUTCFullYear() === inputDate.getUTCFullYear() &&
                                        itemDate.getUTCMonth() === inputDate.getUTCMonth() &&
                                        itemDate.getUTCDate() === inputDate.getUTCDate()
                                    );
                                }
                            }
                        }

                        // return fieldVal === condition;
                        return fieldVal == condition;

                    })
                );
            }

            if (sort) {
                const [key, dir] = sort.split(':');
                const order = dir?.toLowerCase();
                if (order === 'random') {
                    result.sort(() => Math.random() - 0.5);
                } else {
                    const sortOrder = order === 'desc' ? 'desc' : 'asc';
                    result.sort((a, b) => {
                        let aVal = a[key];
                        let bVal = b[key];

                        if (aVal?.$date?.$numberLong) aVal = parseInt(aVal.$date.$numberLong);
                        if (bVal?.$date?.$numberLong) bVal = parseInt(bVal.$date.$numberLong);

                        // Si son strings, quitar espacios al inicio y final
                        if (typeof aVal === 'string') aVal = aVal.trim();
                        if (typeof bVal === 'string') bVal = bVal.trim();

                        if (typeof aVal === 'string' && typeof bVal === 'string') {
                            return sortOrder === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
                        }

                        return sortOrder === 'desc' ? (bVal > aVal ? 1 : -1) : (aVal > bVal ? 1 : -1);
                    });
                }
            }


            if (search) {
                const terms = search.toLowerCase().split(/\s+/);
                result = result.filter(item => {
                    const searchable = Object.values(item).flatMap(val => {
                        if (typeof val === 'string') return val.toLowerCase();
                        if (typeof val === 'number') return val.toString();
                        if (val?.$oid) return val.$oid;
                        if (val?.$date?.$numberLong) {
                            const d = new Date(parseInt(val.$date.$numberLong));
                            return [d.toISOString().slice(0, 10), `${d.getUTCDate().toString().padStart(2, '0')}/${(d.getUTCMonth() + 1).toString().padStart(2, '0')}/${d.getUTCFullYear()}`];
                        }
                        try {
                            return JSON.stringify(val).toLowerCase();
                        } catch {
                            return '';
                        }
                    });
                    return terms.every(term => searchable.some(field => field.includes(term)));
                });
            }

            if (skip || limit) {
                const start = skip || 0;
                const end = limit ? start + limit : undefined;
                result = result.slice(start, end);
            }
        }
        return result;
    }

    async getCount(endpoint, { ev = "undefined", filter, search } = {}) {
        if (!this.cache[ev] || !this.cache[ev][endpoint]) {
            this.loadFromStorage(endpoint, ev);

            if (!this.cache[ev]?.[endpoint]) {
                try {
                    await this.refresh(endpoint, { ev });
                    this.loadFromStorage(endpoint, ev);
                } catch (err) {
                    console.error(`⚠️ Error forzando refresh de ${endpoint}:`, err.message);
                    return 0;
                }
            }
        }

        const cached = this.cache[ev]?.[endpoint];
        if (!cached || !cached.data || !Array.isArray(cached.data)) return 0;

        let result = cached.data;

        // 🔎 aplicar filtros igual que en getData()
        if (filter) {
            if (filter.$or && Array.isArray(filter.$or)) {
                result = result.filter(item =>
                    filter.$or.some(cond =>
                        Object.entries(cond).every(([key, val]) => {
                            const fieldVal = item[key];

                            // 🔍 Si no existe ese campo, no pasa
                            if (typeof fieldVal === 'undefined') return false;

                            // 🎯 Soporte para condiciones tipo { key: { $op: val } }
                            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                                return Object.entries(val).every(([op, v]) => {
                                    let compareVal = fieldVal;
                                    if (compareVal?.$date?.$numberLong) compareVal = parseInt(compareVal.$date.$numberLong);
                                    if (compareVal?.$oid) compareVal = compareVal.$oid;

                                    switch (op) {
                                        case '$in': return Array.isArray(v) && v.map(String).includes(String(compareVal));
                                        case '$ne': return compareVal != v;
                                        case '$regex': return new RegExp(v, 'i').test(compareVal);
                                        default: return compareVal == v;
                                    }
                                });
                            }

                            // 👇 Comparación directa
                            if (fieldVal?.$oid) return fieldVal.$oid == val;
                            if (typeof fieldVal === 'object' && '$date' in fieldVal)
                                return new Date(parseInt(fieldVal.$date.$numberLong)).getTime() == new Date(val).getTime();

                            return String(fieldVal) == String(val);
                        })
                    )
                );

                delete filter.$or;
            }

            result = result.filter(item =>
                Object.entries(filter).every(([key, condition]) => {
                    const fieldVal = item[key];
                    if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
                        return Object.entries(condition).every(([op, val]) => {
                            let compareVal = fieldVal;
                            if (fieldVal?.$date?.$numberLong) compareVal = parseInt(fieldVal.$date.$numberLong);
                            if (fieldVal?.$oid) compareVal = fieldVal.$oid;
                            switch (op) {
                                case '$in':
                                    return Array.isArray(val) && val.map(v => String(v)).includes(String(compareVal));
                                case '$gt':
                                    return compareVal > val;
                                case '$lt':
                                    return compareVal < val;
                                case '$regex':
                                    return new RegExp(val, 'i').test(compareVal);
                                case '$ne':
                                    return compareVal !== val && compareVal != null;
                                case '$nin':
                                    return Array.isArray(val) && !val.map(v => String(v)).includes(String(compareVal));

                            }
                        });
                    }
                    if (typeof condition === 'string') {
                        if (typeof fieldVal === 'string') return fieldVal.startsWith(condition);
                        if (Array.isArray(fieldVal)) return fieldVal.some(v => v.startsWith(condition));
                        if (typeof fieldVal === 'object') {
                            if ('$oid' in fieldVal) return fieldVal.$oid === condition;
                            if (fieldVal?.$date?.$numberLong) {
                                const itemDate = new Date(parseInt(fieldVal.$date.$numberLong));
                                const [day, month, year] = condition.includes('/') ? condition.split('/') : [null];
                                const inputDate = condition.includes('/') ? new Date(`${year}-${month}-${day}`) : new Date(condition);
                                return (
                                    itemDate.getUTCFullYear() === inputDate.getUTCFullYear() &&
                                    itemDate.getUTCMonth() === inputDate.getUTCMonth() &&
                                    itemDate.getUTCDate() === inputDate.getUTCDate()
                                );
                            }
                        }
                    }
                    return fieldVal == condition;
                })
            );
        }

        if (search) {
            const terms = search.toLowerCase().split(/\s+/);
            result = result.filter(item => {
                const searchable = Object.values(item).flatMap(val => {
                    if (typeof val === 'string') return val.toLowerCase();
                    if (typeof val === 'number') return val.toString();
                    if (val?.$oid) return val.$oid;
                    if (val?.$date?.$numberLong) {
                        const d = new Date(parseInt(val.$date.$numberLong));
                        return [d.toISOString().slice(0, 10), `${d.getUTCDate().toString().padStart(2, '0')}/${(d.getUTCMonth() + 1).toString().padStart(2, '0')}/${d.getUTCFullYear()}`];
                    }
                    try {
                        return JSON.stringify(val).toLowerCase();
                    } catch {
                        return '';
                    }
                });
                return terms.every(term => searchable.some(field => field.includes(term)));
            });
        }

        return result.length;
    }

    /**
     * Consulta datos directamente desde el API (sin caché local).
     * Misma firma que getData: getAPI(endpoint, { ev, limit, skip, sort, filter, search })
     */
    async getAPI(endpoint, { ev, limit, skip, sort, filter, search, token } = {}) {
        const params = {};
        params.ev = ev || this.defaultEv;
        if (limit != null) params.limit = limit;
        if (skip) params.skip = skip;
        if (sort) {
            const [field, dir] = sort.split(':');
            params.sort = field;
            params.order = dir?.toLowerCase() === 'asc' ? 1 : -1;
        }
        if (search) params.search = search;
        if (filter && typeof filter === 'object') {
            for (const [key, val] of Object.entries(filter)) {
                if (typeof val === 'object' && val !== null) {
                    params[key] = JSON.stringify(val);
                } else {
                    params[key] = val;
                }
            }
        }
        const data = await this.fetchFromAPI(endpoint, params, { token });
        if (!data) return [];
        return data.answer ?? data;
    }

    async postAPI(endpoint, body = {}, { ev, token, files } = {}) {
        if (!body.ev) body.ev = ev || this.defaultEv;
        const data = await this.postToAPI(endpoint, body, { token, files });
        if (!data) return [];
        return data.answer ?? data;
    }


    parseQueryToFilter(query) {
        console.log("query", query);
        const filter = {};

        for (const key in query) {
            const val = query[key];
            console.log(key, val);

            // 🔍 Detectar si ya viene parseado como objeto con operadores
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                filter[key] = {};

                for (const op in val) {
                    const opVal = val[op];
                    if (op === '$in') {
                        if (Array.isArray(opVal)) {
                            filter[key][op] = opVal;
                        } else if (typeof opVal === 'string' && opVal.includes(',')) {
                            filter[key][op] = opVal.split(',');
                        } else {
                            filter[key][op] = [opVal];
                        }
                    } else {
                        filter[key][op] = opVal;
                    }
                }

                continue;
            }

            // 🔁 Compatibilidad con alias[]=TRU&alias[]=SUC → $in implícito
            if (Array.isArray(val)) {
                filter[key] = { $in: val };
                continue;
            }

            // 🔚 Filtro directo
            filter[key] = val;
        }

        return filter;
    }

    getRouter() {
        // const express = require('express');
        const router = express.Router();

        // 🚫 Middleware para evitar caché desde el navegador
        router.use((req, res, next) => {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
            next();
        });

        const deleteAndLog = (alias, ev) => {
            const { filePath } = this.getFilePathForEndpoint(alias, ev);
            const existed = fs.existsSync(filePath);
            try {
                if (existed) fs.unlinkSync(filePath);
                if (this.cache[ev] && this.cache[ev][alias]) {
                    delete this.cache[ev][alias];
                }
                return { alias, existed, success: true };
            } catch (err) {
                return { alias, existed, success: false, error: err.message };
            }
        };

        const handleDelete = (req, res, alias) => {
            const queryParams = req.query;
            const ev = queryParams.ev || this.defaultEv;

            const clientKey = queryParams['smartport-key'];
            const expectedKey = process.env['SmartPort-Key'];
            delete queryParams['smartport-key'];

            if (!expectedKey || clientKey !== expectedKey) {
                return res.status(403).json({ success: false, error: 'Clave no válida para eliminación de caché.' });
            }

            const result = deleteAndLog(alias, ev);
            if (result.success) {
                res.json({ success: true, message: `Cache eliminado: ${alias}`, existed: result.existed });
            } else {
                res.status(500).json({ success: false, error: result.error });
            }
        };

        const handleDeleteMultiple = (req, res) => {
            const queryParams = req.query;
            const ev = queryParams.ev || this.defaultEv;
            console.log('query', req.query);
            // return;
            const clientKey = queryParams['smartport-key'];
            const expectedKey = process.env['SmartPort-Key'];
            delete queryParams['smartport-key'];

            const endpoints = queryParams.endpoint;

            if (!expectedKey || clientKey !== expectedKey) {
                return res.status(403).json({ success: false, error: 'Clave no válida para eliminación múltiple.' });
            }

            if (!endpoints || !Array.isArray(endpoints)) {
                return res.status(400).json({ success: false, error: 'Se esperaba endpoint[]=alias1&endpoint[]=alias2' });
            }

            // ✅ Eliminar de memoria
            if (!this.cache[ev]) this.cache[ev] = {};
            for (const alias of endpoints) {
                const clean = alias.trim();
                delete this.cache[ev][clean];
            }

            const resultados = endpoints.map((aliasRaw) => {
                const alias = aliasRaw.trim();
                return deleteAndLog(alias, ev);
            });

            res.json({ success: true, deleted: resultados });
        };

        // 🟥 Rutas segmentadas para /delete
        router.get('/delete/:alias', (req, res) =>
            handleDelete(req, res, req.params.alias)
        );

        router.get('/delete/:alias/:extra', (req, res) =>
            handleDelete(req, res, `${req.params.alias}/${req.params.extra}`)
        );

        router.get('/delete/:alias/:extra/:id', (req, res) =>
            handleDelete(req, res, `${req.params.alias}/${req.params.extra}/${req.params.id}`)
        );

        // 🟥 Ruta para eliminación múltiple por GET
        router.get('/delete-multiple', handleDeleteMultiple);

        // ⏫ Handler compartido para actualizar caché
        // const handleUpdate = async (req, res, alias) => {
        //     const queryParams = req.query;
        //     const ev = queryParams.ev || this.defaultEv;

        //     console.log('🔁 Actualizando cache');
        //     console.log('🧩 Alias:', alias);
        //     console.log('📦 Evento:', ev);

        //     // 🔐 Validación de clave privada
        //     const clientKey = queryParams['smartport-key'];
        //     const expectedKey = process.env['SmartPort-Key'];
        //     delete queryParams['smartport-key'];

        //     if (!expectedKey || clientKey !== expectedKey) {
        //         return res.status(403).json({ success: false, error: 'Clave no válida para actualización de caché.' });
        //     }

        //     try {
        //         await this.initCache(ev);
        //         await this.refresh(alias, queryParams);
        //         res.json({ success: true, message: `Cache de '${alias}' actualizado.` });
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ success: false, error: 'Error actualizando cache.' });
        //     }
        // };

        const updateCacheEntry = async (alias, ev, queryParams = {}) => {
            try {
                await this.initCache(ev);
                await this.refresh(alias, queryParams);
                return { alias, success: true };
            } catch (err) {
                return { alias, success: false, error: err.message };
            }
        };

        // ⏫ Handler compartido para actualizar caché
        const handleUpdate = async (req, res, alias) => {
            const queryParams = req.query;
            const ev = queryParams.ev || this.defaultEv;

            const clientKey = queryParams['smartport-key'];
            const expectedKey = process.env['SmartPort-Key'];
            delete queryParams['smartport-key'];

            if (!expectedKey || clientKey !== expectedKey) {
                return res.status(403).json({ success: false, error: 'Clave no válida para actualización de caché.' });
            }

            const result = await updateCacheEntry(alias, ev, queryParams);

            if (result.success) {
                res.json({ success: true, message: `Cache de '${alias}' actualizado.` });
            } else {
                res.status(500).json({ success: false, error: result.error });
            }
        };

        // const handleUpdateMultiple = async (req, res) => {
        //     const queryParams = req.query;
        //     const ev = queryParams.ev || this.defaultEv;

        //     const clientKey = queryParams['smartport-key'];
        //     const expectedKey = process.env['SmartPort-Key'];
        //     delete queryParams['smartport-key'];

        //     const endpoints = queryParams.endpoint;

        //     if (!expectedKey || clientKey !== expectedKey) {
        //         return res.status(403).json({ success: false, error: 'Clave no válida para actualización múltiple.' });
        //     }

        //     if (!endpoints || !Array.isArray(endpoints)) {
        //         return res.status(400).json({ success: false, error: 'Se esperaba endpoint[]=alias1&endpoint[]=alias2' });
        //     }

        //     // ✅ Eliminar de memoria
        //     if (!this.cache[ev]) this.cache[ev] = {};
        //     for (const alias of endpoints) {
        //         const clean = alias.trim();
        //         delete this.cache[ev][clean];
        //     }

        //     const results = await Promise.all(
        //         endpoints.map(alias => updateCacheEntry(alias.trim(), ev, queryParams))
        //     );

        //     res.json({ success: true, updated: results });
        // };

        const handleUpdateMultiple = async (req, res) => {
            const originalParams = req.query;
            const ev = originalParams.ev || this.defaultEv;

            const clientKey = originalParams['smartport-key'];
            const expectedKey = process.env['SmartPort-Key'];
            if (!expectedKey || clientKey !== expectedKey) {
                return res.status(403).json({ success: false, error: 'Clave no válida para actualización múltiple.' });
            }

            const endpoints = originalParams.endpoint;
            if (!endpoints || !Array.isArray(endpoints)) {
                return res.status(400).json({ success: false, error: 'Se esperaba endpoint[]=alias1&endpoint[]=alias2' });
            }

            // ✅ Crear copia limpia sin endpoint ni smartport-key
            const queryParams = { ...originalParams };
            delete queryParams['smartport-key'];
            delete queryParams['endpoint'];

            // 🧹 Limpia de memoria antes de actualizar
            if (!this.cache[ev]) this.cache[ev] = {};
            for (const alias of endpoints) {
                const clean = alias.trim();
                delete this.cache[ev][clean];
            }

            // 🔁 Actualiza cada endpoint con los parámetros limpios
            const results = await Promise.all(
                endpoints.map(alias => updateCacheEntry(alias.trim(), ev, queryParams))
            );

            res.json({ success: true, updated: results });
        };

        // 🔁 Actualizar un solo documento dentro del JSON cacheado (updatev2)
        const handleUpdateV2 = async (req, res, alias, idParam) => {
            const originalParams = req.query || {};
            const ev = originalParams.ev || this.defaultEv;

            const clientKey = originalParams['smartport-key'];
            const expectedKey = process.env['SmartPort-Key'];
            if (!expectedKey || clientKey !== expectedKey) {
                return res.status(403).json({ success: false, error: 'Clave no válida para updatev2.' });
            }

            // Obtener payload desde body (si existe) o desde query 'update'/'data'
            let updatePayload = req.body && Object.keys(req.body).length ? req.body : null;
            if (!updatePayload) {
                const raw = originalParams.update ?? originalParams.data ?? originalParams.payload;
                if (raw) {
                    try {
                        updatePayload = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    } catch (err) {
                        return res.status(400).json({ success: false, error: 'Payload JSON inválido' });
                    }
                }
            }

            if (!updatePayload) return res.status(400).json({ success: false, error: 'No se encontró payload para actualizar.' });

            const result = await this.updateDocument(alias, idParam, updatePayload, { ev });
            if (result.success) return res.json({ success: true, item: result.item });
            return res.status(404).json({ success: false, error: result.error });
        };


        // 🟨 Rutas segmentadas para /update
        router.get('/update/:alias', (req, res) =>
            handleUpdate(req, res, req.params.alias)
        );

        router.get('/update/:alias/:extra', (req, res) =>
            handleUpdate(req, res, `${req.params.alias}/${req.params.extra}`)
        );

        router.get('/update/:alias/:extra/:id', (req, res) =>
            handleUpdate(req, res, `${req.params.alias}/${req.params.extra}/${req.params.id}`)
        );

        router.get('/update-multiple', handleUpdateMultiple);

        // POST routes para updatev2 (actualizar un solo documento por id)
        router.post('/updatev2/:alias/:id', (req, res) =>
            handleUpdateV2(req, res, req.params.alias, req.params.id)
        );

        router.post('/updatev2/:alias/:extra/:id', (req, res) =>
            handleUpdateV2(req, res, `${req.params.alias}/${req.params.extra}`, req.params.id)
        );

        router.post('/updatev2/:alias/:extra/:id/:more', (req, res) =>
            handleUpdateV2(req, res, `${req.params.alias}/${req.params.extra}/${req.params.id}`, req.params.more)
        );


        // 🟩 Handler compartido para /data
        const handleData = async (req, res, alias) => {
            let { ev, limit, skip, sort, search, ...rest } = req.query;
            ev = ev || this.defaultEv;

            // 🚫 Eliminar claves que no deben entrar al filtro
            const excludedKeys = ['smartport-key', 'token'];
            excludedKeys.forEach(k => delete rest[k]);

            const filter = this.parseQueryToFilter(rest);

            try {
                const data = await this.getData(alias, {
                    ev,
                    limit: limit ? parseInt(limit) : undefined,
                    skip: skip ? parseInt(skip) : 0,
                    sort,
                    search,
                    filter
                });

                if (!data || data.length === 0) {
                    return res.status(404).json({ success: false, data: [], message: 'No hay datos en caché.' });
                }

                res.json({ success: true, data, count: data.length });
            } catch (err) {
                console.error(err);
                res.status(500).json({ success: false, error: 'Error obteniendo datos.' });
            }
        };

        // 🟨 Rutas segmentadas para /data
        router.get('/data/:alias', (req, res) =>
            handleData(req, res, req.params.alias)
        );

        router.get('/data/:alias/:extra', (req, res) =>
            handleData(req, res, `${req.params.alias}/${req.params.extra}`)
        );

        router.get('/data/:alias/:extra/:id', (req, res) =>
            handleData(req, res, `${req.params.alias}/${req.params.extra}/${req.params.id}`)
        );

        // 🧹 Función reutilizable para borrar del cache y del disco
        // const deleteCacheEntry = (alias, ev) => {
        //     const filePath = path.join(this.cacheDir, ev, `${alias.replace(/\W/g, '_')}.json`);
        //     if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        //     if (this.cache[ev] && this.cache[ev][alias]) {
        //         delete this.cache[ev][alias];
        //     }
        // };


        // 🔴 Handler para eliminar un solo alias
        // const handleDelete = (req, res, alias) => {
        //     const queryParams = req.query;
        //     const ev = queryParams.ev || this.defaultEv;

        //     const clientKey = queryParams['smartport-key'];
        //     const expectedKey = process.env['SmartPort-Key'];
        //     delete queryParams['smartport-key'];

        //     if (!expectedKey || clientKey !== expectedKey) {
        //         return res.status(403).json({ success: false, error: 'Clave no válida para eliminación de caché.' });
        //     }

        //     try {
        //         deleteCacheEntry(alias, ev);
        //         res.json({ success: true, message: `Cache eliminado: ${alias}` });
        //     } catch (err) {
        //         res.status(500).json({ success: false, error: 'Error eliminando cache: ' + err.message });
        //     }
        // };

        // 🧹 Handler para eliminar múltiples endpoints con endpoint[]=...
        // const handleDeleteMultiple = (req, res) => {
        //     const queryParams = req.query;
        //     const ev = queryParams.ev || this.defaultEv;

        //     const clientKey = queryParams['smartport-key'];
        //     const expectedKey = process.env['SmartPort-Key'];
        //     delete queryParams['smartport-key'];

        //     const endpoints = queryParams.endpoint;

        //     if (!expectedKey || clientKey !== expectedKey) {
        //         return res.status(403).json({ success: false, error: 'Clave no válida para eliminación múltiple.' });
        //     }

        //     if (!endpoints || !Array.isArray(endpoints)) {
        //         return res.status(400).json({ success: false, error: 'Se esperaba endpoint[]=alias1&endpoint[]=alias2' });
        //     }

        //     const resultados = endpoints.map((aliasRaw) => {
        //         const alias = aliasRaw.trim();
        //         try {
        //             deleteCacheEntry(alias, ev);
        //             return { alias, success: true };
        //         } catch (err) {
        //             return { alias, success: false, error: err.message };
        //         }
        //     });

        //     res.json({ success: true, deleted: resultados });
        // };

        return router;
    }

}

module.exports = SmartPort;
