# 📱 BH — تطبيق أندرويد أصلي (Capacitor)

التطبيق موجود في **3 أشكال** — كلها بتحمّل **نفس رابط GitHub Pages**:
`https://tdrs10.github.io/-bh/`

| الشكل | إزاي تستخدمه | التحديثات |
|---|---|---|
| 🌐 **PWA** | افتح الرابط → "إضافة إلى الشاشة الرئيسية" | فوري |
| 📦 **APK (Capacitor)** | نزّل الـ APK وركّبه | **فوري** (بيحمّل من GitHub) |
| ▶️ **TWA** | نفس الـ APK بشكل أبسط | فوري |

---

## ✨ الفرق الحقيقي (ليه Capacitor أحسن من TWA)

التطبيق **native حقيقي** (مش مجرد غلاف) — نفس كود الـ JS لكن بـ قدرات Android:

| القدرة | التفاصيل |
|---|---|
| 📳 **اهتزاز (Haptics)** | اهتزاز خفيف عند كل حفظ، ونجاح/خطأ مختلف |
| 🔔 **إشعارات native مجدولة** | أدق وأضمن من Web Push — بتوصل والتطبيق مقفول |
| 📤 **Share sheet أصلي** | نافذة مشاركة أندرويد الحقيقية |
| 🔙 **زر الرجوع** | يرجّعك للرئيسية بدل ما يقفل التطبيق |
| 🎨 **Splash أصلي** | بلوجو BH في دائرة، بيختفي لما التطبيق يجهز |
| 📱 **قفل Portrait** | التطبيق مش بيتقلب |
| 🎨 **Status bar** | شريط الحالة بلون التطبيق |

**نفس الكود** — `app.js` واحد بيشتغل في المتصفح وفي التطبيق.

---

## 🔐 Step 1: أضف الـ Secrets على GitHub

**Settings → Secrets and variables → Actions → New repository secret**

| الاسم | القيمة |
|---|---|
| `KEYSTORE_BASE64` | محتوى `keystore-backup.keystore` بصيغة base64 |
| `KEYSTORE_PASSWORD` | `bhfinance2026` |
| `KEY_PASSWORD` | `bhfinance2026` |

```powershell
# على Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("keystore-backup.keystore")) | Set-Content keystore.b64
```

> ⚠️ **مهم:** الـ keystore هو **مفتاح التوقيع الدائم**. لو ضاع، مش هتقدر تعمل تحديثات للتطبيق نفسه (لكن الـ PWA هيشتغل عادي).

---

## 🏗️ Step 2: ابني محلياً

```bash
npm install
npm run build:apk
```

أو من GitHub Actions: بعد أي **push** على `main`، الـ workflow بيبني الـ APK تلقائياً.
- **Actions → Build Android App (Capacitor)**
- نزّل **BH-Finance-APK** من الـ Artifacts

---

## 📲 Step 3: ركّب على الموبايل

1. **Settings → Security → Install unknown apps** → اسمح للمتصفح
2. نزّل `BH-Finance.apk`
3. **Install**
4. **افتحه من أيقونة التطبيق** (مش من المتصفح)

---

## 🔧 البنية

```
├── app.js / index.html / styles.css   ← كود التطبيق (واحد للكل)
├── native-bridge.js                   ← طبقة Capacitor (no-op في المتصفح)
├── capacitor.config.ts                ← إعدادات التطبيق الأصلي
├── android/                           ← مشروع Android (Capacitor)
├── scripts/make-android-icons.js      ← توليد الأيقونات + splash من اللوجو
├── keystore-backup.keystore           ← مفتاح التوقيع (سري)
├── .github/workflows/build-apk.yml    ← بناء تلقائي
└── www/                               ← نسخة من الملفات للـ app
```

**كيف الـ native bridge بيشتغل:**
`native-bridge.js` بيقرأ `window.Capacitor` — لو موجود (في التطبيق الأصلي) بيفتح الـ plugins، لو لأ (في المتصفح) كل دواله **no-op**. عشان كده نفس الكود بيشتغل في الاتنين بدون أي شرط.

---

## 🔗 ليه `assetlinks.json` مهم؟

بيقول لـ Android: "التطبيق ده موقّع بنفس شهادة `com.bhfinance.app` مسموحله يفتح `tdrs10.github.io`"

البصمة (لازم تطابق الـ APK):
```
39:A6:70:2D:21:15:FA:61:34:EA:79:BD:9A:AF:F1:85:DE:8C:56:F2:71:65:E9:47:45:3C:81:23:41:D0:D1:E0
```

لو غيّرت الـ keystore، حدّثها:
```bash
keytool -list -v -keystore keystore-backup.keystore -alias bh
```
