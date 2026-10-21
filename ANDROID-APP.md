# 📱 BH — تطبيق أندرويد (APK) من نفس رابط GitHub

التطبيق دلوقتي موجود في **(formين)**:

| الشكل | الرابط | إزاي تستخدمه |
|---|---|---|
| 🌐 **PWA** (المتصفح) | `https://mhmoudmohmed269-cmd.github.io/-bh/` | افتح الرابط → "إضافة إلى الشاشة الرئيسية" |
| 📦 **APK** (تطبيق حقيقي) | نفس الرابط جوه التطبيق | نزّل الـ APK وركّبه |

الـ APK بيستخدم **Trusted Web Activity** — يعني:
- بيفتح **نفس رابط GitHub** بالظبط (مفيش نسخة منفصلة)
- أي تحديث بتعمله على GitHub بيظهر في التطبيق **فوراً**
- مفيش شريط متصفح، fullscreen، splash screen بلوجو BH

---

## 🔐 Step 1: أضف الـ Secrets على GitHub

**Settings → Secrets and variables → Actions → New repository secret**

| الاسم | القيمة |
|---|---|
| `KEYSTORE_BASE64` | محتوى ملف `android/bh-release.keystore` بصيغة base64 (انظر ↓) |
| `KEYSTORE_PASSWORD` | `bhfinance2026` |
| `KEY_PASSWORD` | `bhfinance2026` |

**عشان تعمل base64 للـ keystore:**
```bash
# على Linux / Mac
base64 -i android/bh-release.keystore -o keystore.b64

# على Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("android\bh-release.keystore")) | Set-Content keystore.b64
```

> ⚠️ **مهم:** الـ keystore هو **مفتاح التوقيع الدائم** للتطبيق. لو ضاع، مش هتقدر تعمل تحديثات للتطبيق نفسه بعدين (لكن الـ PWA هيشتغل عادي). احتفظ بيه في مكان آمن.

---

## 🏗️ Step 2: ابني الـ APK

**الطريقة الأولى (سهلة):** بعد ما تعمل **push** على `main`، الـ workflow بيشتغل لوحده.
- روح **Actions → Build Android APK**
- لما يخلص، نزّل **BH-Finance-APK** من الـ Artifacts

**الطريقة الثانية (محلي):**
```bash
npm install -g @bubblewrap/cli
export JAVA_HOME=/path/to/jdk21
export ANDROID_HOME=$HOME/Android/Sdk
export BUBBLEWRAP_KEYSTORE_PASSWORD=bhfinance2026
export BUBBLEWRAP_KEY_PASSWORD=bhfinance2026
bubblewrap init --manifest twa-manifest.json
bubblewrap build --manifest twa-manifest.json
```

---

## 📲 Step 3: ركّب الـ APK على الموبايل

1. **Settings → Security → Install unknown apps** → اسمح للمتصفح (Chrome) يثبت التطبيقات
2. نزّل `BH-Finance.apk` من الـ artifact
3. افتحه من Downloads → **Install**
4. **افتحه من أيقونة التطبيق** (مش من المتصفح) عشان يشتغل كـ TWA

---

## 🔗 ليه الـ assetlinks.json مهم؟

الملف ده في `.well-known/assetlinks.json` بيقول لـ Android:
> "التطبيق ده موقّع بنفس شهادة `com.bhfinance.app` مسموحله يفتح `mhmoudmohmed269-cmd.github.io`"

من غيره، التطبيق هيفتح **في المتصفح** بدل ما يفتح standalone. الـ fingerprint موجود في الملف و**لازم يطابق** اللي اتوقّع بيه الـ APK:

```
SHA-256: 39:A6:70:2D:21:15:FA:61:34:EA:79:BD:9A:AF:F1:85:DE:8C:56:F2:71:65:E9:47:45:3C:81:23:41:D0:D1:E0
```

لو غيّرت الـ keystore، حدّث الـ fingerprint في `assetlinks.json`:
```bash
keytool -list -v -keystore android/bh-release.keystore -alias bh
```

---

## 📋 ملفات مهمة

| الملف | الوظيفة |
|---|---|
| `twa-manifest.json` | إعدادات الـ TWA (package id, host, start url) |
| `.well-known/assetlinks.json` | ربط الدومين بالتطبيق |
| `android/bh-release.keystore` | مفتاح التوقيع (سري) |
| `app/` | مشروع Android (مولّد تلقائياً) |
| `.github/workflows/build-apk.yml` | بناء الـ APK تلقائياً |
