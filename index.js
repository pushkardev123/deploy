import crypto from "crypto";

async function getAccountInfo(apiKey, apiSecret) {
    const base = "https://testnet.binance.vision/api/v3/account";
    const timestamp = Date.now();
    const qs = `timestamp=${timestamp}`;

    // create signature
    const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(qs)
        .digest("hex");

    const url = `${base}?${qs}&signature=${signature}`;

    const res = await fetch(url, {
        headers: { "X-MBX-APIKEY": apiKey }
    });

    return await res.json();
}