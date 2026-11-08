// Сервіс пушів «Зошита»: стежить за дорученнями у Firestore і надсилає сповіщення через FCM.
// Працює на власному сервері, тариф Blaze не потрібен.
const admin = require("firebase-admin");
const path = require("path");

admin.initializeApp({ credential: admin.credential.cert(require(process.env.SA_PATH || path.join(__dirname, "../../../sa.json"))) });
const db = admin.firestore();
const STATUS = { assigned: "доручено", progress: "в роботі", done: "виконано" };
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function notify(uid, title, body, data = {}) {
  if (!uid) return;
  const user = await db.collection("users").doc(uid).get();
  const tokens = (user.exists && user.data().fcmTokens) || [];
  if (!tokens.length) return log("немає токенів", uid);
  const res = await admin.messaging().sendEachForMulticast({
    tokens, notification: { title, body }, data,
    apns: { payload: { aps: { sound: "default" } } },
    android: { priority: "high", notification: { sound: "default", channelId: "delegations" } },
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(tokens[i]);
  });
  if (dead.length) await user.ref.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) });
  log("пуш", title, "→", uid, `${res.successCount}/${tokens.length}`);
}

const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
function when(d) {
  if (!d) return "";
  return " · до " + new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long" }).format(d.toDate());
}

async function onChange(id, before, after) {
  if (!before && after) return notify(after.assigneeUid, `Нове доручення від ${after.ownerName || "керівника"}`, after.title + when(after.deadline || after.due), { taskId: id, kind: "assigned" });
  if (before && !after) return notify(before.assigneeUid, "Доручення скасовано", before.title, { taskId: id, kind: "cancelled" });
  const byAssignee = after.updatedBy === after.assigneeUid;
  const byOwner = after.updatedBy === after.ownerUid;
  const jobs = [];
  if (byAssignee && before.delegStatus !== after.delegStatus)
    jobs.push(notify(after.ownerUid, `${after.assigneeName || "Виконавець"}: ${STATUS[after.delegStatus] || after.delegStatus}`, after.title, { taskId: id, kind: "status" }));
  if (byAssignee && after.report && after.report !== (before.report || ""))
    jobs.push(notify(after.ownerUid, `Звіт від ${after.assigneeName || "виконавця"}`, `${after.title}: ${after.report}`, { taskId: id, kind: "report" }));
  if (byOwner && (ms(before.due) !== ms(after.due) || ms(before.deadline) !== ms(after.deadline)))
    jobs.push(notify(after.assigneeUid, "Змінено термін доручення", after.title + when(after.deadline || after.due), { taskId: id, kind: "due" }));
  if (byOwner && before.title !== after.title)
    jobs.push(notify(after.assigneeUid, "Доручення змінено", after.title, { taskId: id, kind: "edit" }));
  return Promise.all(jobs);
}

const state = new Map();
let ready = false;
function listen() {
  db.collection("tasks").onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
      const id = ch.doc.id;
      const before = state.get(id) || null;
      const after = ch.type === "removed" ? null : ch.doc.data();
      if (after) state.set(id, after); else state.delete(id);
      if (ready) onChange(id, before, after).catch((e) => log("помилка", id, e.message));
    });
    if (!ready) { ready = true; log("готово, доручень:", state.size); }
  }, (err) => {
    log("слухач упав:", err.message, "— перезапуск за 10 с");
    ready = false; state.clear();
    setTimeout(listen, 10000);
  });
}
listen();
setInterval(() => log("працюю, доручень:", state.size), 6 * 3600 * 1000);
