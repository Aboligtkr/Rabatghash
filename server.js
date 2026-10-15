const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const admin = require('firebase-admin');

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

try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("تم تهيئة Firebase Admin بنجاح.");
} catch (e) {
  console.warn("تنبيه: لم يتم العثور على serviceAccountKey.json، سيتم الاعتماد على إشعارات Web/Socket المحلية.");
}

const MONGO_URI = "mongodb+srv://baybarskgr:fie8jdk84jdh3@cluster0.ujpcrsl.mongodb.net/?appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log("تم الاتصال بنجاح بقاعدة البيانات MongoDB"))
    .catch(err => console.error("خطأ في الاتصال بقاعدة البيانات:", err));

const messageSchema = new mongoose.Schema({
    type: { type: String, default: "public" },
    text: String,
    image: String,
    sender: String,
    senderId: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const Message = mongoose.model("Message", messageSchema);

let pollVotes = { opt1: 0, opt2: 0 };

let globalLeaderboard = {
  clicker: { name: 'لا يوجد', score: 0 },
  bird: { name: 'لا يوجد', score: 0 },
  dino: { name: 'لا يوجد', score: 0 },
  snake: { name: 'لا يوجد', score: 0 },
  memory: { name: 'لا يوجد', score: 0 }
};

let citizensDB = {
  "baybars": {
    name: "بيبرس 👑",
    title: "ملك المملكة الربطخشاوية والمؤسس الحديث",
    origin: "سوريا 🇸🇾",
    loc: "سوريا 🇸🇾",
    year: "المؤسس",
    badges: ["👑 المؤسس والملك", "🏛️ قائد الشورى", "⚡ رأس الهرم"],
    bio: "مؤسس المجموعة الحديثة ومديرها العام، القائد الذي أرسى دعائم المملكة الربطخشاوية وقاد تنظيمها وإدارتها.",
    rep: 250
  },
  "marwan": {
    name: "مروان 🛡️",
    title: "وزير الداخلية الربطخشاوي",
    origin: "السودان 🇸🇩",
    loc: "مصر 🇪🇬",
    year: "2023",
    badges: ["🛡️ صخرة الثبات", "⚔️ قاهر الرواشنة", "🏛️ عضو شورى"],
    bio: "أحد أركان المملكة وأكثر الأعضاء ثباتاً وصموداً أمام موجات التقلبات والهجر. صاحب الدور المباشر والحاسم في تحقيق النصر الإستراتيجي ضد مجموعة الرواشنة.",
    rep: 210
  },
  "tareq": {
    name: "طارق 👁️",
    title: "وزير الدفاع وعرّاب الاستخبارات",
    origin: "سوريا 🇸🇾",
    loc: "سوريا 🇸🇾",
    year: "2023 (متخفي)",
    badges: ["👁️ ثعلب الاستخبارات", "⚔️ حاسم الحروب", "🏛️ عضو شورى"],
    bio: "عضو استخباراتي عمل في الخفاء، كشف عن هويته من جديد ليقود الدفاع. يعتبر الورقة الرابحة والعامل الرئيسي المشترك في كسب وحسم جميع حروب المملكة التاريخية.",
    rep: 195
  },
  "abdulrahman": {
    name: "عبدالرحمن ⚔️",
    title: "مشرف في مجلس الشورى",
    origin: "اليمن 🇾🇪",
    loc: "السعودية 🇸🇦",
    year: "2023",
    badges: ["⚔️ بطل الحرب الأولى", "📜 مخضرم الشورى", "🏛️ عضو شورى"],
    bio: "من قدامى الأعضاء ومؤسسي الهيبة. لعب دوراً جوهرياً ومحورياً في انتصار المملكة خلال الحرب الربطخشاوية الأولى.",
    rep: 180
  },
  "mohammed khatteb": {
    name: "محمد خطيب 📜",
    title: "مواطن مخضرم ورمز الذكريات",
    origin: "فلسطين 🇵🇸",
    loc: "فلسطين 🇵🇸",
    year: "2023",
    badges: ["📜 رفيق الذكريات", "🌟 الجيل الذهبي"],
    bio: "عضو قديم وصادق من الرعيل الأول، صنعت معه أجمل ذكريات المملكة التاريخية، والداعي الرسمي لأعضاء من الجيل الجديد.",
    rep: 140
  },
  "shehab": {
    name: "شهاب 🔄",
    title: "المواطن العائد للديار",
    origin: "الجزائر 🇩🇿",
    loc: "الجزائر 🇩🇿",
    year: "عائد حديثاً",
    badges: ["🔄 العائد إلى الديار", "🛡️ وفيّ المملكة"],
    bio: "عضو سابق قديم غادر صفوف المملكة لفترة، ثم عاد من جديد ليكمل مسيرته بين إخوانه المواطنين.",
    rep: 110
  },
  "ziyad": {
    name: "زياد 🤝",
    title: "مواطن ربطخشاوي",
    origin: "السودان 🇸🇩",
    loc: "مصر 🇪🇬",
    year: "2024",
    badges: ["🤝 واسطة ملكية", "🌟 أخ الوزير"],
    bio: "عضو قديم انضم للمملكة عام 2024، شقيق وزير الداخلية مروان. دخل بدعم وواسطة مباشرة من أخيه الوزير!",
    rep: 95
  },
  "mohammed alg": {
    name: "محمد الجرادي ✨",
    title: "مواطن ربطخشاوي جديد",
    origin: "الجزائر 🇩🇿",
    loc: "الجزائر 🇩🇿",
    year: "2026",
    badges: ["✨ العهد الجديد", "📩 سفير خطيب"],
    bio: "أحدث انضمام للمملكة في عام 2026، دخل الديار برعاية ودعوة شخصية من العضو المخضرم محمد خطيب الفلسطيني.",
    rep: 80
  }
};

let deviceTokens = new Set();

io.on('connection', (socket) => {
    console.log('مستخدم جديد اتصل بالتطبيق:', socket.id);

    socket.emit("update_reputation_state", citizensDB);

    socket.on("register_fcm_token", (data) => {
        if (data && data.token) {
            deviceTokens.add(data.token);
        }
    });

    socket.on("fetch_history", async (type) => {
        try {
            const chatType = type || "public";
            const history = await Message.find({ type: chatType }).sort({ createdAt: 1 }).limit(200);
            socket.emit("load_history", { type: chatType, history: history });
        } catch (err) {
            console.error("خطأ في استرجاع السجل:", err);
        }
    });

    socket.on("fetch_poll", () => {
        socket.emit("update_poll_state", pollVotes);
    });

    socket.on("fetch_leaderboard", () => {
        socket.emit("update_leaderboard_state", globalLeaderboard);
    });

    socket.on("cast_poll_vote", (data) => {
        if (data && data.option && (data.option === 'opt1' || data.option === 'opt2')) {
            pollVotes[data.option] += 1;
            io.emit("update_poll_state", pollVotes);
        }
    });

    socket.on("update_reputation", (data) => {
        if (data && data.userKey && citizensDB[data.userKey]) {
            citizensDB[data.userKey].rep += 1;
            io.emit("update_reputation_state", citizensDB);
        }
    });

    socket.on("update_leaderboard", (newLeaderboard) => {
        if (newLeaderboard) {
            globalLeaderboard = newLeaderboard;
            io.emit("update_leaderboard_state", globalLeaderboard);
        }
    });

    socket.on('send_message', async (data) => {
        try {
            const newMessage = new Message({
                type: data.type || "public",
                text: data.text || "",
                image: data.image || "",
                sender: data.sender || "مواطن",
                senderId: socket.id
            });

            const savedMsg = await newMessage.save();
            io.emit('receive_message', savedMsg);

            if (admin.apps.length > 0 && deviceTokens.size > 0) {
                const tokensArray = Array.from(deviceTokens);
                const messagePayload = {
                    notification: {
                        title: `رسالة جديدة من ${data.sender || 'مواطن'} 👑`,
                        body: data.image ? "📷 أرسل صورة جديدة" : (data.text || "")
                    },
                    data: {
                        type: data.type || "public"
                    },
                    tokens: tokensArray
                };

                admin.messaging().sendEachForMulticast(messagePayload).catch(err => console.error("FCM Error:", err));
            }
        } catch (err) {
            console.error("خطأ في حفظ أو إرسال الرسالة:", err);
        }
    });

    socket.on('disconnect', () => {
        console.log('مستخدم قطع الاتصال:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});