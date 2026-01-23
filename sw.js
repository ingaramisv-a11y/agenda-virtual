const DEFAULT_NOTIFICATION_TITLE = "Agenda Pro";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch (_error) {
      return { body: event.data?.text() };
    }
  })();

  const title = payload.title || DEFAULT_NOTIFICATION_TITLE;
  const options = {
    body: payload.body || "Tienes una nueva actualización.",
    data: payload.data || {},
  };

  if (payload.icon) {
    options.icon = payload.icon;
  }
  if (payload.badge) {
    options.badge = payload.badge;
  }
  if (payload.tag) {
    options.tag = payload.tag;
  }
  if (payload.actions) {
    options.actions = payload.actions;
  }
  if (typeof payload.requireInteraction === "boolean") {
    options.requireInteraction = payload.requireInteraction;
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        const matchingClient = clientList.find((client) => {
          try {
            return client.url.includes(targetUrl);
          } catch (_error) {
            return false;
          }
        });

        if (matchingClient) {
          return matchingClient.focus();
        }

        return self.clients.openWindow(targetUrl);
      })
  );
});
