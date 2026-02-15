import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const COMPANION_DIR = join(homedir(), ".companion");
const VAPID_KEYS_PATH = join(COMPANION_DIR, "vapid-keys.json");
const SUBSCRIPTIONS_PATH = join(COMPANION_DIR, "push-subscriptions.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushPayload {
  title: string;
  body: string;
  data?: {
    sessionId?: string;
    type?: string;
  };
}

let vapidKeys: VapidKeys | null = null;

function ensureDir() {
  if (!existsSync(COMPANION_DIR)) {
    mkdirSync(COMPANION_DIR, { recursive: true });
  }
}

function loadVapidKeys(): VapidKeys {
  if (vapidKeys) return vapidKeys;

  ensureDir();

  if (existsSync(VAPID_KEYS_PATH)) {
    vapidKeys = JSON.parse(readFileSync(VAPID_KEYS_PATH, "utf-8"));
    return vapidKeys!;
  }

  const keys = webpush.generateVAPIDKeys();
  vapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2));
  console.log("[push] Generated new VAPID keys");
  return vapidKeys;
}

function loadSubscriptions(): PushSubscriptionData[] {
  if (!existsSync(SUBSCRIPTIONS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(SUBSCRIPTIONS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveSubscriptions(subs: PushSubscriptionData[]) {
  ensureDir();
  writeFileSync(SUBSCRIPTIONS_PATH, JSON.stringify(subs, null, 2));
}

export function getVapidPublicKey(): string {
  return loadVapidKeys().publicKey;
}

export function addSubscription(sub: PushSubscriptionData) {
  const subs = loadSubscriptions();
  // Deduplicate by endpoint
  const existing = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (existing >= 0) {
    subs[existing] = sub;
  } else {
    subs.push(sub);
  }
  saveSubscriptions(subs);
  console.log(`[push] Subscription added (total: ${subs.length})`);
}

export function removeSubscription(endpoint: string): boolean {
  const subs = loadSubscriptions();
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  if (filtered.length === subs.length) return false;
  saveSubscriptions(filtered);
  console.log(`[push] Subscription removed (total: ${filtered.length})`);
  return true;
}

export function getAllSubscriptions(): PushSubscriptionData[] {
  return loadSubscriptions();
}

export async function sendPushToAll(payload: PushPayload) {
  const subs = loadSubscriptions();
  if (subs.length === 0) return;

  const keys = loadVapidKeys();
  webpush.setVapidDetails("mailto:companion@localhost", keys.publicKey, keys.privateKey);

  const body = JSON.stringify(payload);
  const expired: string[] = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
        );
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 410 || statusCode === 404) {
          expired.push(sub.endpoint);
        } else {
          console.warn(`[push] Failed to send to ${sub.endpoint.substring(0, 60)}...: ${err}`);
        }
      }
    }),
  );

  // Clean up expired subscriptions
  if (expired.length > 0) {
    const remaining = loadSubscriptions().filter((s) => !expired.includes(s.endpoint));
    saveSubscriptions(remaining);
    console.log(`[push] Removed ${expired.length} expired subscription(s)`);
  }
}
