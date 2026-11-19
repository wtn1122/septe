import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import pino from "pino";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import baileysModule from "@whiskeysockets/baileys";

// Baileys 6.x is CommonJS. Under Node ESM its default import is the complete
// exports object, not makeWASocket itself. Resolve both shapes so upgrades do
// not bring the container down with "makeWASocket is not a function".
const baileys = baileysModule?.makeWASocket
  ? baileysModule
  : baileysModule?.default || baileysModule;
const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = baileys;

if (typeof makeWASocket !== "function") {
  throw new TypeError("Baileys socket export could not be loaded");
}

const PORT = process.env.PORT || 3000;
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "change-me";
// \u0645\u062C\u0644\u062F \u0627\u0644\u062A\u062E\u0632\u064A\u0646: \u064A\u062C\u0631\u0651\u0628 AUTH_DIR \u062B\u0645 /data/auth \u062B\u0645 \u0645\u062C\u0644\u062F \u062F\u0627\u062E\u0644 \u0627\u0644\u0645\u0634\u0631\u0648\u0639.
// \u0647\u0643\u0630\u0627 \u0644\u0627 \u064A\u062A\u0648\u0642\u0641 \u0627\u0644\u0633\u064A\u0631\u0641\u0631 \u0623\u0628\u062F\u0627\u064B \u0628\u062E\u0637\u0623 EACCES (\u0645\u062B\u0644 Render \u0628\u062F\u0648\u0646 \u0642\u0631\u0635 /data).
import { access, constants as fsConstants } from "node:fs/promises";
async function pickWritableDir() {
  const candidates = [process.env.AUTH_DIR, "/data/auth", "/var/data/auth", path.join(process.cwd(), "data", "auth"), path.join("/tmp", "wa-data", "auth")].filter(Boolean);
  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, fsConstants.W_OK);
      return dir;
    } catch (e) {
      console.warn("storage dir not usable:", dir, e?.code || e?.message);
    }
  }
  throw new Error("no writable storage directory");
}
const AUTH_DIR = await pickWritableDir();
const DATA_DIR = path.dirname(AUTH_DIR);
const INBOX_FILE = path.join(DATA_DIR, "inbox.json");
const MEDIA_DIR = path.join(DATA_DIR, "media");
console.log("storage directory:", DATA_DIR);
const MAX_PER_CHAT = 300;

if (SERVICE_TOKEN === "change-me") {
  console.error("SERVICE_TOKEN must be configured");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

let sock = null;
let connected = false;
let lastQr = "";
let starting = null;
let reconnectTimer = null;
let generation = 0;
let startupError = "";


/* ===================== \u0635\u0646\u062F\u0648\u0642 \u0627\u0644\u0648\u0627\u0631\u062F: \u062D\u0641\u0638 \u0643\u0644 \u0627\u0644\u0631\u0633\u0627\u0626\u0644 ===================== */
let inbox = {};
let saveTimer = null;
async function loadInbox() {
  try { inbox = JSON.parse(await readFile(INBOX_FILE, "utf8")) || {}; } catch { inbox = {}; }
}
function saveInbox() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await writeFile(INBOX_FILE, JSON.stringify(inbox)); } catch (e) { console.error("inbox save", e); }
  }, 1500);
}
function msgText(m) {
  const x = m.message || {};
  const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x;
  return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || inner.documentMessage?.fileName || (inner.audioMessage ? "\u{1f3a4} \u0631\u0633\u0627\u0644\u0629 \u0635\u0648\u062A\u064A\u0629" : "") || (inner.stickerMessage ? "\u0645\u0644\u0635\u0642" : "") || (inner.locationMessage ? "\u{1f4cd} \u0645\u0648\u0642\u0639" : "") || "";
}
function isImage(m) {
  const x = m.message || {};
  const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x;
  return !!inner.imageMessage;
}
function record(jid, entry, name) {
  if (!inbox[jid]) inbox[jid] = { jid, name: "", unread: 0, lastAt: 0, messages: [] };
  const c = inbox[jid];
  if (name && !entry.fromMe) c.name = name;
  if (c.messages.some((m) => m.id === entry.id)) return;
  c.messages.push(entry);
  if (c.messages.length > MAX_PER_CHAT) c.messages = c.messages.slice(-MAX_PER_CHAT);
  c.lastAt = Math.max(c.lastAt, entry.at);
  if (!entry.fromMe) c.unread = (c.unread || 0) + 1;
  saveInbox();
}
async function onMessages({ messages }) {
  for (const m of messages || []) {
    const jid = m.key?.remoteJid || "";
    if (!jid.endsWith("@s.whatsapp.net")) continue;
    const id = m.key.id;
    const at = Number(m.messageTimestamp || 0) * 1000 || Date.now();
    const entry = { id, fromMe: !!m.key.fromMe, text: msgText(m), at };
    if (isImage(m)) {
      try {
        const buf = await downloadMediaMessage(m, "buffer", {});
        await mkdir(MEDIA_DIR, { recursive: true });
        await writeFile(path.join(MEDIA_DIR, id + ".jpg"), buf);
        entry.image = id;
      } catch (e) { console.error("media", e?.message); entry.image = ""; }
    }
    if (!entry.text && entry.image === undefined) continue;
    record(jid, entry, m.pushName || "");
  }
}
loadInbox();

