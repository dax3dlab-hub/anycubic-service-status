const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");

const port = Number(process.env.PORT || 8181);
const host = process.env.HOST || "0.0.0.0";
const publicDir = path.join(__dirname, "public");
const historyDepth = 24;
const alertFeedDepth = 20;
const monitorIntervalMs = Number(process.env.MONITOR_INTERVAL_MS || 60000);
const serverStart = Date.now();
const checkHistory = new Map();
const serviceState = new Map();
const lastAlertAt = new Map();
const alertFeed = [];

const alertConfig = {
  webhookUrl: process.env.ALERT_WEBHOOK_URL || "",
  webhookFormat: (process.env.ALERT_WEBHOOK_FORMAT || "generic").toLowerCase(),
  cooldownMs: Number(process.env.ALERT_COOLDOWN_SECONDS || 900) * 1000,
  minimumState: process.env.ALERT_MINIMUM_STATE || "degraded",
};

const severityRank = {
  operational: 0,
  degraded: 1,
  outage: 2,
};

const services = [
  {
    id: "anycubic-main",
    name: "Site Principal Anycubic",
    category: "Portal",
    host: "anycubic.com",
    ip: "104.18.10.183",
    type: "https",
    url: "https://anycubic.com/",
    expectedStatus: [200, 301, 302, 307, 308, 403],
    description: "Portal principal da marca e ponto de entrada do ecossistema.",
  },
  {
    id: "anycubic-web",
    name: "Website Global",
    category: "Portal",
    host: "www.anycubic.com",
    ip: "104.18.11.183",
    type: "https",
    url: "https://www.anycubic.com/en/",
    expectedStatus: [200, 301, 302, 307, 308, 403],
    description: "Frontend web principal usado por visitantes e clientes.",
  },
  {
    id: "anycubic-cloud",
    name: "Nuvem / Login",
    category: "Conta",
    host: "cloud-universe.anycubic.com",
    ip: "18.119.31.174",
    type: "https",
    url: "https://cloud-universe.anycubic.com/",
    expectedStatus: [200, 301, 302, 307, 308, 401, 403],
    description: "Autenticacao, sessao e servicos em nuvem do app.",
  },
  {
    id: "anycubic-mqtt",
    name: "Comunicacao da Impressora (MQTT)",
    category: "IoT",
    host: "mqtt-universe.anycubic.com",
    ip: "172.65.173.145",
    type: "tcp",
    port: 8883,
    description: "Broker MQTT usado para comunicacao entre impressoras e nuvem.",
  },
  {
    id: "makeronline-main",
    name: "Plataforma Web Makeronline",
    category: "Comunidade",
    host: "www.makeronline.com",
    ip: "104.18.27.143",
    type: "https",
    url: "https://www.makeronline.com/",
    expectedStatus: [200, 301, 302, 307, 308, 403],
    description: "Portal web publico da comunidade Makeronline.",
  },
  {
    id: "makeronline-root",
    name: "Makeronline Root",
    category: "Comunidade",
    host: "makeronline.com",
    ip: "104.18.26.143",
    type: "https",
    url: "https://makeronline.com/",
    expectedStatus: [200, 301, 302, 307, 308, 403],
    description: "Dominio raiz da plataforma, usado em redirecionamentos e acesso direto.",
  },
];

let latestPayload = null;
let monitorInFlight = null;

function toMs(start) {
  return Math.max(0, Math.round(performance.now() - start));
}

function addAlertFeedEntry(entry) {
  alertFeed.unshift(entry);
  if (alertFeed.length > alertFeedDepth) {
    alertFeed.length = alertFeedDepth;
  }
}

function shouldAlertForState(state) {
  return severityRank[state] >= severityRank[alertConfig.minimumState];
}

function makeAlertTitle(snapshot, nextState, previousState) {
  if (nextState === "operational") {
    return `${snapshot.name} recuperou`;
  }
  if (!previousState || previousState === "operational") {
    return `${snapshot.name} entrou em alerta`;
  }
  return `${snapshot.name} mudou para ${nextState}`;
}

function makeAlertText(snapshot, nextState, previousState) {
  const details = snapshot.type === "tcp" ? snapshot.probe.detail : `${snapshot.probe.detail} | DNS ${snapshot.dns.latencyMs} ms`;
  return [
    `${makeAlertTitle(snapshot, nextState, previousState)}`,
    `Estado anterior: ${previousState || "desconhecido"}`,
    `Estado atual: ${nextState}`,
    `Host: ${snapshot.host}`,
    `Latencia: ${snapshot.latencyMs} ms`,
    `Detalhes: ${details}`,
    `Horario: ${snapshot.checkedAt}`,
  ].join("\n");
}

