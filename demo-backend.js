// Backend de demonstração: guarda tudo no navegador (localStorage).
// Serve para testar o site antes de configurar o Firebase.
const KEY = "confra-facil-demo";
export const DEMO_CODE = "123456";

const FAKE_NAMES = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabi", "Hugo", "Íris", "João", "Larissa", "Marcos"];

export function createDemoBackend(authMode) {
  let mem = { events: {}, responses: {}, users: {}, contacts: {}, secrets: {}, admins: {}, session: null };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f());

  const read = () => {
    try {
      const s = localStorage.getItem(KEY);
      if (s) mem = { contacts: {}, secrets: {}, admins: {}, ...JSON.parse(s) };
    } catch {}
  };
  const write = () => {
    try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch {}
    emit();
  };
  read();
  window.addEventListener("storage", (e) => { if (e.key === KEY) { read(); emit(); } });

  let authCb = null;
  let pendingPhone = null;
  const userObj = () => (mem.session ? { uid: mem.session, phone: mem.users[mem.session]?.phone || null } : null);
  const uidFor = (phone) => "u" + phone.replace(/\D/g, "");
  const setSession = (uid) => { mem.session = uid; write(); authCb && authCb(userObj()); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const watch = (fn) => { listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); };

  return {
    isDemo: true,
    authMode,

    onAuth(cb) { authCb = cb; setTimeout(() => cb(userObj()), 0); },

    async sendCode(phone) {
      pendingPhone = phone;
      await wait(500);
      return { demoCode: DEMO_CODE };
    },

    async confirmCode(code) {
      await wait(300);
      if (code !== DEMO_CODE) throw { code: "auth/invalid-verification-code" };
      const uid = uidFor(pendingPhone);
      mem.users[uid] = { ...(mem.users[uid] || {}), phone: pendingPhone };
      setSession(uid);
    },

    async signInSimple(phone) {
      const uid = uidFor(phone);
      mem.users[uid] = { ...(mem.users[uid] || {}), phone };
      setSession(uid);
    },

    async signOut() { setSession(null); },

    async getProfile(uid) { return mem.users[uid] || null; },

    async saveProfile(uid, p) { mem.users[uid] = { ...(mem.users[uid] || {}), ...p }; write(); },

    async createEvent(data, code) {
      const id = Math.random().toString(36).slice(2, 10);
      mem.events[id] = data;
      mem.secrets[id] = code;
      write();
      return id;
    },

    watchEvent(id, cb) { return watch(() => cb(mem.events[id] ? { id, ...mem.events[id] } : null)); },

    async updateEvent(id, patch) { Object.assign(mem.events[id], patch); write(); },

    watchResponses(id, cb) {
      return watch(() => cb(Object.entries(mem.responses[id] || {}).map(([uid, r]) => ({ uid, ...r }))));
    },

    watchContacts(id, cb) {
      return watch(() => cb(Object.entries(mem.contacts[id] || {}).map(([uid, c]) => ({ uid, ...c }))));
    },

    async saveResponse(id, uid, data, contact) {
      (mem.responses[id] ||= {})[uid] = { ...data, updatedAt: Date.now() };
      (mem.contacts[id] ||= {})[uid] = contact;
      write();
    },

    async migrateContact(id, r) {
      (mem.contacts[id] ||= {})[r.uid] = { name: r.name, phone: r.phone };
      delete mem.responses[id][r.uid].phone;
      write();
    },

    async deleteResponse(id, uid) {
      delete (mem.responses[id] || {})[uid];
      delete (mem.contacts[id] || {})[uid];
      write();
    },

    async deleteEvent(id) {
      for (const k of ["events", "responses", "contacts", "secrets", "admins"]) delete mem[k][id];
      write();
    },

    async getAdminCode(id) { return mem.secrets[id] || null; },
    async setAdminCode(id, code) { mem.secrets[id] = code; write(); },
    async isCoAdmin(id, uid) { return !!mem.admins[id]?.[uid]; },
    async claimAdmin(id, uid, code) {
      if (!mem.events[id] || mem.secrets[id] !== code) throw { code: "permission-denied" };
      (mem.admins[id] ||= {})[uid] = true;
      write();
    },

    async listMyEvents(uid) {
      return Object.entries(mem.events)
        .filter(([id, e]) => e.adminUid === uid || mem.admins[id]?.[uid])
        .map(([id, e]) => ({ id, ...e }));
    },

    async rememberEvent(uid, id) {
      const u = (mem.users[uid] ||= {});
      u.joined = [...new Set([...(u.joined || []), id])];
      write();
    },

    async listJoinedEvents(uid) {
      return Object.entries(mem.events)
        .filter(([id]) => mem.responses[id]?.[uid] || (mem.users[uid]?.joined || []).includes(id))
        .map(([id, e]) => ({ id, ...e }));
    },

    // Só no modo demonstração: cria respostas fictícias para ver o cálculo.
    async addFakeResponses(id, dates, n = 8) {
      if (!dates.length) return;
      const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
      const popular = new Set([pick(dates), pick(dates)]);
      const resp = (mem.responses[id] ||= {});
      const used = new Set(Object.values(resp).map((r) => r.name));
      const names = FAKE_NAMES.filter((x) => !used.has(x)).slice(0, n);
      for (const name of names) {
        const mode = Math.random() < 0.5 ? "can" : "cannot";
        const chosen = dates.filter((d) =>
          mode === "can"
            ? Math.random() < (popular.has(d) ? 0.85 : 0.35)
            : Math.random() < (popular.has(d) ? 0.1 : 0.3)
        );
        resp["fake-" + name] = { name, phone: null, mode, dates: chosen, updatedAt: Date.now() };
      }
      write();
    },
  };
}
