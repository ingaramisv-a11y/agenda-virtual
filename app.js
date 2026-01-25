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
  const planReviewElements = {
    shell: document.getElementById("plan-review-shell"),
    backdrop: document.getElementById("plan-review-backdrop"),
    title: document.getElementById("plan-review-title"),
    meta: document.getElementById("plan-review-meta"),
    alumno: document.getElementById("plan-review-alumno"),
    acudiente: document.getElementById("plan-review-acudiente"),
    telefono: document.getElementById("plan-review-telefono"),
    dias: document.getElementById("plan-review-dias"),
    hora: document.getElementById("plan-review-hora"),
    clases: document.getElementById("plan-review-clases"),
    status: document.getElementById("plan-review-status"),
    acceptButton: document.getElementById("plan-review-accept"),
    rejectButton: document.getElementById("plan-review-reject"),
    closeButton: document.getElementById("plan-review-close"),
  };
  const classSignatureElements = {
    shell: document.getElementById("class-signature-shell"),
    backdrop: document.getElementById("class-signature-backdrop"),
    closeButton: document.getElementById("class-signature-close"),
    title: document.getElementById("class-signature-title"),
    meta: document.getElementById("class-signature-meta"),
    alumno: document.getElementById("class-signature-alumno"),
    numero: document.getElementById("class-signature-numero"),
    status: document.getElementById("class-signature-status"),
    acceptButton: document.getElementById("class-signature-accept"),
  };
  const classConfirmElements = {
    shell: document.getElementById("class-confirm-shell"),
    title: document.getElementById("class-confirm-title"),
    message: document.getElementById("class-confirm-message"),
    yesButton: document.getElementById("class-confirm-yes"),
    noButton: document.getElementById("class-confirm-no"),
  };

  let planMostradoId = null;
  let planDetalleActual = null;
  let isAuthenticated = false;
  let swRegistrationPromise = null;
  let cachedVapidPublicKey = null;
  let phoneRegistrationInFlight = false;
  let phoneRegistrationElements = null;
  let classConfirmResolver = null;
  let activeView = null;
  let resetConsultaOnNextShow = true;
  const planReviewState = {
    pendingId: null,
    record: null,
    isLoading: false,
    isResolving: false,
  };
  const classSignatureReviewState = {
    pendingId: null,
    planId: null,
    claseIndex: null,
    isLoading: false,
    isResolving: false,
  };
  const pendingClassWatchers = new Map();
  const scheduleState = {
    planes: [],
    lastFetchedAt: 0,
    isLoading: false,
  };

  const getClassWatcherKey = ({ pendingId, planId, claseIndex }) => {
    if (pendingId) {
      return pendingId;
    }
    return `${planId || 'plan'}-${claseIndex}`;
  };

  const stopPendingClassWatcher = (paramsOrKey) => {
    const key = typeof paramsOrKey === 'string' ? paramsOrKey : getClassWatcherKey(paramsOrKey || {});
    if (!key) {
      return;
    }
    const watcher = pendingClassWatchers.get(key);
    if (watcher) {
      clearInterval(watcher.intervalId);
      pendingClassWatchers.delete(key);
    }
  };

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
    getPendingPlan: (pendingId) => apiFetch(`${API_BASE_URL}/planes/pending/${pendingId}`),
    resolvePendingPlan: (pendingId, decision) =>
      apiFetch(`${API_BASE_URL}/planes/pending/${pendingId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      }),
    getPlanById: (planId) => apiFetch(`${API_BASE_URL}/planes/${planId}`),
    listPlans: () => apiFetch(`${API_BASE_URL}/planes/agenda`),
    requestClassSignature: (planId, claseIndex) =>
      apiFetch(`${API_BASE_URL}/planes/${planId}/clases/${claseIndex}/firma/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    getClassSignaturePending: (pendingId) => apiFetch(`${API_BASE_URL}/planes/clases/firma/${pendingId}`),
    resolveClassSignature: ({ planId, claseIndex, pendingId, decision }) =>
      apiFetch(`${API_BASE_URL}/planes/${planId}/clases/${claseIndex}/firma/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingId, decision }),
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

  const getPendingIdFromQuery = () => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("pending");
    } catch (_error) {
      return null;
    }
  };

  const clearPendingQueryParam = () => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("pending")) {
        return;
      }
      url.searchParams.delete("pending");
      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState({}, document.title, nextUrl);
    } catch (_error) {
      /* noop */
    }
  };

  const getClassPendingIdFromQuery = () => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("classPending");
    } catch (_error) {
      return null;
    }
  };

  const clearClassPendingQueryParam = () => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("classPending")) {
        return;
      }
      url.searchParams.delete("classPending");
      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState({}, document.title, nextUrl);
    } catch (_error) {
      /* noop */
    }
  };

  const formatPhoneDisplay = (value = "") => {
    const digits = sanitizeDigits(value);
    if (!digits) {
      return value || "Sin teléfono registrado";
    }
    if (digits.length === 10) {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    if (digits.length === 7) {
      return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    }
    return digits;
  };

  const formatDaysLabel = (dias = []) => {
    if (!Array.isArray(dias) || !dias.length) {
      return "Sin días asignados";
    }
    return dias
      .map((dia) => {
        if (!dia) return "";
        const normalized = dia.toString().toLowerCase();
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      })
      .filter(Boolean)
      .join(" · ");
  };

  const formatPlanMeta = (plan = {}) => {
    const clasesLabel = plan.tipoPlan ? `${plan.tipoPlan} clases` : "Plan personalizado";
    const diasLabel = formatDaysLabel(plan.dias);
    const horaLabel = plan.hora ? ` · ${plan.hora}` : "";
    return `${clasesLabel} · ${diasLabel}${horaLabel}`.trim();
  };

  const setPlanReviewVisibility = (isVisible) => {
    if (!planReviewElements.shell) return;
    if (isVisible) {
      planReviewElements.shell.removeAttribute("hidden");
      planReviewElements.shell.setAttribute("aria-hidden", "false");
      if (document.body) {
        document.body.classList.add("has-plan-review");
      }
    } else {
      planReviewElements.shell.setAttribute("hidden", "");
      planReviewElements.shell.setAttribute("aria-hidden", "true");
      if (document.body) {
        document.body.classList.remove("has-plan-review");
      }
    }
  };

  const setPlanReviewStatusMessage = (message, tone = "info") => {
    if (!planReviewElements.status) return;
    planReviewElements.status.textContent = message || "";
    planReviewElements.status.classList.remove("is-error", "is-success");
    if (tone === "error") {
      planReviewElements.status.classList.add("is-error");
    } else if (tone === "success") {
      planReviewElements.status.classList.add("is-success");
    }
  };

  const setPlanReviewButtonsDisabled = (disabled) => {
    [planReviewElements.acceptButton, planReviewElements.rejectButton].forEach((button) => {
      if (button) {
        button.disabled = Boolean(disabled);
        button.classList.toggle("is-disabled", Boolean(disabled));
      }
    });
  };

  const populatePlanReviewDetails = (record) => {
    if (!record || !record.payload) {
      return;
    }
    const plan = record.payload;
    if (planReviewElements.title) {
      planReviewElements.title.textContent = plan.nombre
        ? `Confirma el plan de ${plan.nombre}`
        : "Confirma el plan pendiente";
    }
    if (planReviewElements.meta) {
      planReviewElements.meta.textContent = formatPlanMeta(plan);
    }
    if (planReviewElements.alumno) {
      planReviewElements.alumno.textContent = plan.nombre || "Sin nombre registrado";
    }
    if (planReviewElements.acudiente) {
      planReviewElements.acudiente.textContent = plan.acudiente || "Sin acudiente";
    }
    if (planReviewElements.telefono) {
      planReviewElements.telefono.textContent = formatPhoneDisplay(plan.telefono);
    }
    if (planReviewElements.dias) {
      planReviewElements.dias.textContent = formatDaysLabel(plan.dias);
    }
    if (planReviewElements.hora) {
      planReviewElements.hora.textContent = plan.hora ? `${plan.hora} hrs` : "Sin horario definido";
    }
    if (planReviewElements.clases) {
      const clases = Array.isArray(plan.clases) ? plan.clases : [];
      const completadas = clases.filter((clase) => clase?.completada).length;
      planReviewElements.clases.textContent = `${clases.length} sesiones planificadas · ${completadas} completadas`;
    }
  };

  const dismissPlanReview = () => {
    if (planReviewState.isResolving) {
      return;
    }
    planReviewState.pendingId = null;
    planReviewState.record = null;
    planReviewState.isLoading = false;
    setPlanReviewButtonsDisabled(false);
    setPlanReviewStatusMessage("");
    setPlanReviewVisibility(false);
  };

  const handleClassSignatureDecisionFeedback = async ({ planId, claseIndex, decision }) => {
    if (!isAuthenticated || !decision) {
      return;
    }

    if (decision === 'accept') {
      alert('Clase firmada por el tutor.');
      return;
    }

    if (decision === 'reject') {
      const retry = await showClassConfirm({
        title: 'Clase rechazada',
        message: 'La clase fue rechazada. ¿Notificar de nuevo?',
        yesLabel: 'Sí',
        noLabel: 'No',
      });
      if (retry && planId && !Number.isNaN(claseIndex)) {
        await sendClassSignatureRequest(planId, claseIndex, { showSuccessMessage: false });
      } else {
        alert('La clase fue rechazada por el tutor.');
      }
    }
  };

  const startPendingClassWatcher = ({ planId, claseIndex, pendingId }) => {
    if (!isAuthenticated || typeof window === 'undefined') {
      return;
    }
    if (!planId || Number.isNaN(claseIndex) || claseIndex === null) {
      return;
    }

    const key = getClassWatcherKey({ planId, claseIndex, pendingId });
    if (pendingClassWatchers.has(key)) {
      return;
    }

    let attempts = 0;
    const maxAttempts = 60; // ~6 minutes with 6s interval

    const checkStatus = async () => {
      attempts += 1;
      try {
        const plan = await refreshPlanById(planId);
        if (!plan) {
          return;
        }
        const clase = plan.clases?.[claseIndex];
        if (!clase) {
          stopPendingClassWatcher(key);
          return;
        }

        const stillPending =
          clase.firmaEstado === 'pendiente' && (!pendingId || !clase.firmaPendienteId || clase.firmaPendienteId === pendingId);
        if (!stillPending) {
          stopPendingClassWatcher(key);
          const decision = clase.firmaEstado === 'firmada'
            ? 'accept'
            : clase.firmaEstado === 'rechazada'
              ? 'reject'
              : null;
          await handleClassSignatureDecisionFeedback({ planId, claseIndex, decision });
          return;
        }

        if (attempts >= maxAttempts) {
          stopPendingClassWatcher(key);
        }
      } catch (error) {
        console.error('No se pudo verificar la firma de la clase', error);
      }
    };

    const intervalId = window.setInterval(checkStatus, 6000);
    pendingClassWatchers.set(key, { intervalId });
    checkStatus();
  };

  const trackPlanPendingClasses = (plan) => {
    if (!isAuthenticated || !plan || !Array.isArray(plan.clases)) {
      return;
    }

    plan.clases.forEach((clase, index) => {
      if (clase.firmaEstado === 'pendiente' && clase.firmaPendienteId) {
        startPendingClassWatcher({ planId: plan.id, claseIndex: index, pendingId: clase.firmaPendienteId });
      }
    });
  };

  const openPlanReview = async (pendingId) => {
    if (!pendingId || !planReviewElements.shell) {
      return;
    }

    if (planReviewState.isLoading && planReviewState.pendingId === pendingId) {
      setPlanReviewVisibility(true);
      return;
    }

    planReviewState.pendingId = pendingId;
    planReviewState.isLoading = true;
    planReviewState.record = null;
    setPlanReviewVisibility(true);
    setPlanReviewButtonsDisabled(true);
    setPlanReviewStatusMessage("Cargando el resumen del plan...");

    try {
      const response = await api.getPendingPlan(pendingId);
      const record = response?.data;
      if (!record) {
        throw new Error("No encontramos la solicitud pendiente.");
      }
      planReviewState.record = record;
      populatePlanReviewDetails(record);
      setPlanReviewButtonsDisabled(false);
      setPlanReviewStatusMessage("Revisa los detalles antes de aceptar o solicitar cambios.");
      clearPendingQueryParam();
    } catch (error) {
      console.error("No se pudo cargar la solicitud pendiente", error);
      setPlanReviewStatusMessage(error.message || "No se pudo cargar la solicitud pendiente.", "error");
    } finally {
      planReviewState.isLoading = false;
    }
  };

  const handlePlanReviewDecision = async (decision) => {
    if (!planReviewState.pendingId || planReviewState.isResolving) {
      return;
    }
    planReviewState.isResolving = true;
    setPlanReviewButtonsDisabled(true);
    setPlanReviewStatusMessage(
      decision === "accept" ? "Confirmando plan..." : "Registrando tu solicitud de cambios..."
    );

    try {
      const response = await api.resolvePendingPlan(planReviewState.pendingId, decision);
      if (response?.data) {
        planReviewState.record = response.data;
      }
      const successMessage =
        decision === "accept"
          ? "Listo, agendamos las clases. ¡Gracias por confirmar!"
          : "Anotamos tu solicitud de cambios. Te contactaremos pronto.";
      setPlanReviewStatusMessage(successMessage, "success");
      if (decision === "accept") {
        refreshHorarioAgenda({ force: true });
      }
      setTimeout(() => dismissPlanReview(), 3200);
    } catch (error) {
      console.error("No se pudo registrar la decisión del plan", error);
      setPlanReviewStatusMessage(error.message || "No pudimos registrar tu decisión.", "error");
      setPlanReviewButtonsDisabled(false);
      planReviewState.isResolving = false;
      return;
    }

    planReviewState.isResolving = false;
  };

  const handleExternalPendingId = (pendingId) => {
    if (!pendingId) {
      return;
    }
    openPlanReview(pendingId);
  };

  const setClassSignatureVisibility = (isVisible) => {
    if (!classSignatureElements.shell) return;
    if (isVisible) {
      classSignatureElements.shell.removeAttribute("hidden");
      classSignatureElements.shell.setAttribute("aria-hidden", "false");
      if (document.body) {
        document.body.classList.add("has-plan-review");
      }
    } else {
      classSignatureElements.shell.setAttribute("hidden", "");
      classSignatureElements.shell.setAttribute("aria-hidden", "true");
      if (document.body) {
        document.body.classList.remove("has-plan-review");
      }
    }
  };

  const setClassSignatureStatusMessage = (message, tone = "info") => {
    if (!classSignatureElements.status) return;
    classSignatureElements.status.textContent = message || "";
    classSignatureElements.status.classList.remove("is-error", "is-success");
    if (tone === "error") {
      classSignatureElements.status.classList.add("is-error");
    } else if (tone === "success") {
      classSignatureElements.status.classList.add("is-success");
    }
  };

  const setClassSignatureButtonsDisabled = (disabled) => {
    if (classSignatureElements.acceptButton) {
      classSignatureElements.acceptButton.disabled = Boolean(disabled);
      classSignatureElements.acceptButton.classList.toggle("is-disabled", Boolean(disabled));
    }
  };

  const populateClassSignatureDetails = (record) => {
    if (!record) {
      return;
    }
    if (classSignatureElements.title) {
      classSignatureElements.title.textContent = record.alumno
        ? `Firma la clase de ${record.alumno}`
        : "Firma la clase";
    }
    if (classSignatureElements.meta) {
      classSignatureElements.meta.textContent = `Clase #${record.claseNumero} · ${record.hora || "Horario por definir"}`;
    }
    if (classSignatureElements.alumno) {
      classSignatureElements.alumno.textContent = record.alumno || "Sin nombre";
    }
    if (classSignatureElements.numero) {
      classSignatureElements.numero.textContent = record.claseNumero ? `Clase ${record.claseNumero}` : "Clase en curso";
    }
  };

  const dismissClassSignatureReview = () => {
    if (classSignatureReviewState.isResolving) {
      return;
    }
    classSignatureReviewState.pendingId = null;
    classSignatureReviewState.planId = null;
    classSignatureReviewState.claseIndex = null;
    classSignatureReviewState.isLoading = false;
    classSignatureReviewState.isResolving = false;
    setClassSignatureButtonsDisabled(false);
    setClassSignatureStatusMessage("");
    setClassSignatureVisibility(false);
  };

  const openClassSignatureReview = async (pendingId) => {
    if (!pendingId || !classSignatureElements.shell) {
      return;
    }

    if (classSignatureReviewState.isLoading && classSignatureReviewState.pendingId === pendingId) {
      setClassSignatureVisibility(true);
      return;
    }

    classSignatureReviewState.pendingId = pendingId;
    classSignatureReviewState.planId = null;
    classSignatureReviewState.claseIndex = null;
    classSignatureReviewState.isLoading = true;
    setClassSignatureVisibility(true);
    setClassSignatureButtonsDisabled(true);
    setClassSignatureStatusMessage("Cargando los detalles de la clase...");

    try {
      const response = await api.getClassSignaturePending(pendingId);
      const record = response?.data;
      if (!record) {
        throw new Error("No encontramos la solicitud de firma.");
      }
      classSignatureReviewState.planId = record.planId;
      classSignatureReviewState.claseIndex = record.claseIndex;
      populateClassSignatureDetails(record);
      setClassSignatureButtonsDisabled(false);
      setClassSignatureStatusMessage("Revisa los datos y firmarás la clase en un solo toque.");
      clearClassPendingQueryParam();
    } catch (error) {
      console.error("No se pudo cargar la clase pendiente", error);
      setClassSignatureStatusMessage(error.message || "No se pudo cargar la clase pendiente.", "error");
    } finally {
      classSignatureReviewState.isLoading = false;
    }
  };

  const handleClassSignatureAccept = async () => {
    const { pendingId, planId, claseIndex, isResolving } = classSignatureReviewState;
    if (!pendingId || !planId || Number.isNaN(claseIndex) || claseIndex === null || isResolving) {
      return;
    }

    classSignatureReviewState.isResolving = true;
    setClassSignatureButtonsDisabled(true);
    setClassSignatureStatusMessage("Firmando la clase...");

    try {
      await api.resolveClassSignature({ planId, claseIndex, pendingId, decision: "accept" });
      setClassSignatureStatusMessage("Gracias, registramos tu firma.", "success");
      refreshPlanById(planId);
      setTimeout(() => dismissClassSignatureReview(), 2200);
    } catch (error) {
      console.error("No se pudo firmar la clase", error);
      setClassSignatureStatusMessage(error.message || "No pudimos firmar la clase.", "error");
      setClassSignatureButtonsDisabled(false);
      classSignatureReviewState.isResolving = false;
      return;
    }

    classSignatureReviewState.isResolving = false;
  };

  const handleExternalClassPendingId = (pendingId) => {
    if (!pendingId) {
      return;
    }
    openClassSignatureReview(pendingId);
  };

  const setPlanDetalleActual = (plan) => {
    planDetalleActual = plan || null;
    planMostradoId = plan?.id || null;
  };

  const resetConsultaResultados = ({ clearInput = false, message = null } = {}) => {
    const displayMessage =
      message || "No hay resultados para mostrar. Registra un plan o realiza una búsqueda.";
    if (consultaInput && clearInput) {
      consultaInput.value = "";
    }
    if (resultadoContenedor) {
      resultadoContenedor.innerHTML = `<p class="empty-state">${displayMessage}</p>`;
    }
    setPlanDetalleActual(null);
  };

  const refreshPlanById = async (planId) => {
    if (!planId || !api.getPlanById) {
      return null;
    }
    try {
      const response = await api.getPlanById(planId);
      if (response?.data) {
        renderResultado(response.data);
        return response.data;
      }
    } catch (error) {
      console.error('No se pudo actualizar el plan solicitado', error);
    }
    return null;
  };

  const getClaseEstadoLabel = (clase) => {
    if (!clase) {
      return '';
    }
    switch (clase.firmaEstado) {
      case 'firmada':
        return 'Clase firmada por tutor';
      case 'rechazada':
        return 'Clase rechazada por tutor';
      case 'pendiente':
        return 'Firma solicitada al tutor';
      default:
        return '';
    }
  };

  const getClaseEstadoClass = (clase) => {
    if (!clase) {
      return '';
    }
    if (clase.firmaEstado === 'firmada') {
      return 'is-signed';
    }
    if (clase.firmaEstado === 'rechazada') {
      return 'is-rejected';
    }
    if (clase.firmaEstado === 'pendiente') {
      return 'is-pending';
    }
    return '';
  };

  const setClassConfirmVisibility = (isVisible) => {
    if (!classConfirmElements.shell) return;
    if (isVisible) {
      classConfirmElements.shell.removeAttribute('hidden');
      classConfirmElements.shell.setAttribute('aria-hidden', 'false');
    } else {
      classConfirmElements.shell.setAttribute('hidden', '');
      classConfirmElements.shell.setAttribute('aria-hidden', 'true');
    }
  };

  const resolveClassConfirm = (result) => {
    if (classConfirmResolver) {
      classConfirmResolver(Boolean(result));
      classConfirmResolver = null;
    }
    setClassConfirmVisibility(false);
  };

  const showClassConfirm = ({
    title = 'Confirmar acción',
    message = '¿Deseas continuar?',
    yesLabel = 'Sí',
    noLabel = 'No',
  } = {}) => {
    if (!classConfirmElements.shell) {
      const fallbackDecision = typeof window !== 'undefined' ? window.confirm(message) : false;
      return Promise.resolve(fallbackDecision);
    }

    if (classConfirmElements.title) {
      classConfirmElements.title.textContent = title;
    }
    if (classConfirmElements.message) {
      classConfirmElements.message.textContent = message;
    }
    if (classConfirmElements.yesButton) {
      classConfirmElements.yesButton.textContent = yesLabel;
    }
    if (classConfirmElements.noButton) {
      classConfirmElements.noButton.textContent = noLabel;
    }

    setClassConfirmVisibility(true);

    return new Promise((resolve) => {
      classConfirmResolver = resolve;
    });
  };

  const sendClassSignatureRequest = async (planId, claseIndex, { showSuccessMessage = true } = {}) => {
    if (!planId || Number.isNaN(claseIndex)) {
      return false;
    }
    try {
      const response = await api.requestClassSignature(planId, claseIndex);
      const updatedPlan = response?.data?.plan;
      if (updatedPlan) {
        renderResultado(updatedPlan);
      } else if (planMostradoId === planId) {
        await refreshPlanById(planId);
      }
      if (showSuccessMessage) {
        alert('Notificamos al tutor. Te avisaremos cuando confirme.');
      }
      return true;
    } catch (error) {
      alert(error.message);
      return false;
    }
  };

  const handleClassIndicatorSelection = async (planId, claseIndex) => {
    if (!planId || Number.isNaN(claseIndex)) {
      return;
    }

    if (!planDetalleActual || planDetalleActual.id !== planId) {
      await refreshPlanById(planId);
    }

    const plan = planDetalleActual && planDetalleActual.id === planId ? planDetalleActual : null;
    if (!plan) {
      return;
    }

    const clase = plan.clases?.[claseIndex];
    if (!clase) {
      return;
    }

    if (clase.firmaEstado === 'pendiente') {
      alert('Esta clase ya fue enviada al tutor. Espera su confirmación.');
      return;
    }

    if (clase.firmaEstado === 'firmada') {
      alert('Esta clase ya se encuentra firmada por el tutor.');
      return;
    }

    const message = clase.firmaEstado === 'rechazada'
      ? 'La clase fue rechazada anteriormente. ¿Deseas notificar nuevamente al tutor?'
      : 'Confirma que deseas enviar esta clase para ser firmada por el tutor.';

    const confirmed = await showClassConfirm({
      title: 'Enviar clase a firma',
      message,
      yesLabel: 'Sí',
      noLabel: 'No',
    });

    if (!confirmed) {
      return;
    }

    await sendClassSignatureRequest(planId, claseIndex);
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
    const previousView = activeView;
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

    activeView = resolvedView?.dataset.view || null;

    if (emptyView) {
      if (resolvedView) {
        hideSection(emptyView);
      } else {
        showSection(emptyView);
      }
    }

    if (previousView === "consulta" && activeView !== "consulta") {
      resetConsultaOnNextShow = true;
    }

    if (activeView === "consulta" && resetConsultaOnNextShow) {
      resetConsultaResultados({ clearInput: true });
      resetConsultaOnNextShow = false;
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
      resetConsultaResultados({
        message: "No se encontró un plan con los datos ingresados. Verifica el nombre o número.",
      });
      return;
    }

    const clasesMarkup = plan.clases
      .map((clase, index) => {
        const estadoTexto = getClaseEstadoLabel(clase);
        const estadoMarkup = estadoTexto
          ? `<span class="clase-estado ${getClaseEstadoClass(clase)}">${estadoTexto}</span>`
          : "";
        return `
        <li class="clase-item">
          <button type="button" class="clase-indicador ${clase.completada ? "is-completada" : ""}" data-plan-id="${plan.id}" data-clase-index="${index}" aria-pressed="${clase.completada}"></button>
          <div class="clase-detalle">
            <span>Clase ${clase.numero || index + 1}</span>
            ${estadoMarkup}
          </div>
        </li>`;
      })
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

    setPlanDetalleActual(plan);
    trackPlanPendingClasses(plan);
  };

  const construirClases = (cantidad) =>
    Array.from({ length: cantidad }, (_, index) => ({
      numero: index + 1,
      completada: false,
      firmaEstado: null,
      firmaPendienteId: null,
      firmaReintentos: 0,
    }));

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

  const calendarDayKeys = [
    "domingo",
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "viernes",
    "sabado",
  ];

  const normalizeDayKey = (value = "") =>
    value
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zñ]/g, "");

  const buildAgendaByDay = (plans = []) => {
    const agenda = calendarDayKeys.reduce((acc, key) => {
      acc[key] = [];
      return acc;
    }, {});

    plans.forEach((plan) => {
      const dias = Array.isArray(plan?.dias) ? plan.dias : [];
      const hora = typeof plan?.hora === "string" && plan.hora.trim().length ? plan.hora.trim() : "--:--";
      const nombre = plan?.nombre || "Alumno sin nombre";

      dias.forEach((dia) => {
        const normalizedKey = normalizeDayKey(dia);
        if (!agenda[normalizedKey]) {
          return;
        }
        agenda[normalizedKey].push({ id: plan.id, nombre, hora });
      });
    });

    Object.values(agenda).forEach((entries) => {
      entries.sort((a, b) => {
        const left = /^\d/.test(a.hora) ? a.hora : "99:99";
        const right = /^\d/.test(b.hora) ? b.hora : "99:99";
        const timeComparison = left.localeCompare(right);
        if (timeComparison !== 0) {
          return timeComparison;
        }
        return a.nombre.localeCompare(b.nombre);
      });
    });

    return agenda;
  };

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

  const renderWeekCalendar = (plans = scheduleState.planes || []) => {
    if (!weekGrid || !weekLabel || !weekRange) return;
    const { today, visibleDays } = getVisibleWeekDays();
    const monthName = monthNames[today.getMonth()];
    weekLabel.textContent = `Semana actual · ${monthName} ${TARGET_YEAR}`;

    if (!visibleDays.length) {
      weekRange.textContent = "Sin días de esta semana para mostrar";
      weekGrid.innerHTML = '<p class="empty-state">Aún no hay días transcurridos esta semana.</p>';
      return;
    }

    const agendaByDay = buildAgendaByDay(plans);

    const firstVisible = visibleDays[0];
    const lastVisible = visibleDays[visibleDays.length - 1];
    weekRange.textContent = `Del ${firstVisible.getDate()} al ${lastVisible.getDate()} de ${monthName}`;

    const markup = visibleDays
      .map((date) => {
        const isToday = date.getDate() === today.getDate();
        const status = isToday ? "Hoy" : "Día transcurrido";
        const dayKey = calendarDayKeys[date.getDay()];
        const dayAgenda = agendaByDay[dayKey] || [];
        const agendaMarkup = dayAgenda.length
          ? `<ul class="day-agenda">${dayAgenda
              .map(
                (item) => `
                  <li>
                    <span class="agenda-name">${item.nombre}</span>
                    <span class="agenda-time">${item.hora}</span>
                  </li>
                `
              )
              .join("")}
            </ul>`
          : '<p class="day-empty">Sin clases programadas</p>';

        return `
          <div class="day-card ${isToday ? "is-today" : ""}">
            <p class="day-name">${dayNames[date.getDay()]}</p>
            <span class="day-number">${date.getDate()}</span>
            <span class="day-status">${status}</span>
            ${agendaMarkup}
          </div>
        `;
      })
      .join("");

    weekGrid.innerHTML = markup;
  };

  async function refreshHorarioAgenda({ force = false } = {}) {
    if (!weekGrid || !api.listPlans) {
      return;
    }
    if (!isAuthenticated) {
      scheduleState.planes = [];
      scheduleState.lastFetchedAt = 0;
      renderWeekCalendar([]);
      return;
    }
    if (scheduleState.isLoading) {
      return;
    }
    const cacheIsFresh =
      !force &&
      scheduleState.planes.length &&
      scheduleState.lastFetchedAt &&
      Date.now() - scheduleState.lastFetchedAt < 60 * 1000;
    if (cacheIsFresh) {
      renderWeekCalendar(scheduleState.planes);
      return;
    }

    scheduleState.isLoading = true;
    weekGrid.innerHTML = '<p class="empty-state">Actualizando horario...</p>';

    try {
      const response = await api.listPlans();
      const planes = Array.isArray(response?.data) ? response.data : [];
      scheduleState.planes = planes;
      scheduleState.lastFetchedAt = Date.now();
      renderWeekCalendar(planes);
    } catch (error) {
      console.error("No se pudo cargar el horario", error);
      weekGrid.innerHTML = '<p class="empty-state">No se pudo cargar el horario. Inténtalo más tarde.</p>';
    } finally {
      scheduleState.isLoading = false;
    }
  }

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
        if (!pendingId) {
          throw new Error("No se pudo generar la solicitud pendiente. Inténtalo nuevamente.");
        }
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
    openHorarioButton.addEventListener("click", async () => {
      if (!isAuthenticated) {
        setAuthStatusMessage("Inicia sesión para visualizar el horario semanal.");
        return;
      }
      setActiveView("horario");
      setActiveNavButton(openHorarioButton);
      await refreshHorarioAgenda({ force: true });
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
            refreshHorarioAgenda({ force: true });
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

      const indexNumber = Number(claseIndex);
      handleClassIndicatorSelection(planId, indexNumber);
    });
  }

  if (classConfirmElements.yesButton) {
    classConfirmElements.yesButton.addEventListener("click", () => resolveClassConfirm(true));
  }

  if (classConfirmElements.noButton) {
    classConfirmElements.noButton.addEventListener("click", () => resolveClassConfirm(false));
  }

  if (classConfirmElements.shell) {
    classConfirmElements.shell.addEventListener("click", (event) => {
      if (event.target === classConfirmElements.shell) {
        resolveClassConfirm(false);
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (classConfirmElements.shell?.getAttribute("aria-hidden") === "false") {
      resolveClassConfirm(false);
    }
    if (classSignatureElements.shell?.getAttribute("aria-hidden") === "false") {
      dismissClassSignatureReview();
    }
    if (planReviewElements.shell?.getAttribute("aria-hidden") === "false") {
      dismissPlanReview();
    }
  });

  if (planReviewElements.acceptButton) {
    planReviewElements.acceptButton.addEventListener("click", () => handlePlanReviewDecision("accept"));
  }

  if (planReviewElements.rejectButton) {
    planReviewElements.rejectButton.addEventListener("click", () => handlePlanReviewDecision("reject"));
  }

  if (planReviewElements.closeButton) {
    planReviewElements.closeButton.addEventListener("click", dismissPlanReview);
  }

  if (planReviewElements.backdrop) {
    planReviewElements.backdrop.addEventListener("click", dismissPlanReview);
  }

  if (classSignatureElements.acceptButton) {
    classSignatureElements.acceptButton.addEventListener("click", handleClassSignatureAccept);
  }

  if (classSignatureElements.closeButton) {
    classSignatureElements.closeButton.addEventListener("click", dismissClassSignatureReview);
  }

  if (classSignatureElements.backdrop) {
    classSignatureElements.backdrop.addEventListener("click", dismissClassSignatureReview);
  }

  renderWeekCalendar();
  setActiveView();
  updateHorarioVisibility();

  const initialPendingId = getPendingIdFromQuery();
  if (initialPendingId) {
    openPlanReview(initialPendingId);
  }

  const initialClassPendingId = getClassPendingIdFromQuery();
  if (initialClassPendingId) {
    openClassSignatureReview(initialClassPendingId);
  }

  if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", async (event) => {
      const payload = event.data || {};
      const payloadPendingId = payload.payload?.pendingId || payload.pendingId;

      if (payload.type === "push-plan-open") {
        handleExternalPendingId(payloadPendingId);
        return;
      }

      if (payload.type === "class-signature-open") {
        handleExternalClassPendingId(payloadPendingId);
        return;
      }

      if (payload.type === "push-plan-action") {
        if (payload.decision === "accept") {
          alert("Confirmaste el plan desde la notificación. Gracias por tu respuesta.");
          if (isAuthenticated) {
            refreshHorarioAgenda({ force: true });
          }
        } else if (payload.decision === "reject") {
          alert("Registramos tu solicitud de ajustes. Nos pondremos en contacto.");
        }
        return;
      }

      if (payload.type === "class-signature-action") {
        const planId = payload.payload?.planId;
        const claseIndex = Number(payload.payload?.claseIndex);

        if (payloadPendingId && classSignatureReviewState.pendingId === payloadPendingId) {
          if (payload.decision === "accept") {
            setClassSignatureStatusMessage("Gracias, registramos tu firma.", "success");
            setTimeout(() => dismissClassSignatureReview(), 2000);
          } else if (payload.decision === "reject") {
            setClassSignatureStatusMessage("Rechazaste la clase desde la notificación.", "error");
          }
        }

        if (payload.decision === "accept" && isAuthenticated) {
          alert("Clase firmada por el tutor.");
        }

        if (payload.decision === "reject" && isAuthenticated) {
          const retry = await showClassConfirm({
            title: "Clase rechazada",
            message: "La clase fue rechazada. ¿Notificar de nuevo?",
            yesLabel: "Sí",
            noLabel: "No",
          });
          if (retry && planId && !Number.isNaN(claseIndex)) {
            await sendClassSignatureRequest(planId, claseIndex, { showSuccessMessage: false });
          } else {
            alert("La clase fue rechazada por el tutor.");
          }
        }

        if (planId) {
          refreshPlanById(planId);
        }
      }
    });
  }
});
