const DEFAULT_NOTIFICATION_TITLE = "Agenda Pro";
const FALLBACK_TARGET_URL = "/";
const ACTION_ACCEPT_PLAN = "accept-plan";
const ACTION_REJECT_PLAN = "reject-plan";

const focusOrOpenUrl = async (targetUrl = FALLBACK_TARGET_URL) => {
  const normalizedUrl = targetUrl || FALLBACK_TARGET_URL;
  let absoluteUrl = normalizedUrl;
  try {
    absoluteUrl = new URL(normalizedUrl, self.location.origin).href;
  } catch (_error) {
    absoluteUrl = normalizedUrl;
  }
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const matchingClient = clientsList.find((client) => {
    try {
      return client.url === absoluteUrl || client.url.includes(absoluteUrl);
    } catch (_error) {
      return false;
    }
  });

  if (matchingClient) {
    await matchingClient.focus();
    return matchingClient;
  }

  return self.clients.openWindow(absoluteUrl);
};

const broadcastMessage = async (message) => {
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clientsList.forEach((client) => client.postMessage(message));
};

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

  if (!options.data.url) {
    options.data.url = FALLBACK_TARGET_URL;
  }

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
  } else {
    options.actions = [
      { action: ACTION_ACCEPT_PLAN, title: "Aceptar plan" },
      { action: ACTION_REJECT_PLAN, title: "Rechazar" },
    ];
  }
  if (typeof payload.requireInteraction === "boolean") {
    options.requireInteraction = payload.requireInteraction;
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || FALLBACK_TARGET_URL;
  const action = event.action;

  if (action === ACTION_ACCEPT_PLAN || action === ACTION_REJECT_PLAN) {
    const decision = action === ACTION_ACCEPT_PLAN ? "accept" : "reject";
    event.waitUntil(
      broadcastMessage({ type: "push-plan-action", decision, payload: event.notification.data || {} }).then(() =>
        focusOrOpenUrl(targetUrl)
      )
    );
    return;
  }

  event.waitUntil(focusOrOpenUrl(targetUrl));
});
