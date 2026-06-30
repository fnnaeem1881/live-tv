// Viewer-count presence via Firebase Realtime Database.
//
// Firebase is LAZY-LOADED: the SDK is only dynamically imported (and only
// downloaded as a separate bundle chunk) when env config is present. Users who
// haven't set up Firebase never pay the ~300KB Firebase cost.

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

const isConfigured = Boolean(cfg.databaseURL && cfg.apiKey);
const sessionId = Math.random().toString(36).slice(2) + Date.now();

let rtdb = null; // the firebase/database module namespace, once loaded
let db = null; // the database handle, once initialized
let readyPromise = null;

function ensureFirebase() {
  if (!isConfigured) return Promise.resolve(null);
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    try {
      const [{ initializeApp }, dbMod] = await Promise.all([
        import('firebase/app'),
        import('firebase/database'),
      ]);
      const app = initializeApp(cfg);
      db = dbMod.getDatabase(app);
      rtdb = dbMod;
      return db;
    } catch (err) {
      console.warn('Firebase init failed, viewer counts disabled:', err.message);
      db = null;
      return null;
    }
  })();
  return readyPromise;
}

// Begin loading in the background as soon as the module is imported (only if
// configured) so the SDK is ready by the time a channel is opened.
if (isConfigured) ensureFirebase();

export const viewersAvailable = () => isConfigured;

let currentChannelRef = null;
let desiredKey = null;

function removeCurrentRef() {
  if (currentChannelRef && rtdb) rtdb.remove(currentChannelRef).catch(() => {});
  currentChannelRef = null;
}

// Marks this browser tab as watching `channelKey`. `desiredKey` guards against
// a race where channels are switched faster than Firebase finishes loading —
// only the most recently requested key actually registers presence.
export function joinChannel(channelKey) {
  if (!isConfigured) return;
  desiredKey = channelKey;
  removeCurrentRef();
  ensureFirebase().then(() => {
    if (!db || desiredKey !== channelKey) return;
    currentChannelRef = rtdb.ref(db, `viewers/${channelKey}/${sessionId}`);
    rtdb.set(currentChannelRef, { t: rtdb.serverTimestamp() });
    rtdb.onDisconnect(currentChannelRef).remove();
  });
}

export function leaveChannel() {
  desiredKey = null;
  removeCurrentRef();
}

// Subscribes to live viewer count for `channelKey`. Returns an unsubscribe
// function (works whether or not Firebase has finished loading yet).
export function watchViewerCount(channelKey, callback) {
  if (!isConfigured) return () => {};
  let unsub = null;
  let cancelled = false;
  ensureFirebase().then(() => {
    if (cancelled || !db) return;
    const listRef = rtdb.ref(db, `viewers/${channelKey}`);
    unsub = rtdb.onValue(listRef, (snapshot) => {
      const val = snapshot.val();
      callback(val ? Object.keys(val).length : 0);
    });
  });
  return () => {
    cancelled = true;
    if (unsub) {
      unsub();
      unsub = null;
    }
  };
}
