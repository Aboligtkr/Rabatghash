const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
let webPush = null;
try { webPush = require('web-push'); } catch (_) { console.warn('[WebPush] ثبّت الحزمة عبر npm install web-push لتفعيل إشعارات المتصفح.'); }
const app = express();
app.use(cors());
app.use(express.static(__dirname));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.get('/api/push/vapid-public-key', (_req, res) => {
  if (!vapidPublicKey || !vapidPrivateKey || !webPush) return res.status(503).json({ ok: false, error: 'Web Push is not configured' });
  res.json({ ok: true, publicKey: vapidPublicKey });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'connecting'
  });
});

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

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }

  console.log('[FCM] تم تهيئة Firebase Admin بنجاح.');
} catch (e) {
  console.error('[FCM] فشلت تهيئة Firebase Admin:', e);
}

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI || "mongodb://127.0.0.1:27017/rabatghash")
    .then(() => console.log("تم الاتصال بنجاح بقاعدة البيانات MongoDB"))
    .catch(err => console.error("خطأ في الاتصال بقاعدة البيانات:", err));

const messageSchema = new mongoose.Schema({
    type: { type: String, default: "public" },
    text: String,
    image: String,
    audio: String,
    sender: String,
    senderId: String,
    replyTo: { id: String, sender: String, text: String },
    reactions: [{ _id: false, user: String, emoji: String }],
    readBy: { type: [String], default: [] },
    editedAt: Date,
    updatedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});
// Automatically expire every chat message 48 hours after creation.
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

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
  memory: { name: 'لا يوجد', score: 999999 }
};

let streakData = { count: 0, lastActiveDay: null, trackingDay: null, participants: [], todayParticipants: [] };
const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
const dayBefore = (day) => new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
function refreshStreakDay() {
  const today = utcDay();
  if (streakData.lastActiveDay && streakData.lastActiveDay !== today && streakData.lastActiveDay !== dayBefore(today)) {
    streakData.count = 0;
    streakData.participants = [];
    streakData.lastActiveDay = null;
  }
  if (streakData.trackingDay !== today) {
    streakData.trackingDay = today;
    streakData.todayParticipants = [];
    streakData.participants = [];
  }
}
async function recordStreakMessage(data) {
  if ((data.type || 'public') !== 'public') return;
  refreshStreakDay();
  const today = utcDay();
  const sender = String(data.sender || '').trim().toLowerCase();
  if (!sender) return;
  if (streakData.trackingDay !== today) {
    streakData.trackingDay = today;
    streakData.todayParticipants = [];
  }
  if (!streakData.todayParticipants.includes(sender)) streakData.todayParticipants.push(sender);
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
    if (savedStreak) streakData = { count: 0, lastActiveDay: null, trackingDay: null, participants: [], todayParticipants: [], ...savedStreak.data };
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
  },
        "moaz": {
        name: "معاذ 🦅",
        title: "قائد الرواشنة السابق والعائد التائب",
        origin: "السعودية 🇸🇦",
        loc: "السعودية 🇸🇦",
        year: "2024 (وعاد في 2026)",
        badges: ["🦅 زعيم الرواشنة الأسبق", "🔙 التائب العائد", "⚡ الخصم اللدود سابقاً"],
        bio: "انضم للمملكة عام 2024 ثم انشق لاحقاً وأسس جماعة «الرواشنة» المنافسة وقاد ضدنا أعتى الحروب كأحد أكبر أعداء المملكة، قبل أن يراجع موقفه ويعود تائباً ومستغفراً إلى أسوار المملكة الربطخشاوية في عام 2026.",
        rep: 195
        },
       "abdulaziz": {
        name: "عبدالعزيز دارك 🌑",
        title: "المواطن الصلب وحصن المملكة الحصين",
        origin: "السعودية 🇸🇦",
        loc: "السعودية 🇸🇦",
        year: "2024 (وعاد في 2026)",
        badges: ["🌑 راكون الأسوار", "🛡️ الفخور الصنديد", "⚔️ مواطن المملكة العتيد"],
        bio: "أحد الأعمدة الأساسية والأركان الرصينة في صفوف المملكة سابقا. عُرف بشجاعته الفائقة ودفاعه المستميت وفخره الدائم براية الربطخشاوية. عاد حديثاً في عام 2026 ليأخذ مكانه الطبيعي بين إخوانه كدرع حصين وسند لا يُشق له غبار.",
        rep: 220
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
function sanitizeReply(reply) {
  if (!reply || typeof reply !== 'object' || typeof reply.text !== 'string') return undefined;
  return {
    id: String(reply.id || '').slice(0, 64),
    sender: String(reply.sender || '').slice(0, 100),
    text: String(reply.text).slice(0, 500)
  };
}

const validCitizen = (name) => Object.prototype.hasOwnProperty.call(citizenCredentials, name);
const configuredShuraCitizens = String(process.env.SHURA_CITIZENS || '')
  .split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
const canAccessShura = citizen =>
  !!citizen && configuredShuraCitizens.length > 0 && configuredShuraCitizens.includes(String(citizen).toLowerCase());

// Web Push (Safari/iOS Home Screen web apps and supported desktop/mobile browsers).
const vapidPublicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const vapidPrivateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
console.log('[WebPush Debug]', {
  packageLoaded: !!webPush,
  publicKeyExists: !!vapidPublicKey,
  privateKeyExists: !!vapidPrivateKey,
  subjectExists: !!vapidSubject
});
const vapidSubject = String(process.env.VAPID_SUBJECT).trim();
if (webPush && vapidPublicKey && vapidPrivateKey) {
  try { webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey); console.log('[WebPush] VAPID configured.'); }
  catch (err) { console.error('[WebPush] VAPID configuration error:', err.message); }
}

