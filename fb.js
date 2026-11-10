// Firebase SDK (구글 CDN에서 불러옴)
const V = '10.12.2';
const base = `https://www.gstatic.com/firebasejs/${V}`;
const [app, auth, store, rtdb] = await Promise.all([
  import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`),
  import(`${base}/firebase-firestore.js`), import(`${base}/firebase-database.js`),
]);
export const { initializeApp } = app;
export const { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously, signOut, updateProfile, sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset } = auth;
export const { getFirestore, doc, getDoc, setDoc, addDoc, collection, query, orderBy, limit, getDocs } = store;
export const { getDatabase, ref, set, remove, onValue, onDisconnect } = rtdb;
