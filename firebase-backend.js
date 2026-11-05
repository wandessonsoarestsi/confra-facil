// Backend real: Firebase Auth (telefone ou anônimo) + Firestore.
//
// Estrutura no Firestore:
//   users/{uid}                         nome, telefone, contador de eventos criados
//   events/{id}                         dados do evento (todos leem)
//   events/{id}/responses/{uid}         nome + datas de cada pessoa (todos leem)
//   events/{id}/contacts/{uid}          nome + telefone (só a pessoa e o organizador leem)
//   events/{id}/secret/code             código do organizador (só o organizador lê)
//   events/{id}/admins/{uid}            quem entrou como organizador usando o código
const V = "10.12.2";
const CDN = `https://www.gstatic.com/firebasejs/${V}`;

export async function createFirebaseBackend(cfg, authMode, appCheckSiteKey) {
  const { initializeApp } = await import(`${CDN}/firebase-app.js`);
  const A = await import(`${CDN}/firebase-auth.js`);
  const F = await import(`${CDN}/firebase-firestore.js`);

  const app = initializeApp(cfg);

  // Proteção contra robôs (opcional). Precisa da chave do reCAPTCHA no config.js.
  if (appCheckSiteKey) {
    try {
      const C = await import(`${CDN}/firebase-app-check.js`);
      C.initializeAppCheck(app, { provider: new C.ReCaptchaV3Provider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
    } catch (e) { console.error("App Check", e); }
  }

  const auth = A.getAuth(app);
  auth.languageCode = "pt";
  const db = F.getFirestore(app);

  let verifier = null;
  let confirmation = null;

  const toList = (qs) => qs.docs.map((d) => ({ id: d.id, uid: d.id, ...d.data() }));
  const sub = (id, name) => F.collection(db, "events", id, name);
  const subDoc = (id, name, docId) => F.doc(db, "events", id, name, docId);

  return {
    isDemo: false,
    authMode,

    onAuth(cb) {
      return A.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, phone: u.phoneNumber || null } : null));
    },

    async sendCode(phone) {
      if (!verifier) verifier = new A.RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" });
      try {
        confirmation = await A.signInWithPhoneNumber(auth, phone, verifier);
      } catch (e) {
        try { verifier.clear(); } catch {}
        verifier = null;
        throw e;
      }
      return {};
    },

    async confirmCode(code) {
      if (!confirmation) throw { code: "auth/code-expired" };
      await confirmation.confirm(code);
    },

    async signInSimple() {
      await A.signInAnonymously(auth);
    },

    signOut: () => A.signOut(auth),

    async getProfile(uid) {
      const s = await F.getDoc(F.doc(db, "users", uid));
      return s.exists() ? s.data() : null;
    },

    saveProfile: (uid, p) => F.setDoc(F.doc(db, "users", uid), { name: p.name, phone: p.phone ?? null }, { merge: true }),

    // Cria o evento e soma 1 no contador da pessoa (as regras limitam o total).
    async createEvent(data, code) {
      const ref = F.doc(F.collection(db, "events"));
      const b = F.writeBatch(db);
      b.set(ref, data);
      b.set(F.doc(db, "users", data.adminUid), { eventsCreated: F.increment(1), lastEventId: ref.id }, { merge: true });
      await b.commit();
      // Com as regras antigas o código não pode ser salvo; o evento funciona mesmo assim.
      await F.setDoc(subDoc(ref.id, "secret", "code"), { code }).catch((e) => console.warn("código", e));
      return ref.id;
    },

    watchEvent(id, cb, onErr) {
      return F.onSnapshot(F.doc(db, "events", id), (s) => cb(s.exists() ? { id, ...s.data() } : null), onErr);
    },

    updateEvent: (id, patch) => F.updateDoc(F.doc(db, "events", id), patch),

    watchResponses(id, cb, onErr) {
      return F.onSnapshot(sub(id, "responses"), (qs) => cb(toList(qs)), onErr);
    },

    watchContacts(id, cb, onErr) {
      return F.onSnapshot(sub(id, "contacts"), (qs) => cb(toList(qs)), onErr);
    },

    // Datas ficam públicas para o grupo; o telefone fica em "contacts", que só o organizador lê.
    async saveResponse(id, uid, data, contact) {
      const b = F.writeBatch(db);
      b.set(subDoc(id, "responses", uid), { ...data, updatedAt: Date.now() });
      b.set(subDoc(id, "contacts", uid), contact);
      try { await b.commit(); }
      catch (e) {
        if (e?.code !== "permission-denied") throw e;
        // Regras antigas (sem "contacts"): salva no formato anterior.
        await F.setDoc(subDoc(id, "responses", uid), { ...data, phone: contact.phone, updatedAt: Date.now() });
      }
    },

    // Respostas antigas guardavam o telefone junto: o organizador move para "contacts".
    async migrateContact(id, r) {
      const b = F.writeBatch(db);
      b.set(subDoc(id, "contacts", r.uid), { name: r.name, phone: r.phone });
      b.update(subDoc(id, "responses", r.uid), { phone: F.deleteField() });
      await b.commit();
    },

    async deleteResponse(id, uid) {
      await F.deleteDoc(subDoc(id, "responses", uid));
      await F.deleteDoc(subDoc(id, "contacts", uid)).catch(() => {});
    },

    // Apaga tudo do evento. A própria permissão de organizador sai por último.
    async deleteEvent(id) {
      const myUid = auth.currentUser?.uid;
      for (const name of ["responses", "contacts", "secret", "admins"]) {
        const qs = await F.getDocs(sub(id, name)).catch(() => null);
        if (qs) await Promise.all(qs.docs.filter((d) => !(name === "admins" && d.id === myUid)).map((d) => F.deleteDoc(d.ref)));
      }
      await F.deleteDoc(F.doc(db, "events", id));
      if (myUid) await F.deleteDoc(subDoc(id, "admins", myUid)).catch(() => {});
    },

    async getAdminCode(id) {
      const s = await F.getDoc(subDoc(id, "secret", "code"));
      return s.exists() ? s.data().code : null;
    },

    setAdminCode: (id, code) => F.setDoc(subDoc(id, "secret", "code"), { code }),

    async isCoAdmin(id, uid) {
      const s = await F.getDoc(subDoc(id, "admins", uid));
      return s.exists();
    },

    // Entra como organizador usando o código. As regras conferem o código.
    async claimAdmin(id, uid, code) {
      await F.setDoc(subDoc(id, "admins", uid), { code });
      await F.setDoc(F.doc(db, "users", uid), { adminOf: F.arrayUnion(id) }, { merge: true });
    },

    async listMyEvents(uid) {
      const qs = await F.getDocs(F.query(F.collection(db, "events"), F.where("adminUid", "==", uid)));
      const events = toList(qs);
      const me = await F.getDoc(F.doc(db, "users", uid));
      const extra = (me.exists() && me.data().adminOf) || [];
      for (const id of extra) {
        if (events.some((e) => e.id === id)) continue;
        const s = await F.getDoc(F.doc(db, "events", id)).catch(() => null);
        if (s?.exists()) events.push({ id, ...s.data() });
      }
      return events;
    },

    // Guarda no perfil os eventos em que a pessoa votou, para aparecerem na tela inicial.
    rememberEvent: (uid, id) => F.setDoc(F.doc(db, "users", uid), { joined: F.arrayUnion(id) }, { merge: true }),

    async listJoinedEvents(uid) {
      const me = await F.getDoc(F.doc(db, "users", uid));
      const data = me.exists() ? me.data() : {};
      const ids = new Set(data.joined || []);
      // Uma vez por conta: procura respostas feitas antes de existir essa lista.
      if (!data.joinedScan) {
        const qs = await F.getDocs(F.query(F.collection(db, "events"), F.orderBy("createdAt", "desc"), F.limit(60))).catch(() => null);
        const found = [];
        await Promise.all((qs?.docs || []).map(async (d) => {
          const r = await F.getDoc(F.doc(db, "events", d.id, "responses", uid)).catch(() => null);
          if (r?.exists()) found.push(d.id);
        }));
        found.forEach((id) => ids.add(id));
        await F.setDoc(F.doc(db, "users", uid), { joinedScan: true, ...(found.length ? { joined: F.arrayUnion(...found) } : {}) }, { merge: true }).catch(() => {});
      }
      const events = [];
      await Promise.all([...ids].map(async (id) => {
        const s = await F.getDoc(F.doc(db, "events", id)).catch(() => null);
        if (s?.exists()) events.push({ id, ...s.data() });
      }));
      return events;
    },
  };
}