const webPushSchema = new mongoose.Schema({
  endpoint: { type: String, unique: true, required: true },
  keys: { p256dh: String, auth: String },
  user: { type: String, required: true, index: true },
  updatedAt: { type: Date, default: Date.now }
});
const WebPushSubscription = mongoose.model('WebPushSubscription', webPushSchema);


const fcmTokenSchema = new mongoose.Schema({
    token: { type: String, unique: true, required: true },
    user: String,
    updatedAt: { type: Date, default: Date.now }
});
const FcmToken = mongoose.model("FcmToken", fcmTokenSchema);

async function sendWebPushToUsers(users, payload) {
  if (!webPush || !vapidPublicKey || !vapidPrivateKey) return;
  const eligible = [...new Set((users || []).map(x => String(x || '').trim().toLowerCase()).filter(x => validCitizen(x)))];
  if (!eligible.length) return;
  const docs = await WebPushSubscription.find({ user: { $in: eligible } }).lean();
  const expired = [];
  await Promise.all(docs.map(async doc => {
    try {
      await webPush.sendNotification({ endpoint: doc.endpoint, keys: doc.keys }, JSON.stringify(payload), { TTL: 60 * 60 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) expired.push(doc.endpoint);
      else console.error('[WebPush] delivery error:', err.statusCode || '', err.message || err);
    }
  }));
  if (expired.length) await WebPushSubscription.deleteMany({ endpoint: { $in: expired } });
}

// FCM + Web Push delivery. Only authenticated citizens can ever be recipients.
async function sendChatPush({ sender, recipient = null, text = '', image = '', chatType = 'public' }) {
  const senderId = String(sender || '').trim().toLowerCase();
  let recipients = [];
  if (chatType === 'private') {
    const target = String(recipient || '').trim().toLowerCase();
    if (validCitizen(target) && target !== senderId) recipients = [target];
  } else if (chatType === 'shura') {
    recipients = configuredShuraCitizens.filter(user => validCitizen(user) && user !== senderId);
  } else if (chatType === 'public') {
    recipients = Object.keys(citizenCredentials).filter(user => user !== senderId);
  }
  if (!recipients.length) return;

  const title = chatType === 'private' ? `رسالة خاصة من ${sender}` : chatType === 'shura' ? `رسالة في مجلس الشورى من ${sender}` : `رسالة جديدة من ${sender} 👑`;
  const body = image === 'audio' ? '🎙️ أرسل رسالة صوتية' : (image ? '📷 أرسل صورة جديدة' : String(text || 'رسالة جديدة').slice(0, 180));
  const pushPayload = { title, body, url: '/', chatType };
  sendWebPushToUsers(recipients, pushPayload).catch(err => console.error('[WebPush] send error:', err));

  if (!getApps().length) {
    console.warn('[FCM] Firebase Admin is not initialized; Web Push was still attempted.');
    return;
  }
  const docs = await FcmToken.find({ user: { $in: recipients } }).lean();
  const uniqueTokens = [...new Set(docs.map(d => d.token).filter(Boolean))];
  if (!uniqueTokens.length) return;
  for (let offset = 0; offset < uniqueTokens.length; offset += 500) {
    const tokens = uniqueTokens.slice(offset, offset + 500);
    try {
      const response = await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { chatType },
        android: { priority: 'high', notification: { sound: 'default' } }
      });
      console.log(`[FCM] ${chatType}: success=${response.successCount} failure=${response.failureCount}`);
      const invalid = [];
      response.responses.forEach((item, i) => {
        if (item.success) return;
        const code = item.error?.code || 'unknown';
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) invalid.push(tokens[i]);
        else console.error(`[FCM] token failure: ${code} - ${item.error?.message || ''}`);
      });
      if (invalid.length) await FcmToken.deleteMany({ token: { $in: invalid } });
    } catch (err) { console.error('[FCM] delivery error:', err); }
  }
}

