let swRegistration: ServiceWorkerRegistration | null = null;

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;

  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    return swRegistration;
  } catch (err) {
    console.warn("[push] Service worker registration failed:", err);
    return null;
  }
}

export async function subscribeToPush(): Promise<boolean> {
  try {
    const reg = swRegistration ?? (await registerServiceWorker());
    if (!reg) return false;

    // Get VAPID public key from server
    const res = await fetch("/api/push/vapid-key");
    if (!res.ok) return false;
    const { publicKey } = await res.json();

    // Convert URL-safe base64 to ArrayBuffer for applicationServerKey
    const applicationServerKey = urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer;

    // Subscribe to push
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });

    // Send subscription to server
    const subJson = subscription.toJSON();
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      }),
    });

    return true;
  } catch (err) {
    console.warn("[push] Subscribe failed:", err);
    return false;
  }
}

export async function unsubscribeFromPush(): Promise<boolean> {
  try {
    const reg = swRegistration ?? (await navigator.serviceWorker.getRegistration());
    if (!reg) return false;

    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return true;

    const endpoint = subscription.endpoint;

    await subscription.unsubscribe();

    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });

    return true;
  } catch (err) {
    console.warn("[push] Unsubscribe failed:", err);
    return false;
  }
}

export async function isPushSubscribed(): Promise<boolean> {
  try {
    const reg = swRegistration ?? (await navigator.serviceWorker.getRegistration());
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return sub !== null;
  } catch {
    return false;
  }
}

/** Listen for postMessage from service worker to handle notification click navigation */
export function setupSwMessageListener(
  onNavigate: (sessionId: string) => void,
) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "navigate" && event.data.sessionId) {
      onNavigate(event.data.sessionId);
    }
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
