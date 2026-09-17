# OPS Billing Auto (ระบบออกบิลอัตโนมัติ)

ระบบช่วยออกบิลอัตโนมัติจากไฟล์ Excel สำหรับระบบ OPS Invoicing และ BRM API

---

## 🚀 วิธีการเปิดใช้งาน (Run)

### วิธีที่ 1: ดับเบิ้ลคลิกไฟล์ (ง่ายที่สุด)
ดับเบิ้ลคลิกที่ไฟล์ **`start_server.bat`**
- ระบบจะตรวจสอบ Node.js และ Dependencies ให้อัตโนมัติ
- เริ่มการทำงานของ Server และเปิดเบราว์เซอร์ `http://localhost:3000` ให้อัตโนมัติทันที

### วิธีที่ 2: รันผ่าน Terminal
```bash
npm start
# หรือ
node server.js
```
เปิด Web Browser ไปที่: **http://localhost:3000**  
(หากเปิดจากเครื่องอื่นในเครือข่ายเดียวกัน ให้ใช้ IP: `http://192.168.0.102:3000`)

---

## 📁 โครงสร้างโปรเจกต์ (Project Structure)

```text
Gen/
├── index.html            # หน้าเว็บ UI (HTML5, Vanilla CSS, JavaScript)
├── server.js             # Express Backend Server (API Proxy, SSE Stream, Excel Generator)
├── package.json          # Node.js dependencies & scripts
├── start_server.bat      # สคริปต์ดับเบิ้ลคลิกสำหรับรัน Server
├── Auto.py               # โปรแกรม Tkinter สำหรับ BRM API เดิม
└── Data/
    ├── Report/           # โฟลเดอร์เก็บไฟล์ผลลัพธ์ Excel ที่รันเสร็จแล้ว
    ├── billing_template.xlsx  # ไฟล์เทมเพลต Excel ตัวอย่าง
    └── ออกบิล OPS.postman_collection.json # คอลเลกชัน Postman
```

---

## 🧪 โหมดการทำงาน
1. **โหมดทดสอบจำลอง (Simulation Mode)**:
   - สามารถกดปุ่ม `🧪 โหลดข้อมูลทดสอบ (3 BA)` เพื่อทดสอบการนำเข้าข้อมูล
   - รันกระบวนการออกบิลจำลองทั้ง 4 ขั้นตอนครบสมบูรณ์ 100%
   - สร้างไฟล์ Excel บันทึกลงใน `Data/Report` ทันทีโดยไม่ต้องต่อเซิร์ฟเวอร์จริง
2. **โหมดทำงานจริง**:
   - ปลดติ๊กถูกออกจาก "โหมดทดสอบจำลอง"
   - ระบบจะยิง API ไปยังเซิร์ฟเวอร์ OPS ปลายทางจริง
