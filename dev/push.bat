@echo off
chcp 65001 > nul
echo ====================================
echo 🚀 جاري رفع التعديلات إلى GitHub...
echo ====================================
git add .
git commit -m "Update: %date% %time%"
git push origin main
echo.
echo ====================================
echo ✅ تم رفع التعديلات بنجاح!
echo ====================================
pause