function buildWebhookRequest(snapshot, nextState, previousState) {
  const text = makeAlertText(snapshot, nextState, previousState);
  const title = makeAlertTitle(snapshot, nextState, previousState);
  const payload = {
    service: snapshot.name,
    serviceId: snapshot.id,
    host: snapshot.host,
    category: snapshot.category,
    state: nextState,
    previousState: previousState || null,
    latencyMs: snapshot.latencyMs,
    checkedAt: snapshot.checkedAt,
    details: {
      dns: snapshot.dns,
      probe: snapshot.probe,
    },
    text,
    title,
  };

  switch (alertConfig.webhookFormat) {
    case "discord":
      return {
        body: JSON.stringify({
          content: `**${title}**\n${text}`,
        }),
        headers: { "Content-Type": "application/json" },
      };
    case "slack":
      return {
        body: JSON.stringify({
          text: `*${title}*\n${text}`,
        }),
        headers: { "Content-Type": "application/json" },
      };
    case "ntfy":
      return {
        body: text,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Title: title,
          Priority: nextState === "outage" ? "urgent" : "default",
        },
      };
    default:
      return {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      };
  }
}

function postWebhook(url, requestBody, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Length": Buffer.byteLength(requestBody),
          ...headers,
        },
        timeout: 10000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode || 0);
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("Timeout ao enviar webhook."));
    });
    request.on("error", reject);
    request.write(requestBody);
    request.end();
  });
}

async function sendExternalAlert(snapshot, nextState, previousState) {
  if (!alertConfig.webhookUrl) {
    return { sent: false, reason: "webhook-disabled" };
  }

  const lastSentAt = lastAlertAt.get(snapshot.id) || 0;
  if (Date.now() - lastSentAt < alertConfig.cooldownMs && nextState !== "operational") {
    return { sent: false, reason: "cooldown-active" };
  }

  const request = buildWebhookRequest(snapshot, nextState, previousState);
  const statusCode = await postWebhook(alertConfig.webhookUrl, request.body, request.headers);
  lastAlertAt.set(snapshot.id, Date.now());
  return { sent: true, statusCode };
}

async function evaluateAlerts(snapshots) {
  for (const snapshot of snapshots) {
    const previousState = serviceState.get(snapshot.id);
    const nextState = snapshot.state;
    const changed = previousState && previousState !== nextState;
    const firstDetection = !previousState && shouldAlertForState(nextState);
    const recovered = previousState && previousState !== "operational" && nextState === "operational";
    const worsened = changed && shouldAlertForState(nextState);

    serviceState.set(snapshot.id, nextState);

    if (!firstDetection && !recovered && !worsened) {
      continue;
    }

    const eventType = nextState === "operational" ? "recovery" : "incident";
    const feedEntry = {
      id: `${snapshot.id}-${snapshot.checkedAt}-${eventType}`,
      serviceId: snapshot.id,
      serviceName: snapshot.name,
      state: nextState,
      previousState: previousState || null,
      eventType,
      checkedAt: snapshot.checkedAt,
      host: snapshot.host,
      latencyMs: snapshot.latencyMs,
      message: makeAlertTitle(snapshot, nextState, previousState),
      delivery: {
        configured: Boolean(alertConfig.webhookUrl),
        sent: false,
        statusCode: null,
        reason: alertConfig.webhookUrl ? "pending" : "webhook-disabled",
      },
    };

    try {
      if (recovered || shouldAlertForState(nextState)) {
        const delivery = await sendExternalAlert(snapshot, nextState, previousState);
        feedEntry.delivery = {
          configured: Boolean(alertConfig.webhookUrl),
          sent: delivery.sent,
          statusCode: delivery.statusCode || null,
          reason: delivery.reason || "sent",
        };
      }
    } catch (error) {
      feedEntry.delivery = {
        configured: Boolean(alertConfig.webhookUrl),
        sent: false,
        statusCode: null,
        reason: error.message,
      };
    }

    addAlertFeedEntry(feedEntry);
  }
}

async function resolveServiceDns(service) {
  const start = performance.now();
  try {
    const result = await dns.lookup(service.host, { all: true });
    return {
      ok: true,
      latencyMs: toMs(start),
      addresses: [...new Set(result.map((entry) => entry.address))],
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: toMs(start),
      addresses: [],
      error: error.message,
    };
  }
}

