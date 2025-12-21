import { verifyToken } from "./jwt.js";

export function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
        return res.status(401).json({ ok: false, error: "Missing Bearer token" });
    }

    try {
        const decoded = verifyToken(token);
        req.user = { id: decoded.userId, email: decoded.email };
        return next();
    } catch {
        return res.status(401).json({ ok: false, error: "Invalid/expired token" });
    }
}