async function stopSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = sock;
  sock = null;
  if (!current) return;
  try { current.ev.removeAllListeners(); } catch {}
  try { current.ws?.close(); } catch {}
  try { current.end?.(new Error("reinitialize")); } catch {}
}

async function start() {
  if (starting) return starting;
  const myGeneration = ++generation;
  startupError = "";
  starting = (async () => {
  await mkdir(AUTH_DIR, { recursive: true });
  await stopSocket();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const nextSocket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Store Notifier", "Chrome", "1.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = nextSocket;

  nextSocket.ev.on("creds.update", saveCreds);
  nextSocket.ev.on("messages.upsert", (u) => onMessages(u).catch(console.error));
  nextSocket.ev.on("connection.update", async (u) => {
    if (myGeneration !== generation) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      lastQr = await qrcode.toDataURL(qr);
      connected = false;
    }
    if (connection === "open") {
      connected = true;
      lastQr = "";
      startupError = "";
      console.log("WhatsApp connected \u2705");
    }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("connection closed", code);
      if (code !== DisconnectReason.loggedOut) {
        reconnectTimer = setTimeout(() => start().catch(console.error), 5000);
      }
    }
  });
  })();
  try {
    await starting;
  } catch (error) {
    startupError = error?.message || String(error);
    connected = false;
    console.error("start failed", error);
    throw error;
  } finally {
    starting = null;
  }
}
start().catch((e) => console.error("start failed", e));

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (h !== "Bearer " + SERVICE_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, service: "whatsapp-notifier", version: "4.0.0", storage: DATA_DIR }));

app.get("/status", auth, (_req, res) => {
  res.json({
    ok: !startupError,
    connected,
    status: startupError ? "error" : connected ? "connected" : starting ? "starting" : "waiting",
    error: startupError || undefined,
    qr: lastQr || undefined,
    persistentAuth: !AUTH_DIR.startsWith("/tmp") && !AUTH_DIR.startsWith(process.cwd()),
    storage: DATA_DIR,
    serverVersion: "4.0.0",
  });
});

app.get("/qr", auth, (_req, res) => res.json({ qr: lastQr || null, connected }));

app.post("/send", auth, async (req, res) => {
  try {
    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: "to & message required" });
    if (!sock || !connected) return res.status(503).json({ error: "whatsapp not connected" });
    const jid = String(to).includes("@") ? String(to) : String(to).replace(/\D/g, "") + "@s.whatsapp.net";
    const sent = await sock.sendMessage(jid, { text: String(message) });
    record(jid, { id: sent?.key?.id || String(Date.now()), fromMe: true, text: String(message), at: Date.now() });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "send failed" });
  }
});

app.get("/chats", auth, (_req, res) => {
  const list = Object.values(inbox)
    .map((c) => ({ jid: c.jid, name: c.name, unread: c.unread || 0, lastAt: c.lastAt, last: c.messages[c.messages.length - 1] || null, count: c.messages.length }))
    .sort((a, b) => b.lastAt - a.lastAt);
  res.json({ ok: true, chats: list });
});

app.get("/messages", auth, (req, res) => {
  const c = inbox[String(req.query.jid || "")];
  res.json({ ok: true, messages: c ? c.messages : [], name: c?.name || "" });
});

app.post("/read", auth, (req, res) => {
  const c = inbox[String(req.body?.jid || "")];
  if (c) { c.unread = 0; saveInbox(); }
  res.json({ ok: true });
});

// \u0627\u0644\u0635\u0648\u0631: \u062A\u064F\u0637\u0644\u0628 \u0628\u0627\u0644\u062A\u0648\u0643\u0646 \u0641\u064A \u0627\u0644\u0631\u0627\u0628\u0637 \u0644\u0623\u0646 \u0648\u0633\u0645 <img> \u0644\u0627 \u064A\u0631\u0633\u0644 \u062A\u0631\u0648\u064A\u0633\u0627\u062A
app.get("/media/:id", async (req, res) => {
  if (req.query.token !== SERVICE_TOKEN) return res.status(401).end();
  const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, "");
  try {
    const buf = await readFile(path.join(MEDIA_DIR, id + ".jpg"));
    res.set("content-type", "image/jpeg").set("cache-control", "private, max-age=86400").send(buf);
  } catch { res.status(404).end(); }
});

app.post("/logout", auth, async (_req, res) => {
  try {
    await sock?.logout();
  } catch {}
  generation++;
  await stopSocket();
  await rm(AUTH_DIR, { recursive: true, force: true });
  connected = false;
  lastQr = "";
  await start();
  res.json({ ok: true, message: "logged out; new QR is being generated" });
});

app.post("/restart", auth, async (_req, res) => {
  connected = false;
  lastQr = "";
  await start();
  res.json({ ok: true, message: "connection reinitialized; saved session preserved" });
});

app.listen(PORT, () => console.log("listening on " + PORT));
