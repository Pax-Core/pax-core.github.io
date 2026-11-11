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
  const errs = [...new Set(res.responses.filter((r) => r.error).map((r) => `${r.error.code}: ${r.error.message}`))];
  log("пуш", title, "→", uid, `${res.successCount}/${tokens.length}`, errs.length ? "| помилка: " + errs.join("; ") : "");
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
  if (byOwner && before.delegStatus !== after.delegStatus && !(after.done && !before.done))
    jobs.push(notify(after.assigneeUid, `${after.ownerName || "Керівник"}: ${STATUS[after.delegStatus] || after.delegStatus}`, after.title, { taskId: id, kind: "status" }));
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

// коментарі й фото до доручень
let notesReady = false;
function listenNotes() {
  db.collectionGroup("notes").onSnapshot((snap) => {
    if (!notesReady) { notesReady = true; log("коментарі: слухаю"); return; }
    snap.docChanges().forEach(async (ch) => {
      if (ch.type !== "added") return;
      const n = ch.doc.data();
      const taskRef = ch.doc.ref.parent.parent;
      if (!taskRef || taskRef.parent.id !== "tasks") return;
      try {
        const t = state.get(taskRef.id) || (await taskRef.get()).data();
        if (!t) return;
        const to = n.by === t.ownerUid ? t.assigneeUid : t.ownerUid;
        const who = n.byName || (n.by === t.ownerUid ? t.ownerName : t.assigneeName) || "Хтось";
        const title = n.kind === "accept" ? `${who}: роботу прийнято ✓` : n.kind === "return" ? `${who}: повернуто на доопрацювання` : (n.photo ? `📷 ${who}` : `💬 ${who}`);
        const body = t.title + (n.text ? ` — ${n.text}` : (n.photo ? " — фото" : ""));
        await notify(to, title, body, { taskId: taskRef.id, kind: "note" });
      } catch (e) { log("помилка коментаря", e.message); }
    });
  }, (err) => {
    log("слухач коментарів упав:", err.message, "— перезапуск за 10 с");
    notesReady = false;
    setTimeout(listenNotes, 10000);
  });
}
listenNotes();

// спільні списки: повідомити інших учасників
let itemsReady = false;
const itemDone = new Map();
function listenItems() {
  db.collectionGroup("items").onSnapshot((snap) => {
    if (!itemsReady) {
      snap.docs.forEach((d) => itemDone.set(d.ref.path, !!d.data().done));
      itemsReady = true; log("спільні списки: слухаю"); return;
    }
    snap.docChanges().forEach(async (ch) => {
      const it = ch.doc.data();
      const wasDone = itemDone.get(ch.doc.ref.path) || false;
      if (ch.type === "removed") itemDone.delete(ch.doc.ref.path); else itemDone.set(ch.doc.ref.path, !!it.done);
      const listRef = ch.doc.ref.parent.parent;
      if (!listRef || listRef.parent.id !== "lists" || ch.type === "removed") return;
      try {
        const l = (await listRef.get()).data();
        if (!l) return;
        const who = it.updatedByName || (l.memberNames || {})[it.updatedBy] || "Хтось";
        let title = null;
        if (ch.type === "added") title = `${who} додає в «${l.name}»`;
        else if (it.done && !wasDone) title = `${who} виконує ✓ «${l.name}»`;
        if (!title) return;
        const others = (l.members || []).filter((m) => m !== it.updatedBy);
        await Promise.all(others.map((m) => notify(m, title, it.title, { listId: listRef.id, kind: "shared" })));
      } catch (e) { log("помилка списку", e.message); }
    });
  }, (err) => {
    log("слухач списків упав:", err.message, "— перезапуск за 10 с");
    itemsReady = false;
    setTimeout(listenItems, 10000);
  });
}
listenItems();
setInterval(() => log("працюю, доручень:", state.size), 6 * 3600 * 1000);