io.on('connection', (socket) => {
    socket.on('citizen_login', (payload, ack) => {
        try {
            const username = String(payload?.username || '').trim().toLowerCase();
            const password = String(payload?.password || '').trim();

            if (validCitizen(username) && citizenCredentials[username] === password) {
                if (socket.data.citizen && socket.data.citizen !== username) {
                    socket.leave('citizen:' + socket.data.citizen);
                    socket.leave('shura');
                }
                socket.data.citizen = username;
                socket.join('citizen:' + username);
                if (canAccessShura(username)) socket.join('shura');
                if (typeof ack === 'function') {
                    ack({ ok: true, user: username, role: 'مواطن' });
                }
            } else {
                if (socket.data.citizen) socket.leave('citizen:' + socket.data.citizen);
                socket.leave('shura');
                socket.data.citizen = null;
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
        const name = String(payload?.username || '').trim().toLowerCase();
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
          if (socket.data.citizen && socket.data.citizen !== citizen) {
            socket.leave('citizen:' + socket.data.citizen);
          }
          socket.data.citizen = citizen;
          socket.join('citizen:' + citizen);
          if (canAccessShura(citizen)) socket.join('shura');
          else socket.leave('shura');
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
        if (typeof ack === 'function') ack({ ok: false });
      }
    });

    socket.on('citizen_logout', async (payload, ack) => {
      const oldCitizen = String(socket.data.citizen || '').trim().toLowerCase();
      if (oldCitizen && validCitizen(oldCitizen)) {
        try {
          if (payload?.fcmToken) await FcmToken.deleteOne({ token: String(payload.fcmToken), user: oldCitizen });
          if (payload?.webPushEndpoint) await WebPushSubscription.deleteOne({ endpoint: String(payload.webPushEndpoint), user: oldCitizen });
        } catch (e) { console.error('[Push] logout cleanup error:', e); }
      }
      const token = String(payload?.token || '');
      if (token && token.length <= 256) {
        try {
          await CitizenSession.deleteOne({ tokenHash: hashSession(token) });
        } catch (e) { console.error(e); }
      }
      if (socket.data.citizen) socket.leave('citizen:' + socket.data.citizen);
      socket.leave('shura');
      socket.data.citizen = null;
      if (typeof ack === 'function') ack({ ok: true });
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
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const since = payload?.since && !Number.isNaN(Date.parse(payload.since)) ? new Date(payload.since) : null;
            const filter = { type: room, createdAt: { $gte: cutoff } };
            if (since) filter.$or = [{ createdAt: { $gt: since } }, { updatedAt: { $gt: since } }];
            const history = await Message.find(filter).sort({ createdAt: -1 }).limit(200).lean();
            history.reverse();
            ack({ ok: true, with: other, history, incremental: !!since, syncedAt: new Date().toISOString() });
        } catch (err) { console.error('Private history error:', err); ack({ ok: false, error: 'تعذر تحميل المحادثة' }); }
    });

    socket.on('private_send', async (payload, ack) => {
        const me = socket.data.citizen, other = String(payload?.to || '').trim().toLowerCase();
        const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 4000) : '';
        const image = typeof payload?.image === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(payload.image) && payload.image.length < 7_000_000 ? payload.image : '';
        const audio = typeof payload?.audio === 'string' && /^data:audio\/(webm|ogg|mp4|mpeg|wav);base64,/.test(payload.audio) && payload.audio.length < 3_500_000 ? payload.audio : '';
        if (!me || !validCitizen(other) || other === me || (!text && !image && !audio)) {
            if (typeof ack === 'function') ack({ ok: false, error: 'تعذر إرسال الرسالة' });
            return;
        }
        try {
            const saved = await new Message({ type: privateRoom(me, other), sender: me, senderId: me, text, image, audio, replyTo: sanitizeReply(payload?.replyTo), createdAt: new Date(), updatedAt: new Date() }).save();
            const data = saved.toObject();
            io.to('citizen:' + me).to('citizen:' + other).emit('private_receive', { ...data, peer: other });
            sendChatPush({ sender: me, recipient: other, text, image: image || (audio ? 'audio' : ''), chatType: 'private' }).catch(err => console.error('[FCM] private:', err));
            if (typeof ack === 'function') ack({ ok: true });
        } catch (err) { console.error('Private send error:', err); if (typeof ack === 'function') ack({ ok: false, error: 'فشل حفظ الرسالة' }); }
    });

    async function findAuthorizedChatMessage(payload, forEdit = false) {
        const id = String(payload?.messageId || '');
        if (!mongoose.isValidObjectId(id)) return null;
        const message = await Message.findById(id);
        if (!message || Date.now() - new Date(message.createdAt).getTime() > 48 * 60 * 60 * 1000) return null;
        const type = String(payload?.type || '');
        if (String(message.type).startsWith('dm:')) {
            const me = socket.data.citizen;
            const other = String(payload?.peer || '').trim().toLowerCase();
            if (!me || !validCitizen(other) || other === me || message.type !== privateRoom(me, other)) return null;
            if (forEdit && message.sender !== me) return null;
            return message;
        }
        if (!['public', 'shura'].includes(type) || message.type !== type) return null;
        if (type === 'shura' && !canAccessShura(socket.data.citizen)) return null;
        if (forEdit && message.senderId !== socket.id && (!socket.data.citizen || message.sender !== socket.data.citizen)) return null;
        return message;
    }

    function broadcastUpdatedMessage(message) {
        const data = message.toObject ? message.toObject() : message;
        if (String(data.type || '').startsWith('dm:')) {
            const members = String(data.type).slice(3).split(':');
            if (members.length === 2) io.to('citizen:' + members[0]).to('citizen:' + members[1]).emit('message_updated', data);
        } else if (data.type === 'shura') {
            io.to('shura').emit('message_updated', data);
        } else {
            io.emit('message_updated', data);
        }
    }

// مؤشر الكتابة في الشات
    socket.on('typing', (data) => {
        const chatType = String(data?.type || 'public');
        const sender = socket.data.citizen || String(data?.sender || 'مواطن');
        if (chatType.startsWith('dm:')) {
            const peer = String(data?.peer || '').trim().toLowerCase();
            if (!socket.data.citizen || !validCitizen(peer) || peer === socket.data.citizen || chatType !== privateRoom(socket.data.citizen, peer)) return;
            io.to('citizen:' + peer).emit('user_typing', { sender, type: chatType });
        } else if (chatType === 'public') socket.broadcast.emit('user_typing', { sender, type: chatType });
        else if (chatType === 'shura' && canAccessShura(socket.data.citizen)) socket.to('shura').emit('user_typing', { sender, type: chatType });
    });

    socket.on('stop_typing', (data) => {
        const chatType = String(data?.type || 'public');
        const sender = socket.data.citizen || String(data?.sender || 'مواطن');
        if (chatType.startsWith('dm:')) {
            const peer = String(data?.peer || '').trim().toLowerCase();
            if (!socket.data.citizen || !validCitizen(peer) || peer === socket.data.citizen || chatType !== privateRoom(socket.data.citizen, peer)) return;
            io.to('citizen:' + peer).emit('user_stop_typing', { sender, type: chatType });
        } else if (chatType === 'public') socket.broadcast.emit('user_stop_typing', { sender, type: chatType });
        else if (chatType === 'shura' && canAccessShura(socket.data.citizen)) socket.to('shura').emit('user_stop_typing', { sender, type: chatType });
    });

    socket.on('mark_chat_read', async (payload) => {
        try {
            const type=String(payload?.type||'');
            const reader=String(socket.data.citizen || '').trim().toLowerCase();
            const ids=Array.isArray(payload?.messageIds)?payload.messageIds.filter(id=>mongoose.isValidObjectId(String(id))).slice(0,200):[];
            if(!reader || !ids.length) return;
            let filter={_id:{$in:ids},type:{$in:['public','shura']}};
            if(type.startsWith('dm:')) {
                const peer=String(payload?.peer||'').trim().toLowerCase();
                if(!socket.data.citizen || !validCitizen(peer) || peer===reader || type!==privateRoom(reader,peer)) return;
                filter={_id:{$in:ids},type};
            } else {
                if(!['public','shura'].includes(type)) return;
                if(type === 'shura' && !canAccessShura(socket.data.citizen)) return;
                filter.type=type;
            }
            const docs=await Message.find(filter).select('_id readBy').lean();
            for(const doc of docs){
                await Message.updateOne({_id:doc._id},{$addToSet:{readBy:reader}});
                const readBy=[...new Set([...(doc.readBy||[]),reader])];
                const update={type,messageId:String(doc._id),readBy};
                if(type.startsWith('dm:')) { const members=type.slice(3).split(':'); if(members.length===2)io.to('citizen:'+members[0]).to('citizen:'+members[1]).emit('seen_update',update); }
                else if (type === 'shura') io.to('shura').emit('seen_update',update);
                else io.emit('seen_update',update);
            }
        } catch(err){ console.error('Mark chat read error:',err); }
    });
    
    socket.on('message_react', async (payload) => {
        try {
            const emoji = String(payload?.emoji || '');
            if (!['❤️', '😂', '😮', '😢', '👍', '🔥'].includes(emoji)) return;
            const message = await findAuthorizedChatMessage(payload, false);
            if (!message) return;
            const user = String(socket.data.citizen || 'الضيف').slice(0, 100);
            const existing = (message.reactions || []).find(r => r.user === user);
            message.reactions = (message.reactions || []).filter(r => r.user !== user);
            if (!existing || existing.emoji !== emoji) message.reactions.push({ user, emoji });
            message.updatedAt = new Date();
            await message.save();
            broadcastUpdatedMessage(message);
        } catch (err) { console.error('Message reaction error:', err); }
    });

    socket.on('message_delete', async (payload) => {
        try {
            const message = await findAuthorizedChatMessage(payload, true);
            if (!message) return;
            const data = { type: message.type, messageId: String(message._id) };
            await message.deleteOne();
            if (String(data.type).startsWith('dm:')) {
                const members = String(data.type).slice(3).split(':');
                if (members.length === 2) io.to('citizen:' + members[0]).to('citizen:' + members[1]).emit('message_deleted', data);
            } else if (data.type === 'shura') {
                io.to('shura').emit('message_deleted', data);
            } else {
                io.emit('message_deleted', data);
            }
        } catch (err) { console.error('Message delete error:', err); }
    });

    socket.on('message_edit', async (payload) => {
        try {
            const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 4000) : '';
            if (!text) return;
            const message = await findAuthorizedChatMessage(payload, true);
            if (!message || !message.text) return;
            message.text = text;
            message.editedAt = new Date();
            message.updatedAt = new Date();
            await message.save();
            broadcastUpdatedMessage(message);
        } catch (err) { console.error('Message edit error:', err); }
    });

    socket.on('register_fcm_token', async (payload, ack) => {
        const token = typeof payload === 'string' ? payload : payload?.token;
        const user = String(socket.data.citizen || '').trim().toLowerCase();
        if (!user || !validCitizen(user) || !token || typeof token !== 'string') {
          if (typeof ack === 'function') ack({ ok: false, error: 'يجب تسجيل الدخول كمواطن أولاً' });
          return;
        }
        try {
          await FcmToken.findOneAndUpdate({ token }, { user, updatedAt: new Date() }, { upsert: true, new: true });
          if (typeof ack === 'function') ack({ ok: true });
        } catch (err) {
          console.error('FCM token save error:', err);
          if (typeof ack === 'function') ack({ ok: false });
        }
    });

    socket.on('register_web_push', async (subscription, ack) => {
      const user = String(socket.data.citizen || '').trim().toLowerCase();
      const endpoint = String(subscription?.endpoint || '');
      const p256dh = String(subscription?.keys?.p256dh || '');
      const auth = String(subscription?.keys?.auth || '');
      if (!user || !validCitizen(user) || !endpoint.startsWith('https://') || !p256dh || !auth) {
        if (typeof ack === 'function') ack({ ok: false, error: 'يجب تسجيل الدخول كمواطن أولاً' });
        return;
      }
      try {
        await WebPushSubscription.findOneAndUpdate({ endpoint }, { endpoint, keys: { p256dh, auth }, user, updatedAt: new Date() }, { upsert: true, new: true });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        console.error('[WebPush] subscription save error:', err);
        if (typeof ack === 'function') ack({ ok: false, error: 'تعذر حفظ اشتراك الإشعارات' });
      }
    });

    socket.on('unregister_device_push', async (payload, ack) => {
      const user = String(socket.data.citizen || '').trim().toLowerCase();
      if (!user || !validCitizen(user)) { if (typeof ack === 'function') ack({ ok: false }); return; }
      try {
        const fcmToken = String(payload?.fcmToken || '');
        const endpoint = String(payload?.endpoint || '');
        if (fcmToken) await FcmToken.deleteOne({ token: fcmToken, user });
        if (endpoint) await WebPushSubscription.deleteOne({ endpoint, user });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) { console.error('[Push] unregister error:', err); if (typeof ack === 'function') ack({ ok: false }); }
    });

    socket.on("fetch_history", async (request) => {
        try {
            const requestedType = typeof request === 'string' ? request : request?.type;
            const chatType = requestedType === 'shura' ? 'shura' : 'public';
            if (chatType === 'shura' && !canAccessShura(socket.data.citizen)) {
              socket.emit('load_history', { type: chatType, history: [], incremental: false, error: 'غير مصرح لك بدخول مجلس الشورى' });
              return;
            }
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const sinceValue = typeof request === 'object' && request?.since ? request.since : null;
            const since = sinceValue && !Number.isNaN(Date.parse(sinceValue)) ? new Date(sinceValue) : null;
            const filter = { type: chatType, createdAt: { $gte: cutoff } };
            if (since) filter.$or = [{ createdAt: { $gt: since } }, { updatedAt: { $gt: since } }];
            const history = await Message.find(filter).sort({ createdAt: -1 }).limit(200).lean();
            history.reverse();
            socket.emit("load_history", { type: chatType, history, incremental: !!since, syncedAt: new Date().toISOString() });
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

    socket.on('send_message', async (data, ack) => {
        try {
            if (!data || !['public', 'shura'].includes(data.type)) {
              if (typeof ack === 'function') ack({ ok: false, error: 'نوع المحادثة غير صالح' });
              return;
            }
            if (data.type === 'shura' && !canAccessShura(socket.data.citizen)) {
              if (typeof ack === 'function') ack({ ok: false, error: 'غير مصرح لك بإرسال رسائل في مجلس الشورى' });
              return;
            }
            const senderName = socket.data.citizen || (String(data.sender || '') === 'الضيف' ? 'الضيف' : 'مواطن');
            const text = typeof data.text === 'string' ? data.text.trim().slice(0, 4000) : '';
            const audio = typeof data.audio === 'string' && /^data:audio\/(webm|ogg|mp4|mpeg|wav);base64,/.test(data.audio) && data.audio.length < 3_500_000 ? data.audio : '';
            const image = typeof data.image === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(data.image) && data.image.length < 7_000_000 ? data.image : '';
            if (!text && !image && !audio) {
              if (typeof ack === 'function') ack({ ok: false, error: 'الرسالة فارغة أو نوع المرفق غير مدعوم' });
              return;
            }
            if (data.type === 'public') await recordStreakMessage({ type: data.type, sender: senderName });

            const savedMsg = await new Message({
                type: data.type,
                text,
                image,
                audio,
                sender: senderName,
                senderId: socket.data.citizen || socket.id,
                replyTo: sanitizeReply(data.replyTo),
                createdAt: new Date(),
                updatedAt: new Date()
            }).save();

            if (data.type === 'shura') io.to('shura').emit('receive_message', savedMsg);
            else io.emit('receive_message', savedMsg);

            sendChatPush({ sender: senderName, text, image: image || (audio ? 'audio' : ''), chatType: data.type }).catch(err => console.error('[FCM] chat:', err));
            if (typeof ack === 'function') ack({ ok: true, messageId: String(savedMsg._id) });
        } catch (err) {
            console.error("خطأ في حفظ أو إرسال الرسالة:", err);
            if (typeof ack === 'function') ack({ ok: false, error: 'حدث خطأ أثناء حفظ الرسالة' });
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
