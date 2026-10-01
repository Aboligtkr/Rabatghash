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

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 1. ضع رابط الاتصال الخاص بك من MongoDB هنا (مع كتابة كلمة السر واسم المستخدم بدلاً من الأقواس)
const MONGO_URI = "mongodb+srv://baybarskgr:fie8jdk84jdh3@cluster0.ujpcrsl.mongodb.net/?appName=Cluster0"

mongoose.connect(MONGO_URI)
    .then(() => console.log("تم الاتصال بنجاح بقاعدة البيانات MongoDB"))
    .catch(err => console.error("خطأ في الاتصال بقاعدة البيانات:", err));

// 2. هيكل حفظ الرسائل
const messageSchema = new mongoose.Schema({
    type: { type: String, default: "public" },
    text: String,
    image: String,
    sender: String,
    senderId: String,
    createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model("Message", messageSchema);

// 3. أحداث الدردشة
io.on('connection', async (socket) => {
    console.log('مستخدم جديد اتصل بالتطبيق:', socket.id);

    // إرسال سجل الرسائل القديمة للمستخدم بمجرد دخوله
    try {
        const history = await Message.find().sort({ createdAt: 1 }).limit(50);
        socket.emit("load_history", history);
    } catch (err) {
        console.error("خطأ في استرجاع السجل:", err);
    }

    // استقبال الرسالة الجديدة وحفظها في قاعدة البيانات ثم إعادة إرسالها للجميع
    socket.on('send_message', async (data) => {
        try {
            const newMessage = new Message({
                type: data.type || "public",
                text: data.text || "",
                image: data.image || "",
                sender: data.sender || "مواطن",
                senderId: data.senderId
            });

            await newMessage.save(); // حفظ في قاعدة البيانات
            io.emit('receive_message', data); // بث للجميع
        } catch (err) {
            console.error("خطأ في حفظ الرسالة:", err);
        }
    });

    socket.on('disconnect', () => {
        console.log('مستخدم قطع الاتصال:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});