"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { setToken, decodeToken } from "../lib/auth";

// Zod schema for login validation
const loginSchema = z.object({
    email: z.string().email("Enter a valid email address"),
    password: z
        .string()
        .min(6, "Password must be at least 6 characters long"),
});

export default function LoginPage() {
    const router = useRouter();

    const [form, setForm] = useState({ email: "", password: "" });
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

        const parsed = loginSchema.safeParse(form);
        if (!parsed.success) {
            const fieldErrors = {};
            parsed.error.errors.forEach((err) => {
                fieldErrors[err.path[0]] = err.message;
            });
            setErrors(fieldErrors);
            return;
        }

        try {
            setLoading(true);

            const baseUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080").replace(/\/$/, "");
            const res = await fetch(`${baseUrl}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(form),
            });

            const data = await res.json();
            if (!data.ok) {
                setServerMsg(data.error || "Login failed");
                return;
            }

            setToken(data.token);

            // Decode JWT payload (frontend-only) and persist userId for later API calls
            const decoded = decodeToken();
            const userId = decoded?.userId || decoded?.id || decoded?.sub || null;
            if (userId) {
                localStorage.setItem("userId", String(userId));
            } else {
                // Not fatal, but helps debugging if backend token doesn't include userId
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
                <h1 className="text-2xl font-semibold mb-6">Sign in</h1>

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
                        />
                        {errors.password && (
                            <p className="text-xs text-red-400 mt-1">{errors.password}</p>
                        )}
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full mt-2 rounded-md bg-white text-black py-2 font-medium disabled:opacity-60"
                    >
                        {loading ? "Signing in…" : "Sign in"}
                    </button>
                </form>

                <div className="mt-6 text-sm text-neutral-400 text-center">
                    <span>Don’t have an account? </span>
                    <button
                        type="button"
                        onClick={() => router.push("/register")}
                        className="text-white underline underline-offset-4 hover:opacity-80 hover:cursor-pointer"
                    >
                        Sign up
                    </button>
                </div>

                {serverMsg && (
                    <p className="text-sm text-red-400 mt-4">{serverMsg}</p>
                )}
            </div>
        </main>
    );
}