function probeHttps(service) {
  return new Promise((resolve) => {
    const start = performance.now();
    const request = https.request(
      service.url,
      {
        method: "HEAD",
        timeout: 6000,
      },
      (response) => {
        response.resume();
        resolve({
          ok: service.expectedStatus.includes(response.statusCode),
          latencyMs: toMs(start),
          detail: `HTTP ${response.statusCode}`,
          statusCode: response.statusCode,
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("Timeout na requisicao HTTPS."));
    });

    request.on("error", (error) => {
      resolve({
        ok: false,
        latencyMs: toMs(start),
        detail: error.message || "Falha na requisicao HTTPS.",
      });
    });

    request.end();
  });
}

function probeTcp(service) {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.createConnection(
      {
        host: service.host,
        port: service.port,
      },
      () => {
        socket.end();
        resolve({
          ok: true,
          latencyMs: toMs(start),
          detail: `TCP ${service.port} aceitou conexao`,
        });
      },
    );

    socket.setTimeout(6000);
    socket.on("timeout", () => {
      socket.destroy(new Error(`Timeout ao conectar na porta ${service.port}.`));
    });

    socket.on("error", (error) => {
      resolve({
        ok: false,
        latencyMs: toMs(start),
        detail: error.message || "Falha na conexao TCP.",
      });
    });
  });
}

async function getServiceSnapshot(service) {
  const checkedAt = new Date().toISOString();
  const dnsResult = await resolveServiceDns(service);
  const probeResult = service.type === "tcp" ? await probeTcp(service) : await probeHttps(service);
  const state = dnsResult.ok && probeResult.ok ? "operational" : dnsResult.ok || probeResult.ok ? "degraded" : "outage";
  const latencyMs = probeResult.latencyMs || dnsResult.latencyMs;

  const history = checkHistory.get(service.id) || [];
  history.unshift({ checkedAt, state, latencyMs });
  if (history.length > historyDepth) {
    history.length = historyDepth;
  }
  checkHistory.set(service.id, history);

  return {
    ...service,
    checkedAt,
    state,
    latencyMs,
    dns: dnsResult,
    probe: probeResult,
    history,
  };
}

function buildPayload(snapshots) {
  const operational = snapshots.filter((item) => item.state === "operational").length;
  const degraded = snapshots.filter((item) => item.state === "degraded").length;
  const outage = snapshots.filter((item) => item.state === "outage").length;
  const overall = outage > 0 ? "major-outage" : degraded > 0 ? "degraded-performance" : "all-systems-operational";
  const avgLatencyMs = snapshots.length
    ? Math.round(snapshots.reduce((sum, item) => sum + item.latencyMs, 0) / snapshots.length)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    monitoringWindow: historyDepth,
    overall,
    services: snapshots,
    alerts: {
      configured: Boolean(alertConfig.webhookUrl),
      webhookFormat: alertConfig.webhookFormat,
      minimumState: alertConfig.minimumState,
      cooldownSeconds: Math.round(alertConfig.cooldownMs / 1000),
      monitorIntervalSeconds: Math.round(monitorIntervalMs / 1000),
      recent: alertFeed,
    },
    summary: {
      total: snapshots.length,
      operational,
      degraded,
      outage,
      avgLatencyMs,
      uptimeSeconds: Math.round((Date.now() - serverStart) / 1000),
    },
  };
}

async function runMonitorCycle() {
  if (monitorInFlight) {
    return monitorInFlight;
  }

  monitorInFlight = (async () => {
    const snapshots = await Promise.all(services.map(getServiceSnapshot));
    await evaluateAlerts(snapshots);
    latestPayload = buildPayload(snapshots);
    return latestPayload;
  })();

  try {
    return await monitorInFlight;
  } finally {
    monitorInFlight = null;
  }
}

function scheduleMonitoring() {
  void runMonitorCycle().catch((error) => {
    console.error("Initial monitor cycle failed:", error.message);
  });

  setInterval(() => {
    void runMonitorCycle().catch((error) => {
      console.error("Monitor cycle failed:", error.message);
    });
  }, monitorIntervalMs);
}

function getContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function sendJson(response, payload) {
  const json = JSON.stringify(payload);
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(json);
}

function sendFile(response, filePath) {
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store",
    });
    response.end(buffer);
  });
}

scheduleMonitoring();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/health") {
    sendJson(response, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - serverStart) / 1000),
      serviceCount: services.length,
      timestamp: new Date().toISOString(),
      alertsConfigured: Boolean(alertConfig.webhookUrl),
    });
    return;
  }

  if (url.pathname === "/api/status") {
    try {
      const payload = latestPayload || (await runMonitorCycle());
      sendJson(response, payload);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(publicDir, relativePath));
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  sendFile(response, filePath);
});

server.listen(port, host, () => {
  console.log(`Status page running at http://${host}:${port}`);
});
