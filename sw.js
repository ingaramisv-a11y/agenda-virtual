const DEFAULT_NOTIFICATION_TITLE = "Agenda Pro";
const FALLBACK_TARGET_URL = "https://agenda-virtual-backend-di4k.onrender.com/";
const ACTION_ACCEPT_PLAN = "accept-plan";
const ACTION_REJECT_PLAN = "reject-plan";
const ACTION_ACCEPT_CLASS = "accept-class";
const ACTION_REJECT_CLASS = "reject-class";

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
  const pendingId = event.notification.data?.pendingId;
  const planId = event.notification.data?.planId;
  const claseIndex = event.notification.data?.claseIndex;

  if (action === ACTION_ACCEPT_PLAN || action === ACTION_REJECT_PLAN) {
    const decision = action === ACTION_ACCEPT_PLAN ? "accept" : "reject";
    event.waitUntil(
      (async () => {
        if (pendingId) {
          try {
            await fetch(`/api/planes/pending/${pendingId}/decision`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision }),
            });
          } catch (error) {
            console.error("No se pudo registrar la decisión desde el Service Worker", error);
          }
        }

        await broadcastMessage({ type: "push-plan-action", decision, payload: event.notification.data || {} });
        return focusOrOpenUrl(targetUrl);
      })()
    );
    return;
  }

  if (action === ACTION_ACCEPT_CLASS || action === ACTION_REJECT_CLASS) {
    const decision = action === ACTION_ACCEPT_CLASS ? "accept" : "reject";
    event.waitUntil(
      (async () => {
        if (pendingId && planId && claseIndex !== undefined) {
          try {
            await fetch(`/api/planes/${planId}/clases/${claseIndex}/firma/decision`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision, pendingId }),
            });
          } catch (error) {
            console.error("No se pudo registrar la firma de clase desde el Service Worker", error);
          }
        }

        await broadcastMessage({
          type: "class-signature-action",
          decision,
          payload: event.notification.data || {},
        });
        return focusOrOpenUrl(targetUrl);
      })()
    );
    return;
  }

  const openMessageType = event.notification.data?.type === "class-signature" ? "class-signature-open" : "push-plan-open";

  event.waitUntil(
    Promise.all([
      broadcastMessage({ type: openMessageType, payload: event.notification.data || {} }),
      focusOrOpenUrl(targetUrl),
    ])
  );
});
