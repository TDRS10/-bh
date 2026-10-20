/* ============================================================
   BH — Firebase Configuration
   ============================================================
   عايز تفعّل المزامنة السحابية؟ اتبع الخطوات دي:

   1) افتح https://console.firebase.google.com → "Add project"
      (سمّي المشروع مثلاً bh-finance — مجاني)

   2) من القائمة اليسار: Build → Realtime Database → Create Database
      ⚠️ اختار "Start in LOCKED mode" (مش:test mode) وpick location

   3) من قائمة Project Settings (الترس ⚙️) → "Your apps" → Web (</>)
      سجّل التطبيق و انسخ الـ config object

   4) الصق القيم هنا بالظبط و احفظ الملف

   5) من Realtime Database → Rules → الصق القواعد دي:

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

   6) من Authentication → Sign-in method → فعّل "Anonymous"
      (وممكن كمان فعّل "Google" للمزامنة بين أكتر من جهاز)

   7) من Authentication → Settings → Authorized domains
      ضيف دومين جيت هاب:
      mhmoudmohmed269-cmd.github.io
      (وكمان لو بتفتح من localhost ضيفه برضه)

   8) بعد ما تحفظ الملف، اعمل "تحديث" للتطبيق (⬇️ حدّث الآن)
      وروح صفحة "المزيد" → كارت "☁️ المزامنة السحابية"

   ملحوظة: لو مش عايز云 خطوة، سيب القيم فاضية والتطبيق هيشتغل
   عادي بالظبط بكل المميزات (البيانات هتفضل محفوظة على الجهاز).
   ============================================================ */

window.BH_FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  databaseURL: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: ''
};
