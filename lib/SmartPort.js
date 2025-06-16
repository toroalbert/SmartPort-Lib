// SmartPort.js
const fs = require('fs');
const path = require('path');
const express = require('express');

class SmartPort {
    constructor({ ev, apiUrl, endpoints, cacheDir = './cache', cacheDuration = 600000 }) {
        this.apiUrl = apiUrl || process.env['SmartPort-ApiURL'] || '';
        this.endpoints = endpoints;
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

    async fetchFromAPI(endpoint, params = {}) {
        try {

            if (!params.ev) params.ev = this.defaultEv;
            const fetch = (await import('node-fetch')).default;
            const url = new URL(`${this.apiUrl}/${endpoint}`);
            Object.entries(params).forEach(([key, value]) => {
                url.searchParams.append(key, value);
            });

            console.log("URL: " + url);
            const response = await fetch(url.toString());
            if (!response.ok) throw new Error(`Error en ${endpoint}`);
            return await response.json();
        } catch (error) {
            console.error(`Error obteniendo datos de ${endpoint}:`, error);
            return null;
        }
    }

    saveToStorage(endpoint, ev = 'undefined') {
        const dir = path.join(this.cacheDir, ev);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, `${endpoint.replace(/\W/g, '_')}.json`);
        let toTransform = this.cache[ev]?.[endpoint]?.data?.answer ?? this.cache[ev]?.[endpoint]?.data ?? this.cache[ev]?.[endpoint];
        fs.writeFileSync(filePath, JSON.stringify(toTransform, null, 2));
    }

    loadFromStorage(endpoint, ev = 'undefined') {
        const filePath = path.join(this.cacheDir, ev, `${endpoint.replace(/\W/g, '_')}.json`);
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
            const filePath = path.join(this.cacheDir, ev, `${alias.replace(/\W/g, '_')}.json`);
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

        const handleUpdateMultiple = async (req, res) => {
            const queryParams = req.query;
            const ev = queryParams.ev || this.defaultEv;

            const clientKey = queryParams['smartport-key'];
            const expectedKey = process.env['SmartPort-Key'];
            delete queryParams['smartport-key'];

            const endpoints = queryParams.endpoint;

            if (!expectedKey || clientKey !== expectedKey) {
                return res.status(403).json({ success: false, error: 'Clave no válida para actualización múltiple.' });
            }

            if (!endpoints || !Array.isArray(endpoints)) {
                return res.status(400).json({ success: false, error: 'Se esperaba endpoint[]=alias1&endpoint[]=alias2' });
            }

            const results = await Promise.all(
                endpoints.map(alias => updateCacheEntry(alias.trim(), ev, queryParams))
            );

            res.json({ success: true, updated: results });
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
