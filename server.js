const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.static(__dirname));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 1. الاتصال بـ MongoDB
const MONGO_URI = "mongodb+srv://baybarskgr:fie8jdk84jdh3@cluster0.ujpcrsl.mongodb.net/?appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log("تم الاتصال بنجاح بقاعدة البيانات MongoDB"))
    .catch(err => console.error("خطأ في الاتصال بقاعدة البيانات:", err));

// 2. هيكل حفظ الرسائل (الحذف التلقائي بعد 24 ساعة عبر expires: 86400)
const messageSchema = new mongoose.Schema({
    type: { type: String, default: "public" },
    text: String,
    image: String,
    sender: String,
    senderId: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const Message = mongoose.model("Message", messageSchema);

// 3. أحداث الدردشة والسوكت
io.on('connection', (socket) => {
    console.log('مستخدم جديد اتصل بالتطبيق:', socket.id);

    // 1. استقبال طلب جلب السجل حسب نوع الشات (public أو shura)
    socket.on("fetch_history", async (type) => {
        try {
            const chatType = type || "public";
            // جلب أحدث 200 رسالة خاصة بهذا الشات
            const history = await Message.find({ type: chatType }).sort({ createdAt: 1 }).limit(200);
            
            // إرسال السجل بنفس الصيغة التي ينتظرها التطبيق
            socket.emit("load_history", { type: chatType, history: history });
        } catch (err) {
            console.error("خطأ في استرجاع السجل:", err);
        }
    });

    // 2. استقبال الرسالة الجديدة وحفظها في MongoDB ثم بثها للجميع
    socket.on('send_message', async (data) => {
        try {
            const newMessage = new Message({
                type: data.type || "public",
                text: data.text || "",
                image: data.image || "",
                sender: data.sender || "مواطن",
                senderId: socket.id
            });

            // حفظ إجباري في قاعدة البيانات
            const savedMsg = await newMessage.save();
            console.log("تم حفظ الرسالة بنجاح في DB:", savedMsg._id);

            // بث الرسالة المحفوظة للجميع
            io.emit('receive_message', savedMsg);
        } catch (err) {
            console.error("خطأ في حفظ الرسالة في قاعدة البيانات:", err);
        }
    });

    socket.on('disconnect', () => {
        console.log('مستخدم قطع الاتصال:', socket.id);
    });
});
