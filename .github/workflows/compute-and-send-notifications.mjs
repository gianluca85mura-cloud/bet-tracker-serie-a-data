// Calcola quali notifiche broadcast mandare confrontando la versione
// precedente e quella nuova di analisi-oggi.json, poi le manda via FCM
// HTTP v1. Vedi ../../README.md (nel repo dell'app Flutter) per come
// attivarlo e DOCS/07-notifiche-app.md per le decisioni dietro.
//
// Uso: node compute-and-send-notifications.mjs <prevPathOrVuoto> <newPath>
// Env richieste: FCM_ACCESS_TOKEN, FCM_PROJECT_ID, FCM_TOPIC.
//
// Contratto del messaggio (deve combaciare con
// NotificationService.handleRemoteMessage nell'app Flutter): data-only,
// mai payload "notification" — vedi il perché in DOCS/07-notifiche-app.md.
// { type: "mattino" | "mezzogiorno", title: "...", body: "..." }

import { existsSync, readFileSync } from 'node:fs';

const [, , prevPathArg, newPath] = process.argv;
const prevPath = prevPathArg && prevPathArg.length > 0 ? prevPathArg : null;

function loadOrNull(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function computeNotifications(oldData, newData) {
  const toSend = [];
  const daily = newData?.daily;
  if (!daily) return toSend;

  const oldDate = oldData?.daily?.date;
  const newDate = daily.date;
  const matches = daily.matches ?? [];

  // Notifica 1: l'analisi di oggi è appena diventata disponibile
  // (transizione di data, non ad ogni singolo push dello stesso giorno).
  if (newDate && newDate !== oldDate && matches.length > 0) {
    let best = null;
    for (const m of matches) {
      for (const mk of m.mercati ?? []) {
        if (typeof mk.quotaIndicativa !== 'number' || typeof mk.probVera !== 'number') continue;
        const edge = mk.probVera - 1 / mk.quotaIndicativa;
        if (!best || edge > best.edge) {
          best = { edge, match: m.match, label: mk.label, quota: mk.quotaIndicativa };
        }
      }
    }
    const n = matches.length;
    const bestText = best
      ? ` — il migliore: ${best.match} ${best.label} @${best.quota.toFixed(2)}`
      : '';
    toSend.push({
      type: 'mattino',
      title: 'Pronostici di oggi pronti',
      body: `${n} partit${n === 1 ? 'a' : 'e'} oggi${bestText}`,
    });
  }

  // Notifica 2: una partita ha guadagnato voci in "aggiornamenti"
  // rispetto al giro precedente. Una sola notifica per giro anche se più
  // partite sono cambiate, per non spammare.
  const oldMatches = new Map((oldData?.daily?.matches ?? []).map((m) => [m.id ?? m.match, m]));
  for (const m of matches) {
    const prev = oldMatches.get(m.id ?? m.match);
    const prevCount = Array.isArray(prev?.aggiornamenti) ? prev.aggiornamenti.length : 0;
    const nowCount = Array.isArray(m.aggiornamenti) ? m.aggiornamenti.length : 0;
    if (nowCount > prevCount) {
      toSend.push({
        type: 'mezzogiorno',
        title: 'Aggiornamento su un pronostico',
        body: `Novità su ${m.match}`,
      });
      break;
    }
  }

  return toSend;
}

async function sendFcm({ token, projectId, topic, notification }) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        topic,
        data: { type: notification.type, title: notification.title, body: notification.body },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FCM ha risposto ${res.status}: ${text}`);
  }
  return text;
}

async function main() {
  const oldData = loadOrNull(prevPath);
  const newData = loadOrNull(newPath);

  const toSend = computeNotifications(oldData, newData);
  if (toSend.length === 0) {
    console.log('Nessuna notifica da mandare in questo giro.');
    return;
  }

  const token = process.env.FCM_ACCESS_TOKEN;
  const projectId = process.env.FCM_PROJECT_ID;
  const topic = process.env.FCM_TOPIC;
  if (!token || !projectId || !topic) {
    console.error('Mancano FCM_ACCESS_TOKEN / FCM_PROJECT_ID / FCM_TOPIC nell\'ambiente.');
    process.exitCode = 1;
    return;
  }

  let anyFailed = false;
  for (const notification of toSend) {
    try {
      await sendFcm({ token, projectId, topic, notification });
      console.log(`Inviata notifica "${notification.type}": ${notification.title}`);
    } catch (err) {
      anyFailed = true;
      console.error(`Invio fallito (${notification.type}): ${err.message}`);
    }
  }
  if (anyFailed) process.exitCode = 1;
}

await main();
