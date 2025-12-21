import http from "http";
import { WebSocketServer } from "ws";
import { createClient } from "redis";

const PORT = process.env.PORT || 8081;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const EVENTS_CHANNEL = process.env.EVENTS_CHANNEL || "events:order:status";
const ORDERS_CHANNEL = process.env.ORDERS_CHANNEL || "commands:order:submit";
const PRICES_CHANNEL = process.env.PRICES_CHANNEL || "events:price:update";

// Symbol metadata (exchange filters like LOT_SIZE / stepSize / minQty)
const SYMBOL_REQ_CHANNEL = process.env.SYMBOL_REQ_CHANNEL || "events:symbol:request";
const SYMBOL_RES_CHANNEL = process.env.SYMBOL_RES_CHANNEL || "events:symbol:response";
const SYMBOL_CACHE_MS = Number(process.env.SYMBOL_CACHE_MS || 10 * 60 * 1000); // 10 minutes

let redisPub = null;

// Pending RPC-style requests waiting for execution-service responses
const pending = new Map(); // id -> { resolve, reject, timeout }

// In-memory cache: SYMBOL -> { data, ts }
const symbolCache = new Map();

function cacheGet(symbol) {
    const key = String(symbol || "").toUpperCase();
    const entry = symbolCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > SYMBOL_CACHE_MS) {
        symbolCache.delete(key);
        return null;
    }
    return entry.data;
}

function cacheSet(symbol, data) {
    const key = String(symbol || "").toUpperCase();
    symbolCache.set(key, { data, ts: Date.now() });
}

