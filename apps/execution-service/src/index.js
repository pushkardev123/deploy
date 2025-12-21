import WebSocket from "ws";
import { createClient } from "redis";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import https from "https";
import querystring from "querystring";

const REDIS_URL = process.env.REDIS_URL;
const COMMANDS_CHANNEL = process.env.COMMANDS_CHANNEL || "commands:order:submit";
const EVENTS_CHANNEL = process.env.EVENTS_CHANNEL || "events:order:status";
const PRICES_CHANNEL = process.env.PRICES_CHANNEL || "events:price:update";

// Symbol metadata RPC (event-service -> execution-service)
const SYMBOL_REQ_CHANNEL = process.env.SYMBOL_REQ_CHANNEL || "events:symbol:request";
const SYMBOL_RES_CHANNEL = process.env.SYMBOL_RES_CHANNEL || "events:symbol:response";
const SYMBOL_CACHE_MS = Number(process.env.SYMBOL_CACHE_MS || 10 * 60 * 1000); // 10 minutes

if (!REDIS_URL) {
    console.error("[execution] Missing REDIS_URL. Export it before running.");
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY_STR = process.env.ENCRYPTION_KEY;
if (!KEY_STR || KEY_STR.length !== 32) {
    console.error("[execution] ENCRYPTION_KEY must be set and exactly 32 characters (AES-256 key)");
    process.exit(1);
}

const ENC_KEY = Buffer.from(KEY_STR, "utf8");

function decrypt(payload) {
    const [ivB64, tagB64, encB64] = String(payload || "").split(".");
    if (!ivB64 || !tagB64 || !encB64) {
        throw new Error("Invalid encrypted payload");
    }

    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const enc = Buffer.from(encB64, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);

    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
}

const BINANCE_API_BASE = process.env.BINANCE_API_BASE || "https://testnet.binance.vision";

// In-memory cache: SYMBOL -> { data, ts }
const symbolInfoCache = new Map();

function cacheGetSymbol(symbol) {
    const key = String(symbol || "").toUpperCase();
    const entry = symbolInfoCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > SYMBOL_CACHE_MS) {
        symbolInfoCache.delete(key);
        return null;
    }
    return entry.data;
}

function cacheSetSymbol(symbol, data) {
    const key = String(symbol || "").toUpperCase();
    symbolInfoCache.set(key, { data, ts: Date.now() });
}

function httpsJsonGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: "GET" }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try {
                    const json = JSON.parse(data || "{}");
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(json?.msg || `HTTP ${res.statusCode}`));
                    }
                    resolve(json);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

async function fetchSymbolInfoFromBinance(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const qs = querystring.stringify({ symbol: sym });
    const url = `${BINANCE_API_BASE}/api/v3/exchangeInfo?${qs}`;

    const json = await httpsJsonGet(url);
    const s = json?.symbols?.[0];
    if (!s) throw new Error("symbol not found");

    const filters = Array.isArray(s.filters) ? s.filters : [];
    const lot = filters.find((f) => f.filterType === "LOT_SIZE");
    const priceFilter = filters.find((f) => f.filterType === "PRICE_FILTER");
    const notional =
        filters.find((f) => f.filterType === "MIN_NOTIONAL") ||
        filters.find((f) => f.filterType === "NOTIONAL");

    return {
        symbol: sym,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,

        // Quantity rules
        minQty: lot?.minQty,
        maxQty: lot?.maxQty,
        stepSize: lot?.stepSize,

        // Price rules
        tickSize: priceFilter?.tickSize,
        minPrice: priceFilter?.minPrice,
        maxPrice: priceFilter?.maxPrice,

        // Notional rules (price * qty)
        minNotional: notional?.minNotional,
        maxNotional: notional?.maxNotional,
        applyMinToMarket: notional?.applyMinToMarket ?? false,
        applyMaxToMarket: notional?.applyMaxToMarket ?? false,
        avgPriceMins: notional?.avgPriceMins ?? null,
    };
}

async function getSymbolInfo(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const cached = cacheGetSymbol(sym);
    if (cached) return { fromCache: true, data: cached };
    const data = await fetchSymbolInfoFromBinance(sym);
    cacheSetSymbol(sym, data);
    return { fromCache: false, data };
}

