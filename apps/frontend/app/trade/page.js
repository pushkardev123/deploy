"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Inter } from "next/font/google";
import { z } from "zod";

import { getToken, getUserId } from "../lib/auth";

const inter = Inter({
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

export default function TradePage() {
    const router = useRouter();
    const userIdRef = useRef(null);
    const [status, setStatus] = useState("CONNECTING");
    const [apiMsg, setApiMsg] = useState("");
    const [isPlacingOrder, setIsPlacingOrder] = useState(false);
    const [pendingOrderId, setPendingOrderId] = useState(null);
    const [toast, setToast] = useState({ open: false, title: "", message: "", status: "" });

    // orderId -> latest order status event
    const [ordersById, setOrdersById] = useState({});

    // marketBoard: { BTCUSDT: { price, ts }, ETHUSDT: { ... } }
    const [marketBoard, setMarketBoard] = useState({});
    const [filter, setFilter] = useState("");

    const [lastEvent, setLastEvent] = useState(null);
    const [lastUpdateTs, setLastUpdateTs] = useState(null);
    const [pinned, setPinned] = useState(() => new Set());

    // UI
    const [theme, setTheme] = useState(() => {
        if (typeof window === "undefined") return "light";
        try {
            const t = localStorage.getItem("theme");
            if (t === "dark" || t === "light") return t;
        } catch { }
        return "light";
    }); // 'light' | 'dark'
    const [activeTab, setActiveTab] = useState("trades"); // positions | orders | trades
    const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
    const [side, setSide] = useState("BUY");
    const [orderType, setOrderType] = useState("MARKET");
    const [qty, setQty] = useState("0.01");
    const [limitPrice, setLimitPrice] = useState("");
    const [stopPrice, setStopPrice] = useState("");
    const [formErrors, setFormErrors] = useState({}); // { qty?: string, limitPrice?: string, stopPrice?: string, notional?: string, base?: string }

    // Exchange symbol filters (LOT_SIZE etc)
    const [symbolInfo, setSymbolInfo] = useState(null);
    const [symbolInfoStatus, setSymbolInfoStatus] = useState("idle"); // idle | loading | ready | error
    const [symbolInfoError, setSymbolInfoError] = useState("");

    const UI_FLUSH_MS = Number(process.env.NEXT_PUBLIC_MARKET_FLUSH_MS || 1500);
    const MAX_SYMBOLS = Number(process.env.NEXT_PUBLIC_MAX_SYMBOLS || 1000);

    // Cache of latest prices by symbol
    const latestBoardRef = useRef({});
    // Stable insertion order for the table
    const symbolOrderRef = useRef([]);
    const latestTsRef = useRef(null);

    const eventBaseUrl = (process.env.NEXT_PUBLIC_EVENT_SERVICE_URL || "http://localhost:8081").replace(/\/$/, "");
    const wsBaseUrl = (
        process.env.NEXT_PUBLIC_WS_URL ||
        eventBaseUrl.replace(/^https?:\/\//, (m) => (m === "https://" ? "wss://" : "ws://"))
    ).replace(/\/$/, "");

    useEffect(() => {
        const token = getToken();
        const userId = getUserId();
        userIdRef.current = userId;
        if (!token || !userId) {
            router.push("/login");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [wsMsgCount, setWsMsgCount] = useState(0);

    useEffect(() => {
        let ws;
        let retryTimer;
        let cancelled = false;
        let attempt = 0;

        const connect = () => {
            if (cancelled) return;

            const url = `${wsBaseUrl}/prices`;
            try {
                ws = new WebSocket(url);
            } catch {
                setStatus("ERROR");
                scheduleReconnect();
                return;
            }

            ws.onopen = () => {
                attempt = 0;
                setStatus("OPEN");
            };

            ws.onclose = () => {
                setStatus("CLOSED");
                scheduleReconnect();
            };

            ws.onerror = () => {
                setStatus("ERROR");
                // onerror is usually followed by close, but be safe
            };

            ws.onmessage = (e) => {
                setWsMsgCount((c) => c + 1);

                try {
                    const outer = JSON.parse(e.data);
                    setLastEvent(outer);

                    // We expect: { type: 'REDIS_EVENT', channel, message, ts }
                    if (outer?.type !== "REDIS_EVENT") return;

                    const channel = outer.channel;
                    let inner;
                    try {
                        inner = JSON.parse(outer.message);
                    } catch {
                        // If producers ever send non-JSON, ignore
                        return;
                    }

                    // Price channel
                    if (channel === "events:price:update") {
                        if (inner?.type === "MARKET_BOARD" && Array.isArray(inner.data)) {
                            const ts = inner.ts || outer.ts || Date.now();

                            const board = latestBoardRef.current || {};
                            const order = symbolOrderRef.current || [];
                            const seen = new Set(order);

                            for (const t of inner.data) {
                                const symbol = t?.symbol ? String(t.symbol).toUpperCase() : "";
                                if (!symbol) continue;
                                const price = Number(t.price);
                                if (!Number.isFinite(price)) continue;

                                if (!seen.has(symbol)) {
                                    if (order.length >= MAX_SYMBOLS) continue;
                                    order.push(symbol);
                                    seen.add(symbol);
                                }

                                board[symbol] = { price, ts };
                            }

                            latestBoardRef.current = board;
                            symbolOrderRef.current = order;
                            latestTsRef.current = ts;
                            return;
                        }

                        if (inner?.type === "PRICE_UPDATE" && inner.symbol) {
                            const price = Number(inner.price);
                            if (!Number.isFinite(price)) return;

                            const sym = String(inner.symbol).toUpperCase();
                            const ts = inner.ts || outer.ts || Date.now();

                            const board = latestBoardRef.current || {};
                            const order = symbolOrderRef.current || [];

                            if (!board[sym]) {
                                if (order.length >= MAX_SYMBOLS) return;
                                order.push(sym);
                                symbolOrderRef.current = order;
                            }

                            board[sym] = { price, ts };
                            latestBoardRef.current = board;
                            latestTsRef.current = ts;
                            return;
                        }
                    }

                    // Order status channel
                    if (channel === "events:order:status") {
                        const ev = inner;
                        const orderId = ev?.orderId || ev?.id;
                        if (!orderId) return;

                        setOrdersById((prev) => {
                            const next = { ...prev };
                            next[orderId] = { ...next[orderId], ...ev, orderId, updatedAt: Date.now() };

                            const ids = Object.keys(next);
                            if (ids.length > 1000) {
                                ids.sort((a, b) => (next[a]?.updatedAt || 0) - (next[b]?.updatedAt || 0));
                                const toDrop = ids.slice(0, ids.length - 1000);
                                for (const id of toDrop) delete next[id];
                            }
                            return next;
                        });

                        if (pendingOrderId && String(orderId) === String(pendingOrderId)) {
                            const st = String(ev?.status || "").toUpperCase();
                            const isFinal = ["FILLED", "REJECTED", "CANCELED", "CANCELLED", "EXPIRED"].includes(st);

                            setToast({
                                open: true,
                                title: isFinal ? "Order update" : "Order submitted",
                                status: st || "PENDING",
                                message: `${ev?.side || ""} ${ev?.symbol || ""} • qty ${ev?.quantity ?? "—"}`.trim(),
                            });

                            if (isFinal) setIsPlacingOrder(false);
                        }
                    }
                } catch {
                    // ignore parse errors
                }
            };
        };

        const scheduleReconnect = () => {
            if (cancelled) return;
            if (retryTimer) return;
            attempt += 1;
            const delay = Math.min(8000, 500 * attempt);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                connect();
            }, delay);
        };

        connect();

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            try {
                ws?.close();
            } catch { }
        };
    }, [wsBaseUrl, MAX_SYMBOLS, pendingOrderId]);

    useEffect(() => {
        try {
            const raw = localStorage.getItem("pinnedSymbols");
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) setPinned(new Set(arr.map((s) => String(s).toUpperCase())));
        } catch { }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem("pinnedSymbols", JSON.stringify(Array.from(pinned)));
        } catch { }
    }, [pinned]);


    useEffect(() => {
        try {
            localStorage.setItem("theme", theme);
        } catch { }

        document.documentElement.style.colorScheme = theme;
        if (theme === "dark") document.documentElement.classList.add("dark");
        else document.documentElement.classList.remove("dark");
    }, [theme]);

    useEffect(() => {
        // Flush latestBoardRef to state every UI_FLUSH_MS
        const interval = setInterval(() => {
            setMarketBoard({ ...latestBoardRef.current });
            setLastUpdateTs(latestTsRef.current);
        }, UI_FLUSH_MS);
        return () => clearInterval(interval);
    }, []);

    function togglePin(sym) {
        const s = String(sym).toUpperCase();
        setPinned((prev) => {
            const next = new Set(prev);
            if (next.has(s)) next.delete(s);
            else next.add(s);
            return next;
        });
    }

    function toggleTheme() {
        setTheme((t) => (t === "dark" ? "light" : "dark"));
    }

    function formatPrice(p) {
        if (!Number.isFinite(Number(p))) return "—";
        return Number(p).toFixed(6).replace(/\.?0+$/, "");
    }

    function asNumber(x) {
        const n = Number(x);
        return Number.isFinite(n) ? n : null;
    }

    function decimalsFromStep(step) {
        const s = String(step);
        const i = s.indexOf(".");
        return i === -1 ? 0 : s.length - i - 1;
    }

    function roundToStep(value, step) {
        const v = asNumber(value);
        const st = asNumber(step);
        if (v === null || st === null || st <= 0) return null;
        const d = decimalsFromStep(step);
        const snapped = Math.floor(v / st) * st;
        return Number(snapped.toFixed(d));
    }

    function trimZeros(n) {
        return String(n).replace(/\.?0+$/, "");
    }

    function formatByStep(value, step) {
        const v = asNumber(value);
        const st = asNumber(step);
        if (v === null) return "—";
        if (st === null || st <= 0) return trimZeros(v);

        const d = Math.min(decimalsFromStep(step), 8); // cap for UI
        return trimZeros(Number(v).toFixed(d));
    }

    function validateNotional({ qtyNum, info, orderType, priceForNotional }) {
        if (!info) return { ok: true };

        const minN = asNumber(info.minNotional);
        const maxN = asNumber(info.maxNotional);

        const applyMinToMarket = Boolean(info.applyMinToMarket);
        const applyMaxToMarket = Boolean(info.applyMaxToMarket);

        const shouldApplyMin = orderType !== "MARKET" || applyMinToMarket;
        const shouldApplyMax = orderType !== "MARKET" || applyMaxToMarket;

        if (!shouldApplyMin && !shouldApplyMax) return { ok: true };

        const p = asNumber(priceForNotional);
        if (p === null || p <= 0) return { ok: true }; // can't validate w/out a price

        const notional = p * qtyNum;

        if (shouldApplyMin && minN !== null && notional < minN) {
            return { ok: false, reason: `Notional too small: ${trimZeros(notional)} < min ${trimZeros(minN)} USDT` };
        }
        if (shouldApplyMax && maxN !== null && notional > maxN) {
            return { ok: false, reason: `Notional too large: ${trimZeros(notional)} > max ${trimZeros(maxN)} USDT` };
        }
        return { ok: true };
    }

    function validateQty(q, info) {
        const qn = asNumber(q);
        if (qn === null || qn <= 0) return { ok: false, reason: "Enter a valid quantity" };
        if (!info) return { ok: true };

        if (qn < Number(info.minQty)) {
            return { ok: false, reason: `Min qty is ${info.minQty}` };
        }

        const snapped = roundToStep(qn, info.stepSize);
        if (snapped === null) return { ok: true };

        // tolerate tiny float noise
        const eps = Math.pow(10, -(decimalsFromStep(info.stepSize) + 2));
        if (Math.abs(snapped - qn) > eps) {
            return { ok: false, reason: `Qty must be a multiple of ${info.stepSize}` };
        }

        return { ok: true };
    }

    // Zod error mapping helper
    function zodErrorMap(err) {
        // Convert ZodError into a simple { field: message } map
        const out = {};
        for (const issue of err.issues || []) {
            const key = (issue.path && issue.path.length ? issue.path[0] : "base") || "base";
            if (!out[key]) out[key] = issue.message;
        }
        return out;
    }

    // Build a Zod schema for order form validation
    function buildOrderSchema({ info, orderType, currentPrice }) {
        // Accept strings from inputs; transform to numbers where needed
        return z
            .object({
                qty: z
                    .string()
                    .trim()
                    .min(1, "Quantity is required"),
                limitPrice: z.string().trim().optional(),
                stopPrice: z.string().trim().optional(),
            })
            .superRefine((val, ctx) => {
                // Quantity
                const qcheck = validateQty(val.qty, info);
                if (!qcheck.ok) {
                    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qty"], message: qcheck.reason });
                    return;
                }

                const qtyNum = Number(val.qty);

                // Order-type specific price validation
                let priceForNotional = currentPrice;

                if (orderType === "LIMIT") {
                    const p = Number(val.limitPrice);
                    if (!Number.isFinite(p) || p <= 0) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limitPrice"], message: "Enter a valid limit price" });
                        return;
                    }
                    priceForNotional = p;
                }

                if (orderType === "STOP_MARKET") {
                    const sp = Number(val.stopPrice);
                    if (!Number.isFinite(sp) || sp <= 0) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stopPrice"], message: "Enter a valid stop price" });
                        return;
                    }
                    priceForNotional = sp;
                }

                // Notional validation (minNotional/maxNotional)
                const ncheck = validateNotional({ qtyNum, info, orderType, priceForNotional });
                if (!ncheck.ok) {
                    // Show this as a general form error (not tied to one field)
                    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notional"], message: ncheck.reason });
                    return;
                }
            });
    }

    const isDark = theme === "dark";

    useEffect(() => {
        let cancelled = false;

        async function fetchSymbolInfo() {
            setSymbolInfoStatus("loading");
            setSymbolInfoError("");

            try {
                const res = await fetch(
                    `${eventBaseUrl}/symbol-info?symbol=${selectedSymbol}`
                );
                const json = await res.json();

                if (!res.ok) throw new Error(json.error || "Failed to load symbol info");

                if (!cancelled) {
                    setSymbolInfo(json.data);
                    setSymbolInfoStatus("ready");

                    // snap qty to step size
                    const snapped = roundToStep(qty, json.data.stepSize);
                    if (snapped !== null) setQty(String(snapped));
                }
            } catch (err) {
                if (!cancelled) {
                    setSymbolInfo(null);
                    setSymbolInfoStatus("error");
                    setSymbolInfoError(err.message);
                }
            }
        }

        fetchSymbolInfo();
        return () => (cancelled = true);
    }, [selectedSymbol]);

    async function placeOrder() {
        if (!userIdRef.current) {
            setApiMsg("Not authenticated. Please login again.");
            router.push("/login");
            return;
        }
        setApiMsg("");
        setFormErrors({});
        if (isPlacingOrder) return;
        setIsPlacingOrder(true);

        const schema = buildOrderSchema({ info: symbolInfo, orderType, currentPrice: asNumber(currentPrice) });
        const parsed = schema.safeParse({
            qty,
            limitPrice,
            stopPrice,
        });

        if (!parsed.success) {
            const map = zodErrorMap(parsed.error);
            setFormErrors(map);
            // Also show a short message in apiMsg for visibility
            setApiMsg(map.notional || map.qty || map.limitPrice || map.stopPrice || map.base || "Fix the highlighted fields");
            setIsPlacingOrder(false);
            return;
        }

        let qtyNum = Number(parsed.data.qty);
        let limitPriceNum = orderType === "LIMIT" ? Number(parsed.data.limitPrice) : undefined;
        let stopPriceNum = orderType === "STOP_MARKET" ? Number(parsed.data.stopPrice) : undefined;

        // Snap inputs to exchange filters (stepSize, tickSize)
        if (symbolInfo) {
            if (symbolInfo.stepSize) {
                const s = roundToStep(qtyNum, symbolInfo.stepSize);
                if (s !== null) qtyNum = s;
            }
            if (symbolInfo.tickSize) {
                if (limitPriceNum !== undefined) {
                    const s = roundToStep(limitPriceNum, symbolInfo.tickSize);
                    if (s !== null) limitPriceNum = s;
                }
                if (stopPriceNum !== undefined) {
                    const s = roundToStep(stopPriceNum, symbolInfo.tickSize);
                    if (s !== null) stopPriceNum = s;
                }
            }
        }

        setApiMsg("Placing order...");
        const clientOrderId =
            typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        setPendingOrderId(clientOrderId);
        setToast({
            open: true,
            title: "Placing order",
            status: "PENDING",
            message: `${side} ${selectedSymbol} • qty ${qtyNum}`,
        });

        try {
            const payload = {
                orderId: clientOrderId,
                userId: userIdRef.current,
                symbol: String(selectedSymbol || "").toUpperCase(),
                side: String(side || "").toUpperCase(),
                orderType: String(orderType || "MARKET").toUpperCase(),
                quantity: qtyNum,
                price: limitPriceNum,
                stopPrice: stopPriceNum,
                meta: {}
            };

            if (orderType === "LIMIT") {
                payload.timeInForce = "GTC";
            }

            const res = await fetch(`${eventBaseUrl}/orders`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload),
            });

            const data = await res.json();
            if (!res.ok || !data.ok) {
                setIsPlacingOrder(false);
                setApiMsg(data.error || "Order failed");
                return;
            }

            setApiMsg("Order sent. Waiting for status...");
        } catch (e) {
            setIsPlacingOrder(false);
            setApiMsg("Network error");
        }
    }

    const f = filter.trim().toLowerCase();

    // Keep table stable: insertion order + pinned coins on top
    const orderedSymbols = symbolOrderRef.current;

    const pinnedList = Array.from(pinned);
    const pinnedSet = pinned;

    const pinnedRows = pinnedList
        .map((sym) => [sym, marketBoard[sym]])
        .filter(([sym, v]) => v && (!f || sym.toLowerCase().includes(f)));

    const regularRows = orderedSymbols
        .filter((sym) => !pinnedSet.has(sym))
        .map((sym) => [sym, marketBoard[sym]])
        .filter(([sym, v]) => v && (!f || sym.toLowerCase().includes(f)));

    const rows = [...pinnedRows, ...regularRows];
    const shown = rows.slice(0, MAX_SYMBOLS);

    // Derived rows (pinned first)
    const totalSymbols = symbolOrderRef.current.length;

    const currentPrice = marketBoard[selectedSymbol]?.price;

    const priceLabel =
        orderType === "MARKET" ? "Price" : orderType === "STOP_MARKET" ? "Stop price" : "Limit price";

    const pricePlaceholder =
        orderType === "MARKET"
            ? "Market price"
            : orderType === "STOP_MARKET"
                ? "Enter stop price"
                : "Enter limit price";

    const priceValue =
        orderType === "MARKET"
            ? (Number.isFinite(Number(currentPrice)) ? String(currentPrice) : "")
            : orderType === "STOP_MARKET"
                ? stopPrice
                : limitPrice;

    const mockPositions = [
        { symbol: "BTCUSDT", size: "0.05", entry: "65000", mark: "67000", uPnl: "+100", rPnl: "+0" },
        { symbol: "ETHUSDT", size: "0.8", entry: "3200", mark: "3150", uPnl: "-40", rPnl: "+20" },
        { symbol: "SOLUSDT", size: "5", entry: "180", mark: "186", uPnl: "+30", rPnl: "+0" },
    ];

    return (
        <main className={`${inter.className} min-h-screen w-screen ${isDark ? "bg-slate-950 text-slate-100" : "bg-slate-50 text-slate-900"}`}>
            {/* Topbar */}
            <div className={`${isDark ? "bg-slate-900 border-slate-800" : "bg-slate-100 border-slate-200"} border-b`}>
                <div className="mx-auto p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3 font-semibold tracking-wide">
                        <Image src="/logo.png" alt="Logo" className={isDark ? "invert" : ""} width={28} height={28} />
                        <Image src="/numatix.png" alt="Logo text" className={isDark ? "invert" : ""} width={96} height={22} />
                    </div>

                    <div className="flex items-center gap-3">
                        <div className={`${isDark ? "bg-slate-950 border-slate-700 text-slate-200" : "bg-white border-slate-200 text-slate-700"} flex items-center gap-2 border px-3 py-2 text-sm rounded-full`}>
                            <span className="h-2 w-2 rounded-full bg-emerald-400" />
                            <span className="font-medium">Live trading</span>
                        </div>

                        <button
                            onClick={toggleTheme}
                            title="Toggle theme"
                            className={`${isDark ? "bg-slate-950 border-slate-700 hover:bg-slate-900" : "bg-white border-slate-200 hover:bg-slate-50"} border px-3 py-2 text-sm rounded-full`}
                        >
                            {isDark ? "Dark" : "Light"}
                        </button>

                        <button
                            title="Settings (mock)"
                            className={`${isDark ? "bg-slate-950 border-slate-700 hover:bg-slate-900" : "bg-white border-slate-200 hover:bg-slate-50"} border px-3 py-2 text-sm rounded-full`}
                        >
                            ⚙
                        </button>

                        <button
                            title="Account (mock)"
                            className={`${isDark ? "bg-slate-950 border-slate-700 hover:bg-slate-900" : "bg-white border-slate-200 hover:bg-slate-50"} border px-3 py-2 text-sm rounded-full`}
                        >
                            ☺
                        </button>
                    </div>
                </div>
            </div>

            <div className="mx-auto py-6">
                <h1 className="text-2xl font-semibold mb-5 px-3">Portfolio</h1>

                <div className="grid gap-5 lg:grid-cols-[360px_1fr] px-5">
                    {/* Left column */}
                    <div className="space-y-5">
                        {/* Order box */}
                        <div className={`${isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200"} border p-4`}>
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setSide("BUY")}
                                        className={`${side === "BUY" ? (isDark ? "bg-slate-950 border-slate-700" : "bg-slate-200 border-slate-200") : (isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200")} border px-4 py-2 text-sm font-medium`}
                                    >
                                        BUY
                                    </button>
                                    <button
                                        onClick={() => {
                                            setSide("SELL");
                                            if (orderType === "STOP_MARKET") setOrderType("MARKET");
                                        }}
                                        className={`${side === "SELL" ? (isDark ? "bg-slate-950 border-slate-700" : "bg-slate-200 border-slate-200") : (isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200")} border px-4 py-2 text-sm font-medium`}
                                    >
                                        SELL
                                    </button>
                                </div>
                            </div>

                            <div className="flex gap-3 text-sm mb-4">
                                {["LIMIT", "MARKET", "STOP_MARKET"].map((t) => {
                                    if (side === "SELL" && t === "STOP_MARKET") return null;
                                    return (
                                        <button
                                            key={t}
                                            onClick={() => {
                                                setOrderType(t);
                                                if (t !== "LIMIT") setLimitPrice("");
                                                if (t !== "STOP_MARKET") setStopPrice("");
                                            }}
                                            className={`${orderType === t ? (isDark ? "text-slate-100" : "text-slate-900") : (isDark ? "text-slate-300" : "text-slate-500")} font-medium`}
                                        >
                                            {t === "STOP_MARKET" ? "Stop Market" : t[0] + t.slice(1).toLowerCase()}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="space-y-3">
                                <div>
                                    <div className={`text-sm mb-1 ${isDark ? "text-slate-300" : "text-slate-500"}`}>
                                        {priceLabel}
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <input
                                            className={`${isDark ? "bg-slate-950 border-slate-800" : "bg-white border-slate-200"} border px-3 py-2 text-sm w-full outline-none`}
                                            placeholder={pricePlaceholder}
                                            disabled={orderType === "MARKET"}
                                            value={priceValue}
                                            onChange={(e) => {
                                                const v = e.target.value;
                                                if (orderType === "STOP_MARKET") {
                                                    setStopPrice(v);
                                                    setFormErrors((prev) => ({ ...prev, stopPrice: undefined, notional: undefined }));
                                                } else if (orderType === "LIMIT") {
                                                    setLimitPrice(v);
                                                    setFormErrors((prev) => ({ ...prev, limitPrice: undefined, notional: undefined }));
                                                }
                                            }}
                                        />
                                        <div className={`text-xs ${isDark ? "text-slate-300" : "text-slate-500"}`}>USDT</div>
                                    </div>

                                    {orderType === "MARKET" ? (
                                        <div className={`mt-1 text-xs ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                                            Market orders execute at the best available price.
                                        </div>
                                    ) : null}
                                    {orderType === "LIMIT" && formErrors.limitPrice ? (
                                        <div className="mt-1 text-xs text-rose-500">{formErrors.limitPrice}</div>
                                    ) : null}
                                    {orderType === "STOP_MARKET" && formErrors.stopPrice ? (
                                        <div className="mt-1 text-xs text-rose-500">{formErrors.stopPrice}</div>
                                    ) : null}
                                    {formErrors.notional ? (
                                        <div className="mt-1 text-xs text-rose-500">{formErrors.notional}</div>
                                    ) : null}
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <div className={`text-sm mb-1 ${isDark ? "text-slate-300" : "text-slate-500"}`}>Quantity</div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                className={`${isDark ? "bg-slate-950 border-slate-800" : "bg-white border-slate-200"} border px-3 py-2 text-sm w-full outline-none`}
                                                value={qty}
                                                onChange={(e) => {
                                                    setQty(e.target.value);
                                                    setFormErrors((prev) => ({ ...prev, qty: undefined, notional: undefined }));
                                                }}
                                                placeholder="0.01"
                                            />
                                            <div className={`text-xs ${isDark ? "text-slate-300" : "text-slate-500"}`}>{selectedSymbol.replace("USDT", "")}</div>
                                        </div>
                                        {formErrors.qty ? (
                                            <div className="mt-1 text-xs text-rose-500">{formErrors.qty}</div>
                                        ) : null}
                                    </div>
                                    <div>
                                        <div className={`text-sm mb-1 ${isDark ? "text-slate-300" : "text-slate-500"}`}>Total</div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                className={`${isDark ? "bg-slate-950 border-slate-800" : "bg-white border-slate-200"} border px-3 py-2 text-sm w-full outline-none`}
                                                placeholder=""
                                                disabled
                                                value={`${formatPrice(currentPrice * Number(qty) || 0)}`}
                                                readOnly
                                            />
                                            <div className={`text-xs ${isDark ? "text-slate-300" : "text-slate-500"}`}>USDT</div>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between pt-2">
                                    <div className={`text-sm ${isDark ? "text-slate-300" : "text-slate-600"}`}>Last price</div>
                                    <div className="text-sm font-semibold tabular-nums">{formatPrice(currentPrice)}</div>
                                </div>

                                {symbolInfoStatus === "error" && (
                                    <div className="text-xs text-rose-500 mt-1">
                                        {symbolInfoError}
                                    </div>
                                )}

                                <div className="pt-3">
                                    <button
                                        onClick={placeOrder}
                                        disabled={isPlacingOrder}
                                        className={`${isDark ? "bg-slate-100 text-slate-900 hover:bg-white" : "bg-slate-900 text-white hover:bg-slate-800"} w-full px-4 py-3 text-sm font-semibold ${isPlacingOrder ? "opacity-60 cursor-not-allowed" : ""}`}
                                    >
                                        {isPlacingOrder ? "Submitting..." : (
                                            <>
                                                {side === "BUY" ? "Buy" : "Sell"} {selectedSymbol.replace("USDT", "/USDT")} ({orderType === "STOP_MARKET" ? "STOP" : orderType})
                                            </>
                                        )}
                                    </button>
                                    {/* {apiMsg ? <div className={`mt-2 text-sm ${isDark ? "text-slate-300" : "text-slate-500"}`}>{apiMsg}</div> : null} */}
                                </div>
                            </div>
                        </div>

                        {/* Account box (mock) */}
                        <div className={`${isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200"} border p-4`}>
                            <h3 className="font-semibold mb-4">Account</h3>
                            <div className="space-y-3 text-sm">
                                <div className="flex items-center justify-between">
                                    <span className={isDark ? "text-slate-300" : "text-slate-600"}>Margin Ratio</span>
                                    <span className="font-medium">0.00%</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className={isDark ? "text-slate-300" : "text-slate-600"}>Maintenance Margin</span>
                                    <span className="font-medium tabular-nums">0.000000 USDT</span>
                                </div>
                                <div className="pt-2 text-xs opacity-60">(mock section)</div>
                            </div>
                        </div>
                    </div>

                    {/* Right column */}
                    <div className="space-y-5">
                        {/* Chart container */}
                        <div className={`${isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200"} border p-4`}>
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <div className={`text-sm font-semibold ${isDark ? "text-slate-200" : "text-slate-700"}`}>{selectedSymbol.replace("USDT", "/USDT")}</div>
                                    <div className="mt-2 flex items-center gap-3">
                                        <div className="text-3xl font-semibold tabular-nums">{formatPrice(currentPrice)}</div>
                                        <div className={`${isDark ? "bg-emerald-950 text-emerald-200" : "bg-emerald-50 text-emerald-700"} px-3 py-1 text-xs font-semibold`}>Live</div>
                                    </div>
                                </div>

                                <div className={`${isDark ? "bg-slate-950 border-slate-800" : "bg-slate-50 border-slate-200"} border flex text-sm`}>
                                    {["1m", "5m", "1D", "1W"].map((t, idx) => (
                                        <button
                                            key={t}
                                            className={`${idx !== 0 ? (isDark ? "border-slate-800" : "border-slate-200") : ""} border-l px-3 py-2 font-medium ${t === "1D" ? (isDark ? "text-slate-100" : "text-slate-900") : (isDark ? "text-slate-400" : "text-slate-500")}`}
                                        >
                                            {t}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className={`${isDark ? "bg-slate-950 border-slate-800" : "bg-white border-slate-200"} border mt-4 h-72 flex items-center justify-center`}
                            >
                                <div className={`text-sm ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                                    Chart placeholder (next step: candlesticks)
                                </div>
                            </div>
                        </div>

                        {/* Tabs + table */}
                        <div className={`${isDark ? "bg-slate-900 border-slate-800" : "bg-white border-slate-200"} border`}>
                            <div className={`${isDark ? "border-slate-800" : "border-slate-200"} border-b px-4 py-3 flex items-center justify-between gap-3`}
                            >
                                <div className="flex items-center gap-2 text-sm">
                                    {[
                                        { id: "positions", label: "Positions" },
                                        { id: "orders", label: "Orders" },
                                        { id: "trades", label: "Trades" },
                                    ].map((t) => (
                                        <button
                                            key={t.id}
                                            onClick={() => setActiveTab(t.id)}
                                            className={`${activeTab === t.id ? (isDark ? "text-slate-100" : "text-slate-900") : (isDark ? "text-slate-400" : "text-slate-500")} font-medium px-2 py-1`}
                                        >
                                            {t.label}
                                        </button>
                                    ))}
                                </div>

                                {activeTab === "trades" ? (
                                    <div className="flex items-center gap-2">
                                        <input
                                            className={`${isDark ? "bg-slate-950 border-slate-800" : "bg-white border-slate-200"} border px-3 py-2 text-sm outline-none w-64`}
                                            value={filter}
                                            onChange={(e) => setFilter(e.target.value)}
                                            placeholder="Search"
                                        />
                                    </div>
                                ) : (
                                    <div />
                                )}
                            </div>

                            {/* Tables */}
                            <div className="overflow-auto" style={{ maxHeight: "48vh" }}>
                                {activeTab === "positions" ? (
                                    <table className="w-full text-sm">
                                        <thead className={`${isDark ? "text-slate-400 border-slate-800" : "text-slate-500 border-slate-200"} border-b`}
                                        >
                                            <tr>
                                                <th className="px-4 py-3 text-left font-medium">Transaction</th>
                                                <th className="px-4 py-3 text-left font-medium">Size</th>
                                                <th className="px-4 py-3 text-left font-medium">Entry price</th>
                                                <th className="px-4 py-3 text-left font-medium">Market price</th>
                                                <th className="px-4 py-3 text-left font-medium">Realized PnL</th>
                                                <th className="px-4 py-3 text-left font-medium">Unrealized PnL</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {mockPositions.map((p) => (
                                                <tr key={p.symbol} className={isDark ? "border-b border-slate-800" : "border-b border-slate-100"}>
                                                    <td className="px-4 py-4 font-medium cursor-pointer" onClick={() => setSelectedSymbol(p.symbol)}>{p.symbol.replace("USDT", "/USDT")}</td>
                                                    <td className="px-4 py-4 tabular-nums">{p.size}</td>
                                                    <td className="px-4 py-4 tabular-nums">{p.entry}</td>
                                                    <td className="px-4 py-4 tabular-nums">{p.mark}</td>
                                                    <td className="px-4 py-4 tabular-nums">{p.rPnl}</td>
                                                    <td className="px-4 py-4 tabular-nums">{p.uPnl}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : null}

                                {activeTab === "orders" ? (
                                    <table className="w-full text-sm">
                                        <thead className={`${isDark ? "text-slate-400 border-slate-800" : "text-slate-500 border-slate-200"} border-b`}
                                        >
                                            <tr>
                                                <th className="px-4 py-3 text-left font-medium">ID</th>
                                                <th className="px-4 py-3 text-left font-medium">Symbol</th>
                                                <th className="px-4 py-3 text-left font-medium">Side</th>
                                                <th className="px-4 py-3 text-left font-medium">Type</th>
                                                <th className="px-4 py-3 text-left font-medium">Qty</th>
                                                <th className="px-4 py-3 text-left font-medium">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {Object.values(ordersById)
                                                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                                                .map((o) => (
                                                    <tr key={o.orderId} className={isDark ? "border-b border-slate-800" : "border-b border-slate-100"}>
                                                        <td className={`px-4 py-4 ${isDark ? "text-slate-300" : "text-slate-500"}`}>{String(o.orderId).slice(0, 10)}…</td>
                                                        <td className="px-4 py-4 font-medium cursor-pointer" onClick={() => setSelectedSymbol(o.symbol)}>
                                                            {String(o.symbol || "").replace("USDT", "/USDT")}
                                                        </td>
                                                        <td className="px-4 py-4">{o.side || "—"}</td>
                                                        <td className="px-4 py-4">{o.orderType || o.type || "—"}</td>
                                                        <td className="px-4 py-4 tabular-nums">{o.quantity ?? "—"}</td>
                                                        <td className="px-4 py-4">{o.status || "—"}</td>
                                                    </tr>
                                                ))}

                                            {Object.keys(ordersById).length === 0 ? (
                                                <tr>
                                                    <td colSpan={6} className={`px-4 py-4 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                                                        No orders yet…
                                                    </td>
                                                </tr>
                                            ) : null}
                                        </tbody>
                                    </table>
                                ) : null}

                                {activeTab === "trades" ? (
                                    <table className="w-full text-sm">
                                        <thead className={`${isDark ? "text-slate-400 border-slate-800" : "text-slate-500 border-slate-200"} border-b`}
                                        >
                                            <tr>
                                                <th className="px-4 py-3 text-left font-medium w-16">Pin</th>
                                                <th className="px-4 py-3 text-left font-medium">Symbol</th>
                                                <th className="px-4 py-3 text-left font-medium">Last</th>
                                                <th className="px-4 py-3 text-left font-medium">Updated</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {shown.map(([sym, v]) => (
                                                <tr key={sym} className={isDark ? "border-b border-slate-800" : "border-b border-slate-100"}>
                                                    <td className="px-4 py-3">
                                                        <button
                                                            onClick={() => togglePin(sym)}
                                                            title={pinned.has(sym) ? "Unpin" : "Pin"}
                                                            className={`${isDark ? "bg-slate-950 border-slate-800 hover:bg-slate-900" : "bg-white border-slate-200 hover:bg-slate-50"} border px-2 py-1 text-sm`}
                                                        >
                                                            {pinned.has(sym) ? "★" : "☆"}
                                                        </button>
                                                    </td>
                                                    <td className="px-4 py-3 font-medium cursor-pointer" onClick={() => setSelectedSymbol(sym)}>
                                                        {sym.replace("USDT", "/USDT")}
                                                    </td>
                                                    <td className="px-4 py-3 tabular-nums">{formatPrice(v.price)}</td>
                                                    <td className={`px-4 py-3 ${isDark ? "text-slate-400" : "text-slate-500"}`}>{v.ts ? new Date(v.ts).toLocaleTimeString() : "—"}</td>
                                                </tr>
                                            ))}

                                            {shown.length === 0 ? (
                                                <tr>
                                                    <td colSpan={4} className={`px-4 py-4 ${isDark ? "text-slate-400" : "text-slate-500"}`}>Waiting for prices…</td>
                                                </tr>
                                            ) : null}
                                        </tbody>
                                    </table>
                                ) : null}
                            </div>

                            <div className={`${isDark ? "border-slate-800 text-slate-400" : "border-slate-200 text-slate-500"} border-t px-4 py-3 text-sm flex items-center justify-between`}
                            >
                                <div>
                                    WS: <span className={isDark ? "text-slate-200" : "text-slate-700"}>{status}</span>
                                    <span className={isDark ? "text-slate-500" : "text-slate-400"}> · msgs {wsMsgCount}</span>
                                </div>
                                <div>Symbols: <span className={isDark ? "text-slate-200" : "text-slate-700"}>{totalSymbols}</span> | Pinned: <span className={isDark ? "text-slate-200" : "text-slate-700"}>{pinned.size}</span></div>
                            </div>
                        </div>

                        <details className="text-sm">
                            <summary className={`${isDark ? "text-slate-400" : "text-slate-500"} cursor-pointer`}>Debug: last WS envelope</summary>
                            <pre className={`${isDark ? "bg-slate-950 border-slate-800 text-slate-100" : "bg-white border-slate-200 text-slate-900"} border mt-2 p-3 overflow-x-auto text-xs`}>
                                {lastEvent ? JSON.stringify(lastEvent, null, 2) : "Waiting..."}
                            </pre>
                        </details>
                    </div>
                </div>
            </div>
            {toast.open ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    {/* Backdrop */}
                    <div
                        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
                        onClick={() => {
                            // allow closing only if not actively placing
                            if (!isPlacingOrder) setToast((t) => ({ ...t, open: false }));
                        }}
                    />

                    {/* Toast card */}
                    <div className={`${isDark ? "bg-slate-900 border-slate-800 text-slate-100" : "bg-white border-slate-200 text-slate-900"} relative border w-[92vw] max-w-md p-4`}
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <div className="text-sm font-semibold">{toast.title}</div>
                                <div className={`${isDark ? "text-slate-300" : "text-slate-600"} mt-1 text-sm`}>{toast.message}</div>
                                <div className={`${isDark ? "text-slate-400" : "text-slate-500"} mt-2 text-xs`}>Status: <span className="font-semibold">{toast.status || "PENDING"}</span></div>
                            </div>

                            <button
                                className={`${isDark ? "bg-slate-950 border-slate-800 hover:bg-slate-900" : "bg-white border-slate-200 hover:bg-slate-50"} border px-3 py-2 text-sm`}
                                onClick={() => {
                                    if (!isPlacingOrder) setToast((t) => ({ ...t, open: false }));
                                }}
                                disabled={isPlacingOrder}
                                title={isPlacingOrder ? "Waiting for status" : "Close"}
                            >
                                ✕
                            </button>
                        </div>

                        <div className="mt-4 flex items-center justify-end gap-2">
                            <button
                                className={`${isDark ? "bg-slate-950 border-slate-800 hover:bg-slate-900" : "bg-white border-slate-200 hover:bg-slate-50"} border px-3 py-2 text-sm`}
                                onClick={() => {
                                    setActiveTab("orders");
                                    setToast((t) => ({ ...t, open: false }));
                                }}
                            >
                                View orders
                            </button>

                            <button
                                className={`${isDark ? "bg-slate-100 text-slate-900 hover:bg-white" : "bg-slate-900 text-white hover:bg-slate-800"} px-3 py-2 text-sm font-semibold`}
                                onClick={() => {
                                    if (!isPlacingOrder) setToast((t) => ({ ...t, open: false }));
                                }}
                                disabled={isPlacingOrder}
                            >
                                OK
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </main>
    );
}