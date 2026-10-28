const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const crypto = require('crypto');
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
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("تم تهيئة Firebase Admin بنجاح.");
} catch (e) {
  console.warn("تنبيه: لم يتم العثور على إعدادات Firebase Admin، سيتم الاعتماد على إشعارات Socket المحلية.", e);
}

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI || "mongodb://127.0.0.1:27017/rabatghash")
    .then(() => console.log("تم الاتصال بنجاح بقاعدة البيانات MongoDB"))
    .catch(err => console.error("خطأ في الاتصال بقاعدة البيانات:", err));

const messageSchema = new mongoose.Schema({
    type: { type: String, default: "public" },
    text: String,
    image: String,
    sender: String,
    senderId: String,
    createdAt: { type: Date, default: Date.now }
});

// الرسائل الخاصة محفوظة دون انتهاء تلقائي. انتبه: فهرس TTL القديم في MongoDB
// قد يظل موجوداً؛ احذفه من مجموعة messages إذا رغبت في حفظ الرسائل الخاصة دائماً.
const Message = mongoose.model("Message", messageSchema);

const gameStateSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    data: mongoose.Schema.Types.Mixed
});
const GameState = mongoose.model("GameState", gameStateSchema);
const citizenSessionSchema = new mongoose.Schema({
  tokenHash: {
    type: String,
    unique: true,
    required: true
  },
  citizen: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    expires: 0
  }
});

const CitizenSession = mongoose.model(
  'CitizenSession',
  citizenSessionSchema
);

const hashSession = token =>
  crypto.createHash('sha256').update(token).digest('hex');
let pollVotes = { opt1: 0, opt2: 0 };

let globalLeaderboard = {
  clicker: { name: 'لا يوجد', score: 0 },
  bird: { name: 'لا يوجد', score: 0 },
  dino: { name: 'لا يوجد', score: 0 },
  snake: { name: 'لا يوجد', score: 0 },
  memory: { name: 'لا يوجد', score: 999999 } // تم تعيين قيمة ابتدائية مرتفعة للأدوار
};

let streakData = { count: 0, lastActiveDay: null, participants: [], todayParticipants: [] };
const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
const dayBefore = (day) => new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
function refreshStreakDay() {
  const today = utcDay();
  if (streakData.lastActiveDay && streakData.lastActiveDay !== today && streakData.lastActiveDay !== dayBefore(today)) {
    streakData.count = 0;
    streakData.participants = [];
    streakData.todayParticipants = [];
    streakData.lastActiveDay = null;
  }
}
async function recordStreakMessage(data) {
  if ((data.type || 'public') !== 'public') return;
  refreshStreakDay();
  const today = utcDay();
  const sender = String(data.sender || '').trim().toLowerCase();
  if (!sender) return;
  if (streakData.lastActiveDay !== today) {
    streakData.todayParticipants = [];
  }
  if (!streakData.todayParticipants.includes(sender)) streakData.todayParticipants.push(sender);
  // لا يُحتسب اليوم إلا بعد مشاركة شخصين مختلفين في المجلس العام.
  if (streakData.todayParticipants.length >= 2 && streakData.lastActiveDay !== today) {
    streakData.count = streakData.lastActiveDay === dayBefore(today) ? streakData.count + 1 : 1;
    streakData.lastActiveDay = today;
  }
  streakData.participants = [...streakData.todayParticipants];
  await saveStreakToDB();
  io.emit('update_streak_state', streakData);
}

async function loadPersistentState() {
  try {
    const savedLb = await GameState.findOne({ key: 'globalLeaderboard' });
    if (savedLb) globalLeaderboard = savedLb.data;

    const savedStreak = await GameState.findOne({ key: 'streakData' });
    if (savedStreak) streakData = { count: 0, lastActiveDay: null, participants: [], todayParticipants: [], ...savedStreak.data };
    refreshStreakDay();
  } catch (e) {
    console.error("خطأ في استرجاع الحالة الثابتة:", e);
  }
}
loadPersistentState();

