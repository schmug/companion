/// <reference lib="webworker" />

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: "Companion", body: event.data?.text() || "" };
  }

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // If any app window is focused, skip — the in-tab notification handles it
        const anyFocused = windowClients.some((c) => c.focused);
        if (anyFocused) return;

        return self.registration.showNotification(
          payload.title || "Companion",
          {
            body: payload.body || "",
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            tag: payload.data?.sessionId || "default",
            data: payload.data || {},
          },
        );
      }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const url = sessionId ? `/#/session/${sessionId}` : "/";

  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      // Try to focus an existing app window
      for (const client of windowClients) {
        if ("focus" in client) {
          client.focus();
          client.postMessage({ type: "navigate", sessionId });
          return;
        }
      }
      // No existing window — open a new one
      return clients.openWindow(url);
    }),
  );
});