function signQuery(query, secret) {
    return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function executeBinanceOrder({ apiKey, secretKey, symbol, side, type, quantity }) {
    const params = {
        symbol,
        side,
        type,
        quantity,
        timestamp: Date.now(),
    };

    const query = querystring.stringify(params);
    const signature = signQuery(query, secretKey);

    const path = `/api/v3/order?${query}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(
            `${BINANCE_API_BASE}${path}`,
            {
                method: "POST",
                headers: {
                    "X-MBX-APIKEY": apiKey,
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(data);

                        if (json.code && json.code < 0) {
                            return reject(json);
                        }

                        resolve(json);
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );

        req.on("error", reject);
        req.end();
    });
}

async function main() {
    const sub = createClient({ url: REDIS_URL });
    const pub = createClient({ url: REDIS_URL });

    sub.on("error", (e) => console.error("[execution] redis sub error:", e));
    pub.on("error", (e) => console.error("[execution] redis pub error:", e));

    const prisma = new PrismaClient();

    await prisma.$connect();
    await sub.connect();
    await pub.connect();

    console.log("[execution] redis connected");
    console.log(`[execution] subscribing: ${COMMANDS_CHANNEL}`);

    console.log(`[execution] subscribing: ${SYMBOL_REQ_CHANNEL}`);

    await sub.subscribe(SYMBOL_REQ_CHANNEL, async (message) => {
        let req;
        try {
            req = JSON.parse(message);
        } catch {
            console.error("[execution] invalid symbol request JSON:", message);
            return;
        }

        if (req?.type !== "SYMBOL_INFO_REQUEST") return;

        const id = req?.id;
        const symbol = String(req?.symbol || "").toUpperCase();
        const replyTo = String(req?.replyTo || SYMBOL_RES_CHANNEL);

        const baseResp = {
            type: "SYMBOL_INFO_RESPONSE",
            id,
            symbol,
            ts: Date.now(),
        };

        if (!id || !symbol) {
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: false, error: "id and symbol are required" }));
            return;
        }

        try {
            const out = await getSymbolInfo(symbol);
            await pub.publish(
                replyTo,
                JSON.stringify({ ...baseResp, ok: true, data: out.data, fromCache: out.fromCache })
            );
        } catch (e) {
            await pub.publish(
                replyTo,
                JSON.stringify({ ...baseResp, ok: false, error: e?.message || "failed" })
            );
        }
    });

    const BINANCE_WS_BASE = process.env.BINANCE_WS_BASE || "wss://stream.testnet.binance.vision";

    // If you want the full market board (all symbols), set MARKET_MODE=all
    // Otherwise set MARKET_MODE=trades and SYMBOLS=btcusdt,ethusdt,...
    const MARKET_MODE = (process.env.MARKET_MODE || "all").toLowerCase();

    const SYMBOLS = (process.env.SYMBOLS || "btcusdt")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

    let wsUrl;
    if (MARKET_MODE === "all") {
        // All Market Mini Tickers Stream (array). Update speed ~1000ms.
        // Testnet raw stream URL format: /ws/<streamName>
        wsUrl = `${BINANCE_WS_BASE}/ws/!miniTicker@arr`;
    } else {
        // Use combined trade streams for a chosen subset of symbols.
        const streams = SYMBOLS.map((s) => `${s}@trade`).join("/");
        wsUrl = `${BINANCE_WS_BASE}/stream?streams=${streams}`;
    }

    let binanceSocket;
    let wsReconnectTimer;

    const startBinanceWs = () => {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);

        console.log("[execution] connecting market stream:", wsUrl);
        binanceSocket = new WebSocket(wsUrl);

        binanceSocket.on("open", () => {
            console.log("[execution] market stream connected", { mode: MARKET_MODE, symbols: SYMBOLS });
        });

        binanceSocket.on("error", (err) => {
            console.error("[execution] market stream error:", err?.message || err);
        });

        binanceSocket.on("close", (code, reason) => {
            console.warn("[execution] market stream closed", { code, reason: String(reason || "") });
            // Reconnect with a short backoff
            wsReconnectTimer = setTimeout(startBinanceWs, 1500);
        });

        binanceSocket.on("message", async (raw) => {
            try {
                const parsed = JSON.parse(raw.toString());

                // MODE=all => message is an ARRAY of mini-tickers
                if (MARKET_MODE === "all") {
                    if (!Array.isArray(parsed)) return;

                    // Keep payload small & frontend-friendly: symbol + lastPrice + eventTime
                    // miniTicker fields include: e (event), E (eventTime), s (symbol), c (close/last)
                    const ts = Date.now();
                    const tickers = parsed
                        .map((t) => ({
                            symbol: String(t.s || "").toUpperCase(),
                            price: Number(t.c),
                        }))
                        .filter((t) => t.symbol && Number.isFinite(t.price));

                    // Publish one market-board update per WS message (already ~1s)
                    const marketBoardEvent = {
                        type: "MARKET_BOARD",
                        ts,
                        data: tickers,
                    };

                    await pub.publish(PRICES_CHANNEL, JSON.stringify(marketBoardEvent));
                    return;
                }

                // MODE=trades => combined stream wrapper: { stream, data }
                const data = parsed?.data;
                if (!data || data.e !== "trade") return;

                const symbol = String(data.s || "").toUpperCase();
                const price = Number(data.p);
                const ts = Number(data.T || Date.now());

                if (!symbol || !Number.isFinite(price)) return;

                const marketEvent = {
                    type: "PRICE_UPDATE",
                    symbol,
                    price,
                    ts,
                };

                await pub.publish(PRICES_CHANNEL, JSON.stringify(marketEvent));
            } catch (e) {
                console.error("[execution] Failed to process market message:", e?.message || e);
            }
        });
    };

    startBinanceWs();

    await sub.subscribe(COMMANDS_CHANNEL, async (message) => {
        let cmd;
        try {
            cmd = JSON.parse(message);
        } catch {
            console.error("[execution] invalid command JSON:", message);
            return;
        }

        console.log("[execution] received command:", cmd);

        const orderType = String(cmd?.orderType || "MARKET").toUpperCase();
        const clientPrice = cmd?.price;
        const clientStopPrice = cmd?.stopPrice;
        const clientTif = cmd?.timeInForce || (orderType === "LIMIT" ? "GTC" : undefined);

        // Ensure the command exists in DB (spec requires logging all commands)
        // Use upsert so both flows work:
        // 1) Backend inserted OrderCommand already
        // 2) Direct redis-cli publish (no OrderCommand row yet)
        try {
            await prisma.orderCommand.upsert({
                where: { orderId: cmd.orderId },
                update: {
                    status: "PENDING",
                },
                create: {
                    userId: cmd.userId,
                    orderId: cmd.orderId,
                    symbol: cmd.symbol,
                    side: cmd.side,
                    type: orderType,
                    quantity: Number(cmd.quantity),
                    status: "PENDING",
                },
            });
        } catch (e) {
            console.error("[execution] could not upsert OrderCommand:", e);
        }

        // ---- Fetch & decrypt user's Binance keys (required for real execution) ----
        let binanceApiKey = null;
        let binanceSecretKey = null;

        try {
            const user = await prisma.user.findUnique({
                where: { id: cmd.userId },
                select: {
                    binanceApiKeyEnc: true,
                    binanceSecretKeyEnc: true,
                },
            });

            if (!user) {
                throw new Error(`User not found for userId=${cmd.userId}`);
            }

            binanceApiKey = decrypt(user.binanceApiKeyEnc);
            binanceSecretKey = decrypt(user.binanceSecretKeyEnc);
        } catch (e) {
            console.error("[execution] Failed to fetch/decrypt Binance keys:", e?.message || e);

            // Persist a REJECTED event + publish it, then stop processing this command.
            const now = new Date();

            try {
                await prisma.orderEvent.create({
                    data: {
                        orderId: cmd.orderId,
                        userId: cmd.userId,
                        status: "REJECTED",
                        price: null,
                        quantity: Number(cmd.quantity),
                        timestamp: now,
                    },
                });
            } catch (dbErr) {
                console.error("[execution] OrderEvent insert failed (reject path):", dbErr);
            }

            try {
                await prisma.orderCommand.upsert({
                    where: { orderId: cmd.orderId },
                    update: { status: "REJECTED" },
                    create: {
                        userId: cmd.userId,
                        orderId: cmd.orderId,
                        symbol: cmd.symbol,
                        side: cmd.side,
                        type: orderType,
                        quantity: Number(cmd.quantity),
                        status: "REJECTED",
                    },
                });
            } catch (dbErr) {
                console.error("[execution] OrderCommand status upsert failed (reject path):", dbErr);
            }

            const rejectEvent = {
                orderId: cmd.orderId,
                userId: cmd.userId,
                status: "REJECTED",
                symbol: cmd.symbol,
                side: cmd.side,
                orderType,
                quantity: Number(cmd.quantity),
                price: null,
                client: {
                    price: clientPrice,
                    stopPrice: clientStopPrice,
                    timeInForce: clientTif,
                },
                reason: e?.message || "Failed to fetch/decrypt Binance keys",
                timestamp: now.toISOString(),
            };

            await pub.publish(EVENTS_CHANNEL, JSON.stringify(rejectEvent));
            console.log("[execution] published event (reject path):", rejectEvent);
            return;
        }

        // Keys are now available for the real Binance call.
        // (For now, we keep using the mock executor; next step is swapping in Binance Testnet REST.)
        // You can log masked key lengths for sanity:
        console.log("[execution] decrypted keys ok:", {
            hasApiKey: !!binanceApiKey,
            hasSecret: !!binanceSecretKey,
            apiKeyLen: binanceApiKey?.length || 0,
            secretLen: binanceSecretKey?.length || 0,
        });

        // ---- Execute (real Binance Spot Testnet order) ----
        let execResult;
        let binanceMeta = null;
        try {
            const binanceRes = await executeBinanceOrder({
                apiKey: binanceApiKey,
                secretKey: binanceSecretKey,
                symbol: cmd.symbol,
                side: cmd.side,
                type: orderType,
                quantity: cmd.quantity,
            });

            const executedQty = Number(binanceRes.executedQty ?? cmd.quantity);

            let avgPrice = null;

            // weighted average from fills (best)
            if (Array.isArray(binanceRes.fills) && binanceRes.fills.length > 0) {
                let num = 0;
                let den = 0;
                for (const f of binanceRes.fills) {
                    const p = Number(f.price);
                    const q = Number(f.qty);
                    if (Number.isFinite(p) && Number.isFinite(q)) {
                        num += p * q;
                        den += q;
                    }
                }
                if (den > 0) avgPrice = num / den;
            } else {
                // fallback from cumulative quote
                const cq = Number(binanceRes.cummulativeQuoteQty);
                if (Number.isFinite(cq) && Number.isFinite(executedQty) && executedQty > 0) {
                    avgPrice = cq / executedQty;
                }
            }

            const bStatus = String(binanceRes.status || "").toUpperCase();
            binanceMeta = {
                status: bStatus || null,
                orderId: binanceRes?.orderId ?? null,
                clientOrderId: binanceRes?.clientOrderId ?? null,
                transactTime: binanceRes?.transactTime ?? null,
                executedQty: binanceRes?.executedQty ?? null,
                cummulativeQuoteQty: binanceRes?.cummulativeQuoteQty ?? null,
            };
            let mappedStatus = "FILLED";
            if (bStatus === "PARTIALLY_FILLED") mappedStatus = "PARTIALLY_FILLED";
            else if (bStatus === "NEW") mappedStatus = "PARTIALLY_FILLED"; // still open
            else if (bStatus === "REJECTED" || bStatus === "EXPIRED") mappedStatus = "REJECTED";

            execResult = {
                status: mappedStatus,
                price: Number.isFinite(avgPrice) ? avgPrice : null,
                quantity: Number.isFinite(executedQty) ? executedQty : Number(cmd.quantity),
                timestamp: new Date(binanceRes.transactTime || Date.now()),
            };
        } catch (err) {
            console.error("[execution] Binance order failed:", err);

            binanceMeta = {
                status: null,
                errorCode: err?.code ?? err?.name ?? null,
                errorMsg: err?.msg ?? err?.message ?? String(err),
            };

            execResult = {
                status: "REJECTED",
                price: null,
                quantity: Number(cmd.quantity),
                timestamp: new Date(),
                reason: err?.msg || err?.message || "Binance order failed",
            };
        }

        // ---- Persist event to DB ----
        try {
            await prisma.orderEvent.create({
                data: {
                    orderId: cmd.orderId,
                    userId: cmd.userId,
                    status: execResult.status,
                    price: execResult.price,
                    quantity: execResult.quantity,
                    timestamp: execResult.timestamp,
                },
            });
        } catch (e) {
            console.error("[execution] OrderEvent insert failed:", e);
        }

        // Keep command status in sync with latest result (best-effort)
        try {
            await prisma.orderCommand.upsert({
                where: { orderId: cmd.orderId },
                update: { status: execResult.status },
                create: {
                    userId: cmd.userId,
                    orderId: cmd.orderId,
                    symbol: cmd.symbol,
                    side: cmd.side,
                    type: orderType,
                    quantity: Number(cmd.quantity),
                    status: execResult.status,
                },
            });
        } catch (e) {
            console.error("[execution] OrderCommand status upsert failed:", e);
        }

        // ---- Publish event to Redis (spec format) ----
        const event = {
            orderId: cmd.orderId,
            userId: cmd.userId,
            status: execResult.status, // FILLED | REJECTED | PARTIALLY_FILLED
            symbol: cmd.symbol,
            side: cmd.side,
            orderType,
            quantity: execResult.quantity,
            price: execResult.price,
            client: {
                price: clientPrice,
                stopPrice: clientStopPrice,
                timeInForce: clientTif,
            },
            reason: execResult.reason || null,
            binance: binanceMeta,
            timestamp: execResult.timestamp.toISOString(),
        };

        await pub.publish(EVENTS_CHANNEL, JSON.stringify(event));
        console.log("[execution] published event:", event);
    });
}

main().catch((e) => {
    console.error("[execution] fatal:", e);
    process.exit(1);
});