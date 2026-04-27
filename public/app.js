const stateLabels = {
  operational: "Operacional",
  degraded: "Degradado",
  outage: "Indisponivel",
};

const overallLabels = {
  "all-systems-operational": {
    title: "Todos os sistemas operacionais",
    description: "Os endpoints monitorados responderam dentro do esperado.",
    className: "state-operational",
  },
  "degraded-performance": {
    title: "Desempenho degradado",
    description: "Parte da plataforma respondeu, mas com falhas parciais ou latencia elevada.",
    className: "state-degraded",
  },
  "major-outage": {
    title: "Indisponibilidade relevante",
    description: "Ha um ou mais servicos sem resposta completa neste momento.",
    className: "state-outage",
  },
};

const refreshButton = document.querySelector("#refreshButton");
const autoRefreshToggle = document.querySelector("#autoRefreshToggle");
const serviceGrid = document.querySelector("#serviceGrid");
const summaryStrip = document.querySelector("#summaryStrip");
const filterPills = document.querySelector("#filterPills");
const template = document.querySelector("#serviceCardTemplate");
const alertFeed = document.querySelector("#alertFeed");
const alertsConfig = document.querySelector("#alertsConfig");

const overallStatus = document.querySelector("#overallStatus");
const overallLabel = document.querySelector("#overallLabel");
const overallDescription = document.querySelector("#overallDescription");
const lastUpdated = document.querySelector("#lastUpdated");
const historyWindow = document.querySelector("#historyWindow");

const viewState = {
  payload: null,
  category: "Todos",
  timerId: null,
};

function formatDate(dateString) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(dateString));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderSummary(payload) {
  const items = [
    { label: "Servicos ativos", value: payload.summary.operational },
    { label: "Degradados", value: payload.summary.degraded },
    { label: "Indisponiveis", value: payload.summary.outage },
    { label: "Latencia media", value: `${payload.summary.avgLatencyMs} ms` },
  ];

  summaryStrip.innerHTML = items
    .map(
      (item) => `
        <article class="summary-card">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>
      `,
    )
    .join("");
}

function renderAlerts(payload) {
  const config = payload.alerts;
  alertsConfig.innerHTML = `
    <div class="alert-config-card">
      <span>Webhook</span>
      <strong>${config.configured ? "Configurado" : "Nao configurado"}</strong>
    </div>
    <div class="alert-config-card">
      <span>Formato</span>
      <strong>${escapeHtml(config.webhookFormat)}</strong>
    </div>
    <div class="alert-config-card">
      <span>Ciclo do monitor</span>
      <strong>${config.monitorIntervalSeconds}s</strong>
    </div>
    <div class="alert-config-card">
      <span>Cooldown</span>
      <strong>${config.cooldownSeconds}s</strong>
    </div>
  `;

  if (!config.recent.length) {
    alertFeed.innerHTML = `
      <article class="alert-card alert-card-empty">
        <strong>Nenhum alerta recente</strong>
        <p>Quando um servico piorar ou recuperar, o evento aparece aqui e pode ser enviado para o webhook configurado.</p>
      </article>
    `;
    return;
  }

  alertFeed.innerHTML = config.recent
    .map((entry) => {
      const delivery = entry.delivery.sent
        ? `Enviado (${entry.delivery.statusCode ?? "-"})`
        : entry.delivery.reason;
      return `
        <article class="alert-card">
          <div class="alert-topline">
            <span class="state-pill state-${escapeHtml(entry.state)}">${escapeHtml(stateLabels[entry.state] || entry.state)}</span>
            <span class="alert-delivery">${escapeHtml(delivery)}</span>
          </div>
          <h3>${escapeHtml(entry.message)}</h3>
          <p>${escapeHtml(entry.serviceName)} • ${escapeHtml(entry.host)}</p>
          <div class="alert-meta">
            <span>${escapeHtml(formatDate(entry.checkedAt))}</span>
            <span>${escapeHtml(`${entry.latencyMs} ms`)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderFilters(payload) {
  const categories = ["Todos", ...new Set(payload.services.map((service) => service.category))];

  filterPills.innerHTML = categories
    .map((category) => {
      const isActive = category === viewState.category;
      return `<button type="button" data-category="${escapeHtml(category)}" class="${isActive ? "active" : ""}">${escapeHtml(category)}</button>`;
    })
    .join("");

  filterPills.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      viewState.category = button.dataset.category;
      renderFilters(payload);
      renderServices(payload);
    });
  });
}

function renderOverall(payload) {
  const definition = overallLabels[payload.overall] || overallLabels["degraded-performance"];
  overallStatus.className = `overall-status ${definition.className}`;
  overallLabel.textContent = definition.title;
  overallDescription.textContent = definition.description;
  lastUpdated.textContent = formatDate(payload.generatedAt);
  historyWindow.textContent = `${payload.monitoringWindow} verificacoes`;
}

function createHistory(history) {
  return history
    .slice()
    .reverse()
    .map((entry) => `<span class="history-segment fill-${escapeHtml(entry.state)}" title="${escapeHtml(`${formatDate(entry.checkedAt)} • ${stateLabels[entry.state]} • ${entry.latencyMs} ms`)}"></span>`)
    .join("");
}

function renderServices(payload) {
  const services =
    viewState.category === "Todos"
      ? payload.services
      : payload.services.filter((service) => service.category === viewState.category);

  serviceGrid.innerHTML = "";

  services.forEach((service) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.querySelector(".category-tag").textContent = service.category;

    const statePill = card.querySelector(".state-pill");
    statePill.textContent = stateLabels[service.state] || service.state;
    statePill.classList.add(`state-${service.state}`);

    card.querySelector(".service-name").textContent = service.name;
    card.querySelector(".service-description").textContent = service.description;
    card.querySelector(".latency-badge").textContent = `${service.latencyMs} ms`;
    card.querySelector(".host").textContent = service.host;
    card.querySelector(".ip").textContent = service.ip || "-";

    const dnsValue = service.dns.ok
      ? `${service.dns.latencyMs} ms • ${service.dns.addresses.join(", ")}`
      : `Falhou • ${service.dns.error}`;
    card.querySelector(".dns").textContent = dnsValue;

    const probeValue = service.probe.ok
      ? `${service.probe.latencyMs} ms • ${service.probe.detail}`
      : `Falhou • ${service.probe.detail}`;
    card.querySelector(".probe").textContent = probeValue;

    card.querySelector(".checked-at").textContent = formatDate(service.checkedAt);
    card.querySelector(".history-bar").innerHTML = createHistory(service.history);

    serviceGrid.appendChild(card);
  });
}

async function loadStatus() {
  refreshButton.disabled = true;
  refreshButton.textContent = "Atualizando...";

  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Falha na API: ${response.status}`);
    }

    const payload = await response.json();
    viewState.payload = payload;

    renderOverall(payload);
    renderSummary(payload);
    renderAlerts(payload);
    renderFilters(payload);
    renderServices(payload);
  } catch (error) {
    overallStatus.className = "overall-status state-outage";
    overallLabel.textContent = "Falha ao consultar o backend";
    overallDescription.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Atualizar agora";
  }
}

function syncAutoRefresh() {
  if (viewState.timerId) {
    window.clearInterval(viewState.timerId);
    viewState.timerId = null;
  }

  if (autoRefreshToggle.checked) {
    viewState.timerId = window.setInterval(loadStatus, 15000);
  }
}

refreshButton.addEventListener("click", loadStatus);
autoRefreshToggle.addEventListener("change", syncAutoRefresh);

loadStatus();
syncAutoRefresh();
