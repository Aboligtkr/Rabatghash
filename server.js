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

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Set MONGO_URI in the server environment"); process.exit(1); }

mongoose.connect(MONGO_URI)
    .then(() => console.log("تم الاتصال بنجاح بقاعدة البيانات MongoDB"))
    .catch(err => console.error("خطأ في الاتصال بقاعدة البيانات:", err));

const messageSchema = new mongoose.Schema({
    type: { type: String, default: "public" },
    text: String,
    image: String,
    sender: String,
    senderId: String,
    recipient: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, expires: 172800 }
});

const Message = mongoose.model("Message", messageSchema);

const gameStateSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    data: mongoose.Schema.Types.Mixed
});
const GameState = mongoose.model("GameState", gameStateSchema);

let pollVotes = { opt1: 0, opt2: 0 };

let globalLeaderboard = {
  clicker: { name: 'لا يوجد', score: 0 },
  bird: { name: 'لا يوجد', score: 0 },
  dino: { name: 'لا يوجد', score: 0 },
  snake: { name: 'لا يوجد', score: 0 },
  memory: { name: 'لا يوجد', score: 999999 } // تم تعيين قيمة ابتدائية مرتفعة للأدوار
};

let streakData = { count: 0, windowStart: Date.now(), participants: [], lastSenders: [] };
const DAY = 86400000;
const accounts = {"baybars":"ByB#9284","marwan":"MrW$5103","abdulrahman":"AbD@7391","mohammed khatteb":"MKh#4028","shehab":"ShB%6149","ziyad":"ZyD*8512","tareq":"TrQ#3940","mohammed alg":"MAl!7261"};
const shura = new Set(["baybars","marwan","abdulrahman","tareq"]);
function advanceStreak(now = Date.now()) {
  if (!Number.isFinite(streakData.windowStart)) streakData.windowStart = now;
  if (!Array.isArray(streakData.participants)) streakData.participants = [];
  let changed = false;
  while (now - streakData.windowStart >= DAY) {
    streakData.count = streakData.participants.length >= 3 ? streakData.count + 1 : 0;
    streakData.participants = [];
    streakData.windowStart += DAY;
    changed = true;
  }
  return changed;
}
function emitStreak() { io.emit("update_streak_state", {count:streakData.count, participants:streakData.participants.length, nextCheck:streakData.windowStart + DAY}); }