async function saveLeaderboardToDB() {
  try {
    await GameState.findOneAndUpdate(
      { key: 'globalLeaderboard' },
      { data: globalLeaderboard },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error("خطأ في حفظ الصدارة:", e);
  }
}

async function saveStreakToDB() {
  try {
    await GameState.findOneAndUpdate(
      { key: 'streakData' },
      { data: streakData },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error("خطأ في حفظ الستريك:", e);
  }
}

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

let citizenCredentials = {};
try { 
  if (process.env.CITIZEN_CREDENTIALS_JSON) {
    citizenCredentials = JSON.parse(process.env.CITIZEN_CREDENTIALS_JSON); 
  } 
} catch (e) { 
  console.error('Invalid CITIZEN_CREDENTIALS_JSON'); 
}
const privateRoom = (a, b) => 'dm:' + [a, b].sort().join(':');
const validCitizen = (name) => Object.prototype.hasOwnProperty.call(citizenCredentials, name);

const fcmTokenSchema = new mongoose.Schema({
    token: { type: String, unique: true, required: true },
    user: String,
    updatedAt: { type: Date, default: Date.now }
});
const FcmToken = mongoose.model("FcmToken", fcmTokenSchema);

io.on('connection', (socket) => {
  // حدث التحقق من تسجيل دخول المواطن من السيرفر مباشرة
    socket.on('citizen_login', (payload, ack) => {
        try {
            const username = String(payload?.username || '').trim().toLowerCase();
            const password = String(payload?.password || '').trim();

            // التحقق من القائمة الموجودة في السيرفر
            if (citizenCredentials[username] && citizenCredentials[username] === password) {
                if (typeof ack === 'function') {
                    ack({ ok: true, user: username, role: 'مواطن' });
                }
            } else {
                if (typeof ack === 'function') {
                    ack({ ok: false, error: 'اسم المستخدم أو الكود غير صحيح!' });
                }
            }
        } catch (err) {
            console.error('Login error:', err);
            if (typeof ack === 'function') ack({ ok: false, error: 'خطأ في السيرفر' });
        }
    });
    console.log('مستخدم جديد اتصل بالتطبيق:', socket.id);

    socket.emit("update_reputation_state", citizensDB);
    refreshStreakDay();
    socket.emit("update_streak_state", streakData);
    socket.emit("update_leaderboard_state", globalLeaderboard);

    socket.on('citizen_auth', async (payload, ack) => {
  try {
    const name = String(payload?.username || '')
      .trim()
      .toLowerCase();

    const password = String(payload?.password || '');
    const token = String(payload?.token || '');

    let citizen = null;
    let issuedToken = null;

    if (token && token.length <= 256) {
      const session = await CitizenSession.findOne({
        tokenHash: hashSession(token),
        expiresAt: { $gt: new Date() }
      });

      if (
        session &&
        validCitizen(session.citizen) &&
        (!name || name === session.citizen)
      ) {
        citizen = session.citizen;
      }

    } else if (
      validCitizen(name) &&
      citizenCredentials[name] === password
    ) {
      citizen = name;

      issuedToken = crypto.randomBytes(32).toString('hex');

      await CitizenSession.create({
        tokenHash: hashSession(issuedToken),
        citizen,
        expiresAt: new Date(Date.now() + 30 * 86400000)
      });
    }

    if (citizen) {
      if (
        socket.data.citizen &&
        socket.data.citizen !== citizen
      ) {
        socket.leave('citizen:' + socket.data.citizen);
      }

      socket.data.citizen = citizen;
      socket.join('citizen:' + citizen);
    }

    if (typeof ack === 'function') {
      ack({
        ok: !!citizen,
        user: citizen,
        token: issuedToken
      });
    }

  } catch (err) {
    console.error('Citizen auth error:', err);

    if (typeof ack === 'function') {
      ack({ ok: false });
    }
  }
});

socket.on('citizen_logout', async (payload, ack) => {
  const token = String(payload?.token || '');

  if (token && token.length <= 256) {
    try {
      await CitizenSession.deleteOne({
        tokenHash: hashSession(token)
      });
    } catch (e) {
      console.error(e);
    }
  }

  if (socket.data.citizen) {
    socket.leave('citizen:' + socket.data.citizen);
  }

  socket.data.citizen = null;

  if (typeof ack === 'function') {
    ack({ ok: true });
  }
});

    socket.on('private_contacts', (_payload, ack) => {
        if (typeof ack !== 'function') return;
        if (!socket.data.citizen) return ack({ ok: false, error: 'يلزم تسجيل الدخول مجدداً' });
        ack({ ok: true, contacts: Object.entries(citizensDB).filter(([key]) => key !== socket.data.citizen).map(([key, val]) => ({ id: key, name: val.name, title: val.title })) });
    });

    socket.on('private_history', async (payload, ack) => {
        if (typeof ack !== 'function') return;
        const me = socket.data.citizen, other = String(payload?.with || '').trim().toLowerCase();
        if (!me || !validCitizen(other) || other === me) return ack({ ok: false, error: 'محادثة غير مسموحة' });
        try {
            const room = privateRoom(me, other);
            const history = await Message.find({ type: room }).sort({ createdAt: -1 }).limit(200).lean();
            ack({ ok: true, with: other, history: history.reverse() });
        } catch (err) { ack({ ok: false, error: 'تعذر تحميل المحادثة' }); }
    });

    socket.on('private_send', async (payload, ack) => {
        const me = socket.data.citizen, other = String(payload?.to || '').trim().toLowerCase();
        const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 4000) : '';
        const image = typeof payload?.image === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(payload.image) && payload.image.length < 7_000_000 ? payload.image : '';
        if (!me || !validCitizen(other) || other === me || (!text && !image)) {
            if (typeof ack === 'function') ack({ ok: false, error: 'تعذر إرسال الرسالة' });
            return;
        }
        try {
            const saved = await new Message({ type: privateRoom(me, other), sender: me, senderId: me, text, image, createdAt: new Date() }).save();
            const data = saved.toObject();
            io.to('citizen:' + me).to('citizen:' + other).emit('private_receive', { ...data, peer: other });
            if (typeof ack === 'function') ack({ ok: true });
        } catch (err) { if (typeof ack === 'function') ack({ ok: false, error: 'فشل حفظ الرسالة' }); }
    });

   socket.on('register_fcm_token', async (payload) => {
    const token = typeof payload === 'string' ? payload : payload?.token;
    const user = payload?.user || socket.data.citizen || 'unknown';
    if (token) {
        try {
            await FcmToken.findOneAndUpdate(
                { token },
                { user, updatedAt: new Date() },
                { upsert: true, new: true }
            );
            console.log("تم حفظ وتحديث FCM Token في قاعدة البيانات بنجاح للمستخدم:", user);
        } catch (err) {
            console.error("خطأ في حفظ الرمز بقاعدة البيانات:", err);
        }
    }
});
    socket.on("fetch_history", async (type) => {
        try {
            const chatType = type === 'shura' ? 'shura' : 'public';
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

    socket.on("update_leaderboard", async (newLeaderboard) => {
        if (newLeaderboard) {
            globalLeaderboard = newLeaderboard;
            await saveLeaderboardToDB();
            io.emit("update_leaderboard_state", globalLeaderboard);
        }
    });

    socket.on('send_message', async (data) => {
        try {
            if (!data || !['public', 'shura'].includes(data.type)) return;
            const senderName = data.sender || "مواطن";
            if (data.type === 'public') await recordStreakMessage(data);

            const newMessage = new Message({
                type: data.type || "public",
                text: data.text || "",
                image: data.image || "",
                sender: senderName,
                senderId: socket.id,
                createdAt: new Date()
            });

            const savedMsg = await newMessage.save();
            io.emit('receive_message', savedMsg);

            // ==========================================
            // إرسال إشعار FCM بالطريقة الآمنة والمبسطة
            // ==========================================
            try {
                if (typeof admin !== 'undefined' && admin.apps.length > 0) {
                    // تحويل الرموز المخزنة في الذاكرة إلى مصفوفة نظيفة
                    const tokensArray = Array.from(deviceTokens || []);

                    if (tokensArray.length > 0) {
                        const messagePayload = {
                            tokens: tokensArray,
                            notification: {
                                title: `رسالة جديدة من ${senderName} 👑`,
                                body: data.image ? "📷 أرسل صورة جديدة" : (data.text || "")
                            },
                            android: {
                                notification: {
                                    sound: "default",
                                    priority: "high"
                                }
                            }
                        };

                        const response = await admin.messaging().sendEachForMulticast(messagePayload);
                        console.log("نجح إرسال الإشعارات:", response.successCount, "فشل:", response.failureCount);
                        
                        // تنظيف الرموز غير التالفة أو المنتهية إذا لزم الأمر
                        if (response.failureCount > 0) {
                            response.responses.forEach((resp, idx) => {
                                if (!resp.success) {
                                    deviceTokens.delete(tokensArray[idx]);
                                }
                            });
                        }
                    } else {
                        console.log("لا توجد رموز FCM متصلة بالذاكرة حالياً.");
                    }
                }
            } catch (fcmErr) {
                console.log("خطأ في إرسال إشعار FCM:", fcmErr.message);
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
