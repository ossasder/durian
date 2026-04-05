# Durian Booth Tracker

เว็บแอพสำหรับ “ระบบบันทึกรายรับรายจ่าย สำหรับแผงขายทุเรียน” แบบ mobile-first พร้อมใช้งานออฟไลน์บางส่วนผ่าน PWA และ local queue

## ฟีเจอร์หลัก

- Login 3 ระดับ: `Owner`, `Admin`, `Employee`
- ปุ่มจำ `User / Password` และ `Auto Login`
- แสดงชื่อผู้บันทึกรายการทุกบิล
- จัดการพนักงาน: เพิ่ม, แก้ไข, ระงับ, ลบ พร้อมข้อมูลส่วนตัวและรูปภาพ
- บันทึกรายรับ/รายจ่าย ครอบคลุม:
  - ซื้อทุเรียนหลายรายการ
  - ขายทุเรียนแบบเหมา / คัดเกรด
  - ค่าแรง
  - น้ำมัน
  - อื่น ๆ
- คำนวณอัตโนมัติระหว่าง `น้ำหนัก / ราคาต่อกิโล / ราคารวม`
- หน้าสรุปบิลก่อนบันทึก
- Receipt HTML สำหรับเซฟลงเครื่องหรือแชร์จากมือถือ
- Dashboard วิเคราะห์ภาพรวมธุรกิจ
- Audit log สำหรับการแก้ไข/ลบข้อมูล
- Offline-first:
  - ตัวแอพ cache ได้ผ่าน Service Worker
  - ถ้าออฟไลน์ สามารถบันทึกรายการใหม่ไว้ในเครื่องและรอซิงก์ทีหลังได้

## โครงสร้างเทคโนโลยี

- Backend: Python standard library (`http.server`)
- Database: SQLite
- Auth: custom session + remember token
- Frontend: Vanilla JS + CSS + PWA

ไม่มี dependency ภายนอกที่จำเป็นสำหรับการรันในเครื่อง

## วิธีรัน

### Windows

```powershell
py app.py
```

หรือดับเบิลคลิก `start.cmd`

จากนั้นเปิด:

```text
http://localhost:8000
```

## ตั้งค่า Owner ครั้งแรก

ถ้าเริ่มระบบด้วยฐานข้อมูลใหม่ ให้กำหนดบัญชี Owner ผ่าน environment variables ก่อนรันครั้งแรก ระบบจะไม่สร้างบัญชีเริ่มต้นให้อัตโนมัติ

```powershell
$env:DURIAN_BANK_OWNER_USERNAME="your-owner"
$env:DURIAN_BANK_OWNER_PASSWORD="your-strong-password"
$env:DURIAN_BANK_OWNER_NAME="ชื่อเจ้าของระบบ"
$env:DURIAN_BANK_OWNER_NICKNAME="ชื่อเล่น"
py app.py
```

ถ้าฐานข้อมูลมีผู้ใช้งานอยู่แล้ว ระบบจะใช้บัญชีเดิมและจะไม่สร้าง Owner ซ้ำ

## ใช้งานออนไลน์และเก็บข้อมูลบนคลาวด์

ระบบรองรับการใช้งานออนไลน์แล้ว โดยอ่าน `PORT` จาก environment อัตโนมัติ และสามารถย้ายฐานข้อมูล SQLite กับไฟล์รูปพนักงานไปเก็บบน persistent disk / cloud volume ได้ผ่านตัวแปร `DURIAN_BANK_DATA_DIR`

ไฟล์ที่เตรียมไว้ให้แล้ว:

- `render.yaml` สำหรับ deploy บน Render พร้อม persistent disk
- `.env.example` สำหรับกำหนดค่าบนเครื่องหรือเซิร์ฟเวอร์

### Deploy บน Render

1. Push โปรเจกต์ขึ้น GitHub หรือ GitLab
2. สร้าง Render Blueprint จากไฟล์ `render.yaml`
3. กรอกค่า `DURIAN_BANK_OWNER_USERNAME` และ `DURIAN_BANK_OWNER_PASSWORD` ตอน Render ถามค่า secret ครั้งแรก
4. Deploy ได้เลย

ค่าที่ตั้งไว้ใน `render.yaml`

- เปิดเป็น web service แบบ public
- ใช้ `healthCheckPath: /health`
- เก็บฐานข้อมูลและไฟล์อัปโหลดไว้ที่ `/var/data/durian-bank`
- เปิด secure cookie สำหรับใช้งานผ่าน HTTPS

### Deploy บน Docker / VPS / Cloud VM

ถ้าจะ deploy เองบน VPS หรือผู้ให้บริการคลาวด์อื่น ให้ผูก volume หรือ disk ไว้กับ `DURIAN_BANK_DATA_DIR` เสมอ

```powershell
docker build -t durian-bank .
docker run -d --name durian-bank `
  -p 8000:8000 `
  -v durian-bank-data:/var/data/durian-bank `
  -e PORT=8000 `
  -e DURIAN_BANK_DATA_DIR=/var/data/durian-bank `
  -e DURIAN_BANK_FORCE_SECURE_COOKIES=true `
  -e DURIAN_BANK_OWNER_USERNAME=your-owner `
  -e DURIAN_BANK_OWNER_PASSWORD=your-strong-password `
  -e DURIAN_BANK_OWNER_NAME="ชื่อเจ้าของระบบ" `
  -e DURIAN_BANK_OWNER_NICKNAME="ชื่อเล่น" `
  durian-bank
```

ถ้าใช้ custom domain และ reverse proxy ของตัวเอง สามารถกำหนดเพิ่มได้:

```powershell
$env:DURIAN_BANK_PUBLIC_BASE_URL="https://your-domain.example"
```

## วิธีทดสอบ

```powershell
py -m unittest discover -s tests
```

## Deploy ด้วย Docker

```powershell
docker build -t durian-bank .
docker run -p 8000:8000 `
  -v durian-bank-data:/var/data/durian-bank `
  -e PORT=8000 `
  -e DURIAN_BANK_DATA_DIR=/var/data/durian-bank `
  -e DURIAN_BANK_FORCE_SECURE_COOKIES=true `
  -e DURIAN_BANK_OWNER_USERNAME=your-owner `
  -e DURIAN_BANK_OWNER_PASSWORD=your-strong-password `
  -e DURIAN_BANK_OWNER_NAME="ชื่อเจ้าของระบบ" `
  -e DURIAN_BANK_OWNER_NICKNAME="ชื่อเล่น" `
  durian-bank
```

## หมายเหตุการใช้งานออฟไลน์

- แนะนำให้ล็อกอินบนอุปกรณ์นั้นอย่างน้อย 1 ครั้ง และเลือก `จำ User และ Password` ถ้าต้องใช้งานในพื้นที่ไม่มีอินเทอร์เน็ต
- รายการที่สร้างตอนออฟไลน์จะถูกติดป้าย `รอซิงก์` และส่งขึ้นฐานข้อมูลอัตโนมัติเมื่อกลับมาออนไลน์
- การแก้ไข/ลบรายการ และการจัดการพนักงาน ควรทำตอนออนไลน์เพื่อเก็บ log ได้ครบ
