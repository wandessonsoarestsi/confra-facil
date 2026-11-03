// Backend real: Firebase Auth (telefone ou anônimo) + Firestore.
const V = "10.12.2";
const CDN = `https://www.gstatic.com/firebasejs/${V}`;

export async function createFirebaseBackend(cfg, authMode) {
  const { initializeApp } = await import(`${CDN}/firebase-app.js`);
  const A = await import(`${CDN}/firebase-auth.js`);
  const F = await import(`${CDN}/firebase-firestore.js`);

  const app = initializeApp(cfg);
  const auth = A.getAuth(app);
  auth.languageCode = "pt";
  const db = F.getFirestore(app);

  let verifier = null;
  let confirmation = null;

  const toList = (qs) => qs.docs.map((d) => ({ id: d.id, uid: d.id, ...d.data() }));

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

    saveProfile: (uid, p) => F.setDoc(F.doc(db, "users", uid), p, { merge: true }),

    async createEvent(data) {
      const r = await F.addDoc(F.collection(db, "events"), data);
      return r.id;
    },

    watchEvent(id, cb, onErr) {
      return F.onSnapshot(F.doc(db, "events", id), (s) => cb(s.exists() ? { id, ...s.data() } : null), onErr);
    },

    updateEvent: (id, patch) => F.updateDoc(F.doc(db, "events", id), patch),

    watchResponses(id, cb, onErr) {
      return F.onSnapshot(F.collection(db, "events", id, "responses"), (qs) => cb(toList(qs)), onErr);
    },

    saveResponse: (id, uid, data) =>
      F.setDoc(F.doc(db, "events", id, "responses", uid), { ...data, updatedAt: Date.now() }),

    deleteResponse: (id, uid) => F.deleteDoc(F.doc(db, "events", id, "responses", uid)),

    deleteEvent: (id) => F.deleteDoc(F.doc(db, "events", id)),

    async listMyEvents(uid) {
      const qs = await F.getDocs(F.query(F.collection(db, "events"), F.where("adminUid", "==", uid)));
      return toList(qs);
    },
  };
}
