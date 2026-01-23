document.addEventListener("DOMContentLoaded", () => {
  const SERVICE_WORKER_PATH = "sw.js";
  const PHONE_DIGITS_MIN_LENGTH = 10;
  const PHONE_DIGITS_MAX_LENGTH = 15;
  const DEFAULT_PUBLIC_BASE_URL = "https://inalienably-disordered-bart.ngrok-free.dev";

  const authScreen = document.getElementById("auth-screen");
  const appShell = document.getElementById("app-shell");
  const authForm = document.getElementById("auth-form");
  const authUsernameInput = document.getElementById("auth-username");
  const authPasswordInput = document.getElementById("auth-password");
  const authMessage = document.getElementById("auth-message");
  const authRegisterButton = document.getElementById("auth-register");
  const socialButtons = document.querySelectorAll("[data-social-login]");
  const viewElements = Array.from(document.querySelectorAll("[data-view]"));
  const emptyView = document.getElementById("view-empty");
  const formCard = document.getElementById("form-plan");
  const openFormButton = document.getElementById("btn-nuevo-plan");
  const planForm = document.getElementById("plan-form");
  const dayCheckboxes = document.querySelectorAll("[data-day-checkbox]");
  const horarioStep = document.getElementById("horario-step");
  const horaInput = document.getElementById("horaSeleccion");
  const consultaCard = document.getElementById("consulta-plan");
  const openConsultaButton = document.getElementById("btn-consultar-plan");
  const consultaForm = document.getElementById("consulta-form");
  const consultaInput = document.getElementById("consultaTermino");
  const resultadoContenedor = document.getElementById("resultado-plan");
  const horarioCard = document.getElementById("horario-card");
  const openHorarioButton = document.getElementById("btn-horario");
  const weekLabel = document.getElementById("week-label");
  const weekRange = document.getElementById("week-range");
  const weekGrid = document.getElementById("week-grid");
  const navButtons = document.querySelectorAll(".panel-action");
  const viewToNavButton = {
    plan: openFormButton,
    consulta: openConsultaButton,
    horario: openHorarioButton,
  };

  let planMostradoId = null;
  let isAuthenticated = false;
  let swRegistrationPromise = null;
  let cachedVapidPublicKey = null;
  let phoneRegistrationInFlight = false;
  let phoneRegistrationElements = null;

  const VALID_USER = "diana";
  const VALID_PASS = "12345";
  const sanitizeDigits = (value = "") => value.replace(/[^0-9]/g, "");
  const resolveBackendBaseUrl = () => {
    if (typeof window === "undefined") {
      return "";
    }

    let storedBase = null;
    try {
      storedBase = localStorage.getItem("agenda-backend-base-url");
    } catch (_error) {
      storedBase = null;
    }

    const metaBase = document.querySelector('meta[name="backend-base-url"]')?.content;
    const candidates = [
      window.__BACKEND_BASE_URL__,
      window.__API_BASE_URL__,
      metaBase,
      storedBase,
      window.location?.origin,
      DEFAULT_PUBLIC_BASE_URL,
    ];
    const selected = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length);
    if (!selected) {
      return "";
    }

    const normalized = selected.trim().replace(/\/$/, "");
    try {
      if (normalized && normalized !== storedBase) {
        localStorage.setItem("agenda-backend-base-url", normalized);
      }
    } catch (_error) {
      /* no-op */
    }
    return normalized;
  };

  let BACKEND_BASE_URL = resolveBackendBaseUrl();
  if (!BACKEND_BASE_URL) {
    BACKEND_BASE_URL = DEFAULT_PUBLIC_BASE_URL;
  }
  const API_BASE_URL = `${BACKEND_BASE_URL}/api`;
  const PUSH_BASE_URL = `${BACKEND_BASE_URL}/push`;
  const APP_PUBLIC_URL = BACKEND_BASE_URL;

  const apiFetch = async (url, options = {}) => {
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: "Error desconocido" }));
      const error = new Error(errorBody.error || response.statusText || "Error en la solicitud");
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  const api = {
    requestPlanConfirmation: (payload) =>
      apiFetch(`${API_BASE_URL}/planes/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    searchPlan: (term) => apiFetch(`${API_BASE_URL}/planes?termino=${encodeURIComponent(term)}`),
    toggleClase: (planId, claseIndex) =>
      apiFetch(`${API_BASE_URL}/planes/${planId}/clases/${claseIndex}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      }),
    deletePlan: (planId) =>
      apiFetch(`${API_BASE_URL}/planes/${planId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      }),
    getPushPublicKey: () => apiFetch(`${PUSH_BASE_URL}/public-key`),
    registerPushContact: (payload) =>
      apiFetch(`${PUSH_BASE_URL}/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    sendPushNotification: (payload) =>
      apiFetch(`${PUSH_BASE_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
  };

  const showSection = (element) => {
    if (!element) return;
    if (element.hasAttribute("hidden")) {
      element.removeAttribute("hidden");
    }
    element.setAttribute("aria-hidden", "false");
  };

  const hideSection = (element) => {
    if (!element) return;
    element.setAttribute("aria-hidden", "true");
    if (!element.hasAttribute("hidden")) {
      element.setAttribute("hidden", "");
    }
  };

  const setActiveNavButton = (button = null) => {
    navButtons.forEach((navButton) => {
      navButton.classList.toggle("is-active", navButton === button);
    });
  };

  const requestNotificationPermission = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return false;
    }

    if (Notification.permission === "granted") {
      return true;
    }

    if (Notification.permission === "denied") {
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      return permission === "granted";
    } catch (error) {
      console.error("No se pudo obtener el permiso de notificaciones", error);
      return false;
    }
  };

  const urlBase64ToUint8Array = (base64String = "") => {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const normalized = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(normalized);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  };

  const ensureServiceWorkerRegistration = async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return null;
    }

    if (!swRegistrationPromise) {
      swRegistrationPromise = navigator.serviceWorker.register(SERVICE_WORKER_PATH).catch((error) => {
        console.error("No se pudo registrar el service worker", error);
        swRegistrationPromise = null;
        throw new Error("No pudimos activar las notificaciones push en este navegador.");
      });
    }

    return swRegistrationPromise;
  };

  const readStaticVapidKey = () => {
    if (
      typeof window !== "undefined" &&
      typeof window.__PUSH_PUBLIC_KEY__ === "string" &&
      window.__PUSH_PUBLIC_KEY__.trim()
    ) {
      return window.__PUSH_PUBLIC_KEY__.trim();
    }

    const metaTag = document.querySelector('meta[name="vapid-public-key"]');
    if (metaTag?.content?.trim()) {
      return metaTag.content.trim();
    }

    return null;
  };

  const getVapidPublicKey = async () => {
    if (cachedVapidPublicKey) {
      return cachedVapidPublicKey;
    }

    const staticKey = readStaticVapidKey();
    if (staticKey) {
      cachedVapidPublicKey = staticKey;
      return cachedVapidPublicKey;
    }

    if (!api.getPushPublicKey) {
      throw new Error("No se encontró la configuración de notificaciones push.");
    }

    try {
      const response = await api.getPushPublicKey();
      const publicKey =
        response?.data?.publicKey ||
        response?.publicKey ||
        response?.data?.vapidPublicKey ||
        response?.vapidPublicKey ||
        null;

      if (!publicKey) {
        throw new Error("No se pudo obtener la clave pública.");
      }

      cachedVapidPublicKey = publicKey;
      return cachedVapidPublicKey;
    } catch (error) {
      console.error("No se pudo obtener la clave pública VAPID", error);
      throw new Error("No fue posible preparar las notificaciones push.");
    }
  };

  const getOrCreatePushSubscription = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      throw new Error("Tu navegador no soporta notificaciones push.");
    }

    const registration = await ensureServiceWorkerRegistration();
    if (!registration || !registration.pushManager) {
      throw new Error("No se pudo acceder al Service Worker para crear la suscripción push.");
    }

    const existingSubscription = await registration.pushManager.getSubscription();
    if (existingSubscription) {
      return existingSubscription;
    }

    const publicKey = await getVapidPublicKey();
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    try {
      return await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    } catch (error) {
      console.error("No se pudo crear la suscripción push", error);
      throw new Error("No pudimos activar las notificaciones push. Inténtalo nuevamente.");
    }
  };

  const ensurePhoneRegistrationElements = () => {
    if (phoneRegistrationElements) {
      return phoneRegistrationElements;
    }

    if (!authRegisterButton) {
      return null;
    }

    const form = document.createElement("form");
    form.id = "phone-registration-form";
    form.classList.add("phone-registration-form");
    form.hidden = true;
    form.setAttribute("aria-hidden", "true");
    form.noValidate = true;

    const label = document.createElement("label");
    label.setAttribute("for", "phone-registration-input");
    label.textContent = "Número de teléfono para alertas";

    const input = document.createElement("input");
    input.type = "tel";
    input.id = "phone-registration-input";
    input.placeholder = "300 123 4567";
    input.inputMode = "tel";
    input.autocomplete = "tel";
    input.required = true;

    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.classList.add("secondary-action");
    submitButton.textContent = "Confirmar número";

    const feedback = document.createElement("p");
    feedback.classList.add("auth-message", "phone-registration-message");
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "assertive");

    form.append(label, input, submitButton, feedback);
    authRegisterButton.insertAdjacentElement("afterend", form);

    form.addEventListener("submit", handlePhoneRegistrationSubmit);

    phoneRegistrationElements = { form, input, submitButton, feedback };
    return phoneRegistrationElements;
  };

  const setPhoneRegistrationVisibility = (isVisible) => {
    const elements = ensurePhoneRegistrationElements();
    if (!elements) {
      return;
    }

    if (isVisible) {
      elements.form.removeAttribute("hidden");
      elements.form.setAttribute("aria-hidden", "false");
    } else if (!elements.form.hasAttribute("hidden")) {
      elements.form.setAttribute("hidden", "");
      elements.form.setAttribute("aria-hidden", "true");
    }
  };

  const setPhoneRegistrationMessage = (message, isSuccess = false) => {
    const elements = ensurePhoneRegistrationElements();
    if (!elements) {
      return;
    }

    elements.feedback.textContent = message || "";
    elements.feedback.classList.toggle("success", Boolean(isSuccess));
  };

  const showPhoneRegistrationForm = () => {
    const elements = ensurePhoneRegistrationElements();
    if (!elements) {
      return;
    }

    setPhoneRegistrationVisibility(true);
    setPhoneRegistrationMessage("");
    elements.input.focus({ preventScroll: true });
  };

  async function handlePhoneRegistrationSubmit(event) {
    event.preventDefault();
    if (phoneRegistrationInFlight) {
      return;
    }

    const elements = ensurePhoneRegistrationElements();
    if (!elements) {
      return;
    }

    const digits = sanitizeDigits(elements.input.value);
    if (digits.length < PHONE_DIGITS_MIN_LENGTH || digits.length > PHONE_DIGITS_MAX_LENGTH) {
      setPhoneRegistrationMessage(
        `Ingresa un número válido de ${PHONE_DIGITS_MIN_LENGTH} a ${PHONE_DIGITS_MAX_LENGTH} dígitos.`
      );
      return;
    }

    if (typeof window === "undefined" || !("Notification" in window)) {
      setPhoneRegistrationMessage("Tu navegador no soporta notificaciones push.");
      return;
    }

    if (!api.registerPushContact) {
      setPhoneRegistrationMessage("El backend aún no admite el registro de notificaciones.");
      return;
    }

    phoneRegistrationInFlight = true;
    elements.submitButton.disabled = true;
    setPhoneRegistrationMessage("Procesando registro...");

    try {
      const permissionGranted = await requestNotificationPermission();
      if (!permissionGranted) {
        throw new Error("Para continuar debes aceptar las notificaciones del navegador.");
      }

      const subscription = await getOrCreatePushSubscription();
      const subscriptionPayload = typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;

      await api.registerPushContact({
        phone: digits,
        subscription: subscriptionPayload,
      });

      setPhoneRegistrationMessage("Listo, guardamos tu teléfono y suscripción.", true);
      elements.form.reset();
    } catch (error) {
      console.error("Error registrando el teléfono para notificaciones", error);
      setPhoneRegistrationMessage(error.message || "No se pudo completar el registro.");
    } finally {
      phoneRegistrationInFlight = false;
      elements.submitButton.disabled = false;
    }
  }

  const setActiveView = (targetView = null) => {
    let resolvedView = null;

    viewElements.forEach((view) => {
      const isTarget = Boolean(targetView && view.dataset.view === targetView);
      if (isTarget) {
        resolvedView = view;
        showSection(view);
        view.classList.add("is-visible");
      } else {
        hideSection(view);
        view.classList.remove("is-visible");
      }
    });

    if (emptyView) {
      if (resolvedView) {
        hideSection(emptyView);
      } else {
        showSection(emptyView);
      }
    }
  };

  const setAuthStatusMessage = (message, isSuccess = false) => {
    if (!authMessage) return;
    authMessage.textContent = message || "";
    authMessage.classList.toggle("success", Boolean(isSuccess));
  };

  const unlockAppShell = ({ targetView = null } = {}) => {
    if (!isAuthenticated) {
      isAuthenticated = true;
      if (authScreen) {
        authScreen.style.display = "none";
        authScreen.setAttribute("hidden", "");
        authScreen.setAttribute("aria-hidden", "true");
      }

      if (appShell) {
        appShell.style.display = "flex";
        appShell.removeAttribute("hidden");
        appShell.setAttribute("aria-hidden", "false");
      }
    }

    const viewToShow = typeof targetView === "string" ? targetView : null;
    setActiveView(viewToShow);
    if (viewToShow && viewToNavButton[viewToShow]) {
      setActiveNavButton(viewToNavButton[viewToShow]);
    } else {
      setActiveNavButton(null);
    }
  };

  if (authForm) {
    authForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const username = authUsernameInput?.value.trim().toLowerCase() || "";
      const password = authPasswordInput?.value.trim() || "";

      if (username === VALID_USER && password === VALID_PASS) {
        setAuthStatusMessage("Acceso concedido.", true);
        unlockAppShell();
      } else {
        setAuthStatusMessage("Credenciales inválidas.");
      }
    });
  }

  if (authRegisterButton) {
    authRegisterButton.addEventListener("click", () => {
      showPhoneRegistrationForm();
    });
  }

  socialButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const provider = button.dataset.socialLogin === "google" ? "Google" : "Facebook";
      setAuthStatusMessage(`${provider} estará disponible pronto. Mientras tanto, usa tus credenciales temporales.`);
    });
  });

  const updateHorarioVisibility = () => {
    if (!horarioStep || !horaInput) return;
    const anySelected = Array.from(dayCheckboxes).some((checkbox) => checkbox.checked);
    horarioStep.classList.toggle("is-active", anySelected);
    horaInput.disabled = !anySelected;
    horaInput.required = anySelected;
    if (!anySelected) {
      horaInput.value = "";
    }
  };

  dayCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updateHorarioVisibility);
  });

  if (openFormButton && formCard) {
    openFormButton.addEventListener("click", () => {
      if (!isAuthenticated) {
        setAuthStatusMessage("Inicia sesión para registrar un nuevo plan.");
        return;
      }
      setActiveView("plan");
      setActiveNavButton(openFormButton);
    });
  }

  if (openConsultaButton && consultaCard) {
    openConsultaButton.addEventListener("click", () => {
      if (!isAuthenticated) {
        setAuthStatusMessage("Inicia sesión para revisar los planes registrados.");
        return;
      }
      setActiveView("consulta");
      setActiveNavButton(openConsultaButton);
      consultaInput?.focus({ preventScroll: true });
    });
  }

  const renderResultado = (plan) => {
    if (!resultadoContenedor) return;
    if (!plan) {
      resultadoContenedor.innerHTML = '<p class="empty-state">No se encontró un plan con los datos ingresados. Verifica el nombre o número.</p>';
      planMostradoId = null;
      return;
    }

    const clasesMarkup = plan.clases
      .map(
        (clase, index) => `
        <li class="clase-item">
          <button type="button" class="clase-indicador ${clase.completada ? "is-completada" : ""}" data-plan-id="${plan.id}" data-clase-index="${index}" aria-pressed="${clase.completada}"></button>
          <span>Clase ${index + 1}</span>
        </li>`
      )
      .join("");

    resultadoContenedor.innerHTML = `
      <div class="resultado-header">
        <div class="resultado-summary">
          <h3>${plan.nombre}</h3>
          <span>${plan.tipoPlan} clases</span>
        </div>
        <button
          type="button"
          class="delete-plan-btn"
          data-delete-plan-id="${plan.id}"
          aria-label="Eliminar plan de ${plan.nombre}"
        >Eliminar plan</button>
      </div>
      <ul class="lista-clases">
        ${clasesMarkup}
      </ul>
    `;

    planMostradoId = plan.id;
  };

  const construirClases = (cantidad) =>
    Array.from({ length: cantidad }, (_, index) => ({ numero: index + 1, completada: false }));

  const monthNames = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];

  const dayNames = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ];

  const TARGET_YEAR = 2026;

  const getReferenceToday = () => {
    const realNow = new Date();
    const monthIndex = realNow.getMonth();
    const lastDayOfMonth = new Date(TARGET_YEAR, monthIndex + 1, 0).getDate();
    const safeDay = Math.min(realNow.getDate(), lastDayOfMonth);
    return new Date(TARGET_YEAR, monthIndex, safeDay);
  };

  const getVisibleWeekDays = () => {
    const today = getReferenceToday();
    const startOfWeek = new Date(today);
    const isoDay = (today.getDay() + 6) % 7;
    startOfWeek.setDate(today.getDate() - isoDay);

    const weekDays = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(startOfWeek);
      date.setDate(startOfWeek.getDate() + index);
      return date;
    });

    const visibleDays = weekDays.filter((date) => date.getMonth() === today.getMonth() && date <= today);
    return { today, visibleDays };
  };

  const renderWeekCalendar = () => {
    if (!weekGrid || !weekLabel || !weekRange) return;
    const { today, visibleDays } = getVisibleWeekDays();
    const monthName = monthNames[today.getMonth()];
    weekLabel.textContent = `Semana actual · ${monthName} ${TARGET_YEAR}`;

    if (!visibleDays.length) {
      weekRange.textContent = "Sin días de esta semana para mostrar";
      weekGrid.innerHTML = '<p class="empty-state">Aún no hay días transcurridos esta semana.</p>';
      return;
    }

    const firstVisible = visibleDays[0];
    const lastVisible = visibleDays[visibleDays.length - 1];
    weekRange.textContent = `Del ${firstVisible.getDate()} al ${lastVisible.getDate()} de ${monthName}`;

    const markup = visibleDays
      .map((date) => {
        const isToday = date.getDate() === today.getDate();
        const status = isToday ? "Hoy" : "Día transcurrido";
        return `
          <div class="day-card ${isToday ? "is-today" : ""}">
            <p class="day-name">${dayNames[date.getDay()]}</p>
            <span class="day-number">${date.getDate()}</span>
            <span class="day-status">${status}</span>
          </div>
        `;
      })
      .join("");

    weekGrid.innerHTML = markup;
  };

  if (planForm) {
    planForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!isAuthenticated) {
        setAuthStatusMessage("Inicia sesión para poder registrar planes nuevos.");
        return;
      }

      const nombreAlumno = planForm.nombreAlumno.value.trim();
      const edadAlumno = planForm.edadAlumno.value.trim();
      const nombreAcudiente = planForm.nombreAcudiente.value.trim();
      const telefonoAcudiente = planForm.telefonoAcudiente.value.trim();
      const tipoPlan = planForm.tipoPlan.value;
      const horaSeleccion = horaInput?.value || "";
      const diasSeleccionados = Array.from(dayCheckboxes)
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value);

      if (!diasSeleccionados.length) {
        alert("Selecciona al menos un día para el horario.");
        return;
      }

      if (!horaSeleccion) {
        alert("Selecciona una hora para el horario.");
        return;
      }

      const nuevoPlan = {
        nombre: nombreAlumno,
        edad: Number(edadAlumno) || null,
        acudiente: nombreAcudiente,
        telefono: telefonoAcudiente,
        tipoPlan: Number(tipoPlan),
        dias: diasSeleccionados,
        hora: horaSeleccion,
        clases: construirClases(Number(tipoPlan)),
      };

      try {
        const pendingResponse = await api.requestPlanConfirmation(nuevoPlan);
        const pendingId = pendingResponse?.data?.pendingId || null;
        const telefonoDigits = sanitizeDigits(telefonoAcudiente);

        if (telefonoDigits) {
          try {
            await api.sendPushNotification({
              phone: telefonoDigits,
              notification: {
                title: `Confirma el plan de ${nombreAlumno}`,
                body: `Selecciona aceptar para aprobar las ${tipoPlan} clases propuestas.`,
                data: {
                  pendingId,
                  telefono: telefonoDigits,
                  alumno: nombreAlumno,
                  url: `${APP_PUBLIC_URL}?pending=${pendingId || ""}`,
                },
              },
            });
          } catch (pushError) {
            console.warn("No se pudo enviar la notificación push", pushError);
          }
        }

        planForm.reset();
        dayCheckboxes.forEach((checkbox) => {
          checkbox.checked = false;
        });
        updateHorarioVisibility();
        alert("Solicitud enviada. Espera a que el acudiente acepte la notificación para guardar el plan.");
      } catch (error) {
        alert(error.message);
      }
    });
  }

  if (consultaForm) {
    consultaForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!isAuthenticated) {
        setAuthStatusMessage("Inicia sesión para buscar planes registrados.");
        return;
      }
      const termino = (consultaInput?.value || "").trim().toLowerCase();
      const terminoNumerico = sanitizeDigits(termino);

      if (!termino) {
        renderResultado(null);
        return;
      }

      try {
        const response = await api.searchPlan(terminoNumerico || termino);
        renderResultado(response.data);
      } catch (error) {
        renderResultado(null);
        if (error.status !== 404) {
          alert(error.message);
        }
      }
    });
  }

  if (openHorarioButton && horarioCard) {
    openHorarioButton.addEventListener("click", () => {
      if (!isAuthenticated) {
        setAuthStatusMessage("Inicia sesión para visualizar el horario semanal.");
        return;
      }
      renderWeekCalendar();
      setActiveView("horario");
      setActiveNavButton(openHorarioButton);
    });
  }

  if (resultadoContenedor) {
    resultadoContenedor.addEventListener("click", (event) => {
      if (!isAuthenticated) {
        setAuthStatusMessage("Inicia sesión para administrar las clases registradas.");
        return;
      }
      const deleteButton = event.target.closest(".delete-plan-btn");
      if (deleteButton) {
        const { deletePlanId } = deleteButton.dataset;
        if (!deletePlanId) return;
        const nombrePlan =
          resultadoContenedor.querySelector(".resultado-header h3")?.textContent?.trim() || "este plan";
        const confirmed = window.confirm(`¿Quieres eliminar definitivamente ${nombrePlan}?`);
        if (!confirmed) return;

        api
          .deletePlan(deletePlanId)
          .then(() => {
            renderResultado(null);
            alert("Plan eliminado correctamente.");
          })
          .catch((error) => {
            alert(error.message);
          });
        return;
      }

      const indicador = event.target.closest(".clase-indicador");
      if (!indicador) return;

      const { planId, claseIndex } = indicador.dataset;
      if (!planId) return;

      api
        .toggleClase(planId, claseIndex)
        .then((response) => {
          if (planMostradoId === response.data.id) {
            renderResultado(response.data);
          }
        })
        .catch((error) => {
          alert(error.message);
        });
    });
  }

  renderWeekCalendar();
  setActiveView();
  updateHorarioVisibility();

  if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const payload = event.data || {};
      if (payload.type !== "push-plan-action") {
        return;
      }

      if (payload.decision === "accept") {
        alert("Gracias por aceptar el plan. Notificaremos a la administración.");
      } else if (payload.decision === "reject") {
        alert("Has rechazado el plan pendiente. Ponte en contacto con la administración si necesitas ajustes.");
      }
    });
  }
});
