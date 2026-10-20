/* ============================================================
   BH — Firebase Configuration
   ============================================================
   ✅ مفعّل — بياناتك هتتنزّل على السحابة وتتزامن بين أجهزتك.

   Project : bhxx-2a3be
   Database: bhxx-2a3be-default-rtdb (europe-west1)

   ── خطواتActivation (إذا لسه ما عملته) ──────────────────
   1) Authentication → Sign-in method → فعّل "Anonymous"
      (وكمان "Google" لو عايز مزامنة بين أكتر من جهاز)

   2) Authentication → Settings → Authorized domains → ضيف:
        mhmoudmohmed269-cmd.github.io
        localhost

   3) Realtime Database → Rules → الصق:

      {
        "rules": {
          "users": {
            "$uid": {
              ".read":  "$uid === auth.uid",
              ".write": "$uid === auth.uid"
            }
          }
        }
      }

   ملحوظة: القواعد دي بتخلي كل مستخدم يقرا ويكتب بياناته هو بس.
   ============================================================ */

window.BH_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBHH8ilsfoKyOBJThjCP9p3Hh7hnIPqimc",
  authDomain: "bhxx-2a3be.firebaseapp.com",
  databaseURL: "https://bhxx-2a3be-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "bhxx-2a3be",
  storageBucket: "bhxx-2a3be.firebasestorage.app",
  messagingSenderId: "137498544374",
  appId: "1:137498544374:web:2bba990afc91b9c20a84d7",
  measurementId: "G-DH9QF9N9YC"
};