async function loadPersistentState() {
  try {
    const savedLb = await GameState.findOne({ key: 'globalLeaderboard' });
    if (savedLb) globalLeaderboard = savedLb.data;

    const savedStreak = await GameState.findOne({ key: 'streakData' });
    if (savedStreak) streakData = savedStreak.data;
    if (!streakData.windowStart) streakData = {count:streakData.count || 0, windowStart:Date.now(), participants:[]};
    if (advanceStreak()) await saveStreakToDB();
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

let deviceTokens = new Set();

io.on('connection', (socket) => {
    console.log('مستخدم جديد اتصل بالتطبيق:', socket.id);

    socket.emit("update_reputation_state", citizensDB);
    socket.emit("update_streak_state", {count:streakData.count,participants:streakData.participants.length,nextCheck:streakData.windowStart+DAY});
    socket.on("authenticate", ({user,password} = {},reply) => {
      const key=String(user||'').toLowerCase();
      if (accounts[key] && accounts[key]===password) {socket.data.user=key;socket.join(`user:${key}`);reply?.({ok:true});}
      else {socket.data.user=null;reply?.({ok:false});}
    });
    socket.on("list_dm_contacts",()=>{
      if (!socket.data.user) return;
      socket.emit("dm_contacts",Object.entries(citizensDB).filter(([key])=>key!==socket.data.user).map(([key,c])=>({key,name:c.name,title:c.title})));
    });
    socket.emit("update_leaderboard_state", globalLeaderboard);

    socket.on("register_fcm_token", (data) => {
        if (data && data.token) {
            deviceTokens.add(data.token);
        }
    });

    socket.on("fetch_history", async (request, reply) => {
      try {
        const user=socket.data.user;
        if (!user) { reply?.({ok:false,error:'تسجيل الدخول للسيرفر مطلوب'}); return; }
        const type=typeof request==='string' ? request : request?.type;
        if (type==='dm') {
          const recipient=String(request?.recipient || '').toLowerCase();
          if (!accounts[recipient] || recipient===user) { reply?.({ok:false,error:'المستلم غير صالح'}); return; }
          const history=await Message.find({type:'dm',createdAt:{$gte:new Date(Date.now()-2*DAY)},$or:[{senderId:user,recipient},{senderId:recipient,recipient:user}]}).sort({createdAt:-1}).limit(200);
          socket.emit('load_dm_history',{recipient,history:history.reverse()});
          reply?.({ok:true});
          return;
        }
        if (!['public','shura'].includes(type) || (type==='shura' && !shura.has(user))) {reply?.({ok:false,error:'غير مصرح'});return;}
        const history=await Message.find({type,createdAt:{$gte:new Date(Date.now()-2*DAY)}}).sort({createdAt:-1}).limit(200);
        socket.emit('load_history',{type,history:history.reverse()});
        reply?.({ok:true});
      } catch(err) { console.error('History error:',err); reply?.({ok:false,error:'خطأ في قاعدة البيانات'}); }
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

         socket.on("fetch_dm_history", async (recipient, reply) => {
       const user = socket.data.user;
       if (!user || !accounts[recipient] || recipient === user) { reply?.({ok:false,error:"غير مصرح بالمحادثة"}); return; }
       const history = await Message.find({type:"dm", createdAt:{$gte:new Date(Date.now()-2*DAY)}, $or:[{senderId:user,recipient},{senderId:recipient,recipient:user}]}).sort({createdAt:-1}).limit(200);
       socket.emit("load_dm_history", {recipient,history:history.reverse()});
       reply?.({ok:true});
     });

     socket.on('send_message', async (data = {}, reply) => {
       try {
         const user = socket.data.user;
         if (!user) { reply?.({ok:false,error:"غير مسجل بالسيرفر"}); return; }
         const type = data.type || 'public';
         if (!['public','shura','dm'].includes(type)) { reply?.({ok:false,error:'نوع المحادثة غير صالح'}); return; }
         if (type === 'shura' && !shura.has(user)) return;
         const recipient = type === 'dm' ? String(data.recipient || '') : null;
         if (type === 'dm' && (!accounts[recipient] || recipient === user)) { reply?.({ok:false,error:'المستلم غير صالح'}); return; }
         const text = String(data.text || '').slice(0,4000);
         const image = typeof data.image === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(data.image) && data.image.length < 6e6 ? data.image : '';
         if (!text.trim() && !image) { reply?.({ok:false,error:'الرسالة فارغة'}); return; }
         const savedMsg = await new Message({type,text,image,sender:citizensDB[user]?.name || user,senderId:user,recipient,createdAt:new Date()}).save();
         if (type === 'dm') {
           io.to(`user:${user}`).to(`user:${recipient}`).emit('receive_message',savedMsg);
         } else if (type === 'shura') {
           for (const member of shura) io.to(`user:${member}`).emit('receive_message',savedMsg);
         } else {
           io.emit('receive_message',savedMsg);
           if (advanceStreak()) await saveStreakToDB();
           if (!streakData.participants.includes(user)) {
             streakData.participants.push(user);
             await saveStreakToDB();
           }
           emitStreak();
         }
         reply?.({ok:true});
         // Do not broadcast private messages through push notifications.
       } catch (err) { console.error('Message error:',err); reply?.({ok:false,error:'فشل حفظ الرسالة بقاعدة البيانات'}); }
     });

socket.on('disconnect', () => {
        console.log('مستخدم قطع الاتصال:', socket.id);
    });
});

setInterval(async () => { if (advanceStreak()) { await saveStreakToDB(); emitStreak(); } }, 60000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});