async function requestSymbolInfo(symbol, timeoutMs = 6000) {
    const sym = String(symbol || "").toUpperCase();

    const cached = cacheGet(sym);
    if (cached) return { fromCache: true, data: cached };

    if (!redisPub) throw new Error("redis publisher not ready");

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const req = {
        type: "SYMBOL_INFO_REQUEST",
        id,
        symbol: sym,
        replyTo: SYMBOL_RES_CHANNEL,
        ts: Date.now(),
    };

    const p = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error("symbol info timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
    });

    await redisPub.publish(SYMBOL_REQ_CHANNEL, JSON.stringify(req));
    const data = await p;
    cacheSet(sym, data);
    return { fromCache: false, data };
}

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            // simple guard (1MB)
            if (data.length > 1_000_000) {
                reject(new Error("Payload too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!data) return resolve(null);
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

// --- HTTP server (health + REST endpoints + WS upgrade) ---
const server = http.createServer(async (req, res) => {
    setCors(res);

    // Preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                ok: true,
                service: "event-service",
                redisUrl: REDIS_URL,
                eventsChannel: EVENTS_CHANNEL,
                ordersChannel: ORDERS_CHANNEL,
                pricesChannel: PRICES_CHANNEL,
                symbolReqChannel: SYMBOL_REQ_CHANNEL,
                symbolResChannel: SYMBOL_RES_CHANNEL,
                symbolCacheMs: SYMBOL_CACHE_MS,
                hasPublisher: Boolean(redisPub),
            })
        );
        return;
    }

    // Frontend -> event-service: fetch symbol filters (LOT_SIZE, PRICE_FILTER, NOTIONAL, etc)
    if (req.url?.startsWith("/symbol-info") && req.method === "GET") {
        try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            const symbol = String(u.searchParams.get("symbol") || "").toUpperCase();
            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol query param is required" }));
            }

            const cached = cacheGet(symbol);
            if (cached) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: true, symbol, fromCache: true, data: cached }));
            }

            const out = await requestSymbolInfo(symbol, 6000);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, symbol, fromCache: out.fromCache, data: out.data }));
        } catch (e) {
            console.error("[event-service] /symbol-info error:", e);
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: e?.message || "timeout" }));
        }
    }

    // Frontend -> Event-service: create an order command
    if (req.url === "/orders" && req.method === "POST") {
        try {
            const body = await readJson(req);

            // minimal validation
            const symbol = String(body?.symbol || "").toUpperCase();
            const side = String(body?.side || "").toUpperCase();
            const quantity = Number(body?.quantity);
            const orderType = String(body?.orderType || "LIMIT").toUpperCase();
            const userId = String(body?.userId || "");

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (side !== "BUY" && side !== "SELL") {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "side must be BUY or SELL" }));
            }
            if (!Number.isFinite(quantity) || quantity <= 0) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "quantity must be > 0" }));
            }
            if (!userId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "userId is required" }));
            }

            if (orderType === "LIMIT") {
                const price = Number(body?.price);
                if (!Number.isFinite(price) || price <= 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: false, error: "LIMIT requires a valid price" }));
                }
            }

            if (orderType === "STOP_MARKET") {
                const stopPrice = Number(body?.stopPrice);
                if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: false, error: "STOP_MARKET requires a valid stopPrice" }));
                }
            }

            const event = {
                type: "ORDER_CREATED",
                userId,
                // prefer client provided orderId/id, else generate
                orderId:
                    body?.orderId ||
                    body?.id ||
                    `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                symbol,
                side,
                quantity,
                orderType,

                // Optional fields used by execution-service/Binance
                price: body?.price,
                stopPrice: body?.stopPrice,
                timeInForce: body?.timeInForce,

                meta: body?.meta || {},
                ts: Date.now(),
            };

            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const payload = JSON.stringify(event);
            await redisPub.publish(ORDERS_CHANNEL, payload);

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: ORDERS_CHANNEL, event }));
        } catch (e) {
            console.error("[event-service] /orders error:", e);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    res.writeHead(404);
    res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

// Track live clients
const clients = new Set();

// Only accept WS upgrades on /prices
server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/prices") return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

wss.on("connection", (ws) => {
    clients.add(ws);

    ws.send(
        JSON.stringify({
            type: "HELLO",
            message: "connected to /prices",
            note: "Broadcasting Redis order events + price updates to all WS clients",
            channels: {
                orders: EVENTS_CHANNEL,
                commands: ORDERS_CHANNEL,
                prices: PRICES_CHANNEL,
                symbolRequest: SYMBOL_REQ_CHANNEL,
                symbolResponse: SYMBOL_RES_CHANNEL,
            },
        })
    );

    ws.on("close", () => {
        clients.delete(ws);
    });

    ws.on("error", () => {
        clients.delete(ws);
    });
});

function broadcast(raw) {
    for (const ws of clients) {
        if (ws.readyState === 1) {
            ws.send(raw);
        } else {
            clients.delete(ws);
        }
    }
}

// --- Redis subscriber: channels -> WS broadcast ---
async function startRedisSubscriber() {
    const sub = createClient({ url: REDIS_URL });

    sub.on("error", (err) => {
        console.error("[event-service] redis error:", err);
    });

    await sub.connect();
    console.log(`[event-service] redis connected: ${REDIS_URL}`);

    const forward = (channel, message) => {
        broadcast(
            JSON.stringify({
                type: "REDIS_EVENT",
                channel,
                message,
                ts: Date.now(),
            })
        );
    };

    await sub.subscribe(EVENTS_CHANNEL, (message) => forward(EVENTS_CHANNEL, message));
    await sub.subscribe(PRICES_CHANNEL, (message) => forward(PRICES_CHANNEL, message));
    await sub.subscribe(SYMBOL_RES_CHANNEL, (message) => {
        try {
            const payload = JSON.parse(message);
            const id = payload?.id;
            if (id && pending.has(id)) {
                const p = pending.get(id);
                clearTimeout(p.timeout);
                pending.delete(id);
                if (payload?.ok === false) p.reject(new Error(payload?.error || "symbol info failed"));
                else p.resolve(payload?.data);
            }

            // Warm cache only if ok === true
            if (payload?.ok === true && payload?.symbol && payload?.data) {
                cacheSet(payload.symbol, payload.data);
            }
        } catch {
            // ignore
        }

        forward(SYMBOL_RES_CHANNEL, message);
    });

    console.log(`[event-service] subscribed to: ${EVENTS_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${PRICES_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${SYMBOL_RES_CHANNEL}`);

    return sub;
}

// --- Boot ---
(async () => {
    server.listen(PORT, () => {
        console.log(`[event-service] http://localhost:${PORT}`);
        console.log(`[event-service] ws://localhost:${PORT}/prices`);
    });

    try {
        redisPub = createClient({ url: REDIS_URL });
        redisPub.on("error", (err) => console.error("[event-service] redis pub error:", err));
        await redisPub.connect();
        console.log(`[event-service] redis publisher connected: ${REDIS_URL}`);
    } catch (e) {
        console.error("[event-service] failed to start redis publisher:", e);
    }

    let redisSub = null;
    try {
        redisSub = await startRedisSubscriber();
    } catch (e) {
        console.error("[event-service] failed to start redis subscriber:", e);
        console.error("[event-service] Tip: set REDIS_URL env or ensure redis is running on 127.0.0.1:6379");
    }

    const shutdown = async () => {
        try {
            for (const ws of clients) {
                try {
                    ws.close();
                } catch { }
            }
            clients.clear();

            for (const [id, p] of pending) {
                clearTimeout(p.timeout);
                pending.delete(id);
            }

            if (redisSub) await redisSub.quit();
            if (redisPub) await redisPub.quit();
        } finally {
            process.exit(0);
        }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})();