

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { setToken, decodeToken } from "../lib/auth";

// Signup schema: email + password + Binance keys
const signupSchema = z
    .object({
        email: z.string().email("Enter a valid email address"),
        password: z
            .string()
            .min(6, "Password must be at least 6 characters long"),
        confirmPassword: z
            .string()
            .min(6, "Confirm your password"),
        binanceApiKey: z.string().min(1, "Binance API key is required"),
        binanceSecretKey: z.string().min(1, "Binance secret key is required"),
    })
    .refine((v) => v.password === v.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
    });

export default function SignupPage() {
    const router = useRouter();

    const [form, setForm] = useState({
        email: "",
        password: "",
        confirmPassword: "",
        binanceApiKey: "",
        binanceSecretKey: "",
    });
    const [errors, setErrors] = useState({});
    const [loading, setLoading] = useState(false);
    const [serverMsg, setServerMsg] = useState("");

    function handleChange(e) {
        setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    }

    async function onSubmit(e) {
        e.preventDefault();
        setErrors({});
        setServerMsg("");

        const parsed = signupSchema.safeParse(form);
        if (!parsed.success) {
            const fieldErrors = {};
            parsed.error.errors.forEach((err) => {
                const key = err.path?.[0] || "form";
                fieldErrors[key] = err.message;
            });
            setErrors(fieldErrors);
            return;
        }

        try {
            setLoading(true);

            const baseUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080").replace(/\/$/, "");
            const res = await fetch(`${baseUrl}/auth/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: form.email,
                    password: form.password,
                    binanceApiKey: form.binanceApiKey,
                    binanceSecretKey: form.binanceSecretKey,
                }),
            });

            const data = await res.json();
            if (!data.ok) {
                setServerMsg(data.error || "Sign up failed");
                return;
            }

            setToken(data.token);

            // Decode JWT payload (frontend-only) and persist userId
            const decoded = decodeToken();
            const userId = decoded?.userId || decoded?.id || decoded?.sub || null;
            if (userId) {
                localStorage.setItem("userId", String(userId));
            } else {
                console.warn("JWT decoded but userId claim missing:", decoded);
            }

            router.push("/trade");
        } catch (err) {
            setServerMsg("Something went wrong. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
            <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-lg">
                <h1 className="text-2xl font-semibold mb-2">Create account</h1>
                <p className="text-sm text-neutral-400 mb-6">
                    Use your Binance Testnet keys. These are stored encrypted.
                </p>

                <form onSubmit={onSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm mb-1">Email</label>
                        <input
                            name="email"
                            type="email"
                            value={form.email}
                            onChange={handleChange}
                            className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 outline-none focus:border-neutral-500"
                            placeholder="you@example.com"
                            autoComplete="email"
                        />
                        {errors.email && (
                            <p className="text-xs text-red-400 mt-1">{errors.email}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm mb-1">Password</label>
                        <input
                            name="password"
                            type="password"
                            value={form.password}
                            onChange={handleChange}
                            className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 outline-none focus:border-neutral-500"
                            placeholder="••••••••"
                            autoComplete="new-password"
                        />
                        {errors.password && (
                            <p className="text-xs text-red-400 mt-1">{errors.password}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm mb-1">Confirm password</label>
                        <input
                            name="confirmPassword"
                            type="password"
                            value={form.confirmPassword}
                            onChange={handleChange}
                            className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 outline-none focus:border-neutral-500"
                            placeholder="••••••••"
                            autoComplete="new-password"
                        />
                        {errors.confirmPassword && (
                            <p className="text-xs text-red-400 mt-1">{errors.confirmPassword}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm mb-1">Binance API key</label>
                        <input
                            name="binanceApiKey"
                            type="text"
                            value={form.binanceApiKey}
                            onChange={handleChange}
                            className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 outline-none focus:border-neutral-500"
                            placeholder="Paste API key"
                            autoComplete="off"
                        />
                        {errors.binanceApiKey && (
                            <p className="text-xs text-red-400 mt-1">{errors.binanceApiKey}</p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm mb-1">Binance secret key</label>
                        <input
                            name="binanceSecretKey"
                            type="password"
                            value={form.binanceSecretKey}
                            onChange={handleChange}
                            className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 outline-none focus:border-neutral-500"
                            placeholder="Paste secret key"
                            autoComplete="off"
                        />
                        {errors.binanceSecretKey && (
                            <p className="text-xs text-red-400 mt-1">{errors.binanceSecretKey}</p>
                        )}
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full mt-2 rounded-md bg-white text-black py-2 font-medium disabled:opacity-60"
                    >
                        {loading ? "Creating…" : "Create account"}
                    </button>
                </form>

                <div className="mt-6 text-sm text-neutral-400 text-center">
                    <span>Already have an account? </span>
                    <button
                        type="button"
                        onClick={() => router.push("/login")}
                        className="text-white underline underline-offset-4 hover:opacity-80"
                    >
                        Sign in
                    </button>
                </div>

                {serverMsg && <p className="text-sm text-red-400 mt-4">{serverMsg}</p>}
            </div>
        </main>
    );
}