// Schussental Showdown – Admin: Profilbilder freigeben/sperren und hochladen.
// Läuft als Supabase Edge Function im Projekt "giffig". Schreibzugriffe nur mit dem
// Service-Schlüssel hier auf dem Server. Login mit demselben Owner-Passwort wie die Giffig-Admin-Seite
// (gespeichert als PBKDF2-Hash in public.admin_config).
import { createClient } from "npm:@supabase/supabase-js@2";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return keys.default ?? (Object.values(keys)[0] as string) ?? "";
  } catch {
    return "";
  }
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

const BUCKET = "ctf-images";
const TOKEN_TTL_MS = 8 * 3600 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const ID_RE = /^[a-z0-9-]{1,40}$/;
const NAME_RE = /^[A-Za-zÄÖÜäöüß0-9 _.-]{1,24}$/;
const ORIGIN_OK = /^(https:\/\/marlonm05\.github\.io|https:\/\/[a-z0-9-]+(--[a-z0-9-]+)?\.netlify\.app|http:\/\/localhost:\d+|http:\/\/127\.0\.0\.1:\d+)$/;
const enc = new TextEncoder();

const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (u: Uint8Array) => toB64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rid = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function derive(pw: string, saltB64: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations }, key, 256);
  return toB64(new Uint8Array(bits));
}
async function hmac(keyB64: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", fromB64(keyB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(o) ? o : "https://marlonm05.github.io",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const clientIp = (req: Request) =>
  req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? (req.headers.get("x-forwarded-for") ?? "").split(",").pop()?.trim() ?? "unknown";

async function config() {
  const { data } = await db.from("admin_config").select("salt,hash,iterations,token_key").eq("id", 1).maybeSingle();
  if (!data) throw new HttpError(503, "Admin-Passwort ist noch nicht eingerichtet (über die Giffig-Admin-Seite einrichten).");
  return data as { salt: string; hash: string; iterations: number; token_key: string };
}
// Nur der Owner darf hier etwas ändern
async function requireOwner(token: unknown) {
  const [exp, uid, sig] = String(token ?? "").split(".");
  if (!exp || uid !== "owner" || !sig || Number(exp) < Date.now()) throw new HttpError(401, "auth");
  const cfg = await config();
  if (!safeEq(toB64Url(await hmac(cfg.token_key, `${exp}.${uid}`)), sig)) throw new HttpError(401, "auth");
}
async function throttle(ip: string) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count } = await db.from("admin_attempts").select("id", { count: "exact", head: true }).eq("ip", ip).gte("at", since);
  if ((count ?? 0) >= 10) throw new HttpError(429, "Zu viele Versuche. Bitte 15 Minuten warten.");
}

async function actLogin(body: Record<string, unknown>, ip: string) {
  await throttle(ip);
  const cfg = await config();
  const pw = String(body.password ?? "");
  const ok = pw.length >= 1 && pw.length <= 200 && safeEq(await derive(pw, cfg.salt, cfg.iterations), cfg.hash);
  if (!ok) {
    await db.from("admin_attempts").insert({ ip, kind: "ctf-login" });
    throw new HttpError(401, "Falsches Passwort.");
  }
  const exp = Date.now() + TOKEN_TTL_MS;
  return { token: `${exp}.owner.${toB64Url(await hmac(cfg.token_key, `${exp}.owner`))}`, exp };
}
async function actList(body: Record<string, unknown>) {
  await requireOwner(body.token);
  const { data, error } = await db.from("ctf_images").select("id,name,file,bundled,active,created_at").order("bundled", { ascending: false }).order("created_at");
  if (error) throw new HttpError(500, error.message);
  return { images: data };
}
async function actSet(body: Record<string, unknown>) {
  await requireOwner(body.token);
  const id = String(body.id ?? "");
  if (!ID_RE.test(id)) throw new HttpError(400, "id");
  const patch: Record<string, unknown> = {};
  if (typeof body.active === "boolean") patch.active = body.active;
  if (typeof body.name === "string") {
    const n = body.name.trim();
    if (!NAME_RE.test(n)) throw new HttpError(400, "Name: 1–24 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, _ . -");
    patch.name = n;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, "nichts zu ändern");
  const { data, error } = await db.from("ctf_images").update(patch).eq("id", id).select("id,name,file,bundled,active,created_at").maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "nicht gefunden");
  return { image: data };
}
async function actUpload(body: Record<string, unknown>) {
  await requireOwner(body.token);
  const ext = TYPES[String(body.type ?? "")];
  if (!ext) throw new HttpError(400, "Nur JPG, PNG oder WebP.");
  const name = String(body.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new HttpError(400, "Name: 1–24 Zeichen, nur Buchstaben, Zahlen, Leerzeichen, _ . -");
  let bytes: Uint8Array;
  try { bytes = fromB64(String(body.data ?? "")); } catch { throw new HttpError(400, "Bilddaten ungültig"); }
  if (!bytes.length || bytes.length > MAX_BYTES) throw new HttpError(400, "Bild zu groß (max. 2 MB).");
  const id = "up-" + rid(10);
  const file = `${id}.${ext}`;
  const up = await db.storage.from(BUCKET).upload(file, bytes, { contentType: String(body.type), upsert: false });
  if (up.error) throw new HttpError(500, up.error.message);
  const active = body.active !== false;
  const { data, error } = await db.from("ctf_images").insert({ id, name, file, bundled: false, active }).select("id,name,file,bundled,active,created_at").single();
  if (error) { await db.storage.from(BUCKET).remove([file]); throw new HttpError(500, error.message); }
  return { image: data };
}
async function actDelete(body: Record<string, unknown>) {
  await requireOwner(body.token);
  const id = String(body.id ?? "");
  if (!ID_RE.test(id)) throw new HttpError(400, "id");
  const { data } = await db.from("ctf_images").select("id,file,bundled").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "nicht gefunden");
  if (data.bundled) throw new HttpError(400, "Eingebaute Bilder kann man nur deaktivieren, nicht löschen.");
  if (data.file) await db.storage.from(BUCKET).remove([data.file]);
  const { error } = await db.from("ctf_images").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
  return { ok: true };
}

Deno.serve(async (req) => {
  const headers = { ...cors(req), "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return reply(405, { error: "POST" });
  try {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES * 1.4 + 4096) throw new HttpError(413, "zu groß");
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    switch (String(body.action ?? "")) {
      case "login": return reply(200, await actLogin(body, clientIp(req)));
      case "list": return reply(200, await actList(body));
      case "set": return reply(200, await actSet(body));
      case "upload": return reply(200, await actUpload(body));
      case "delete": return reply(200, await actDelete(body));
      default: return reply(400, { error: "unbekannte Aktion" });
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return reply(status, { error: e instanceof Error ? e.message : String(e) });
  }
});
