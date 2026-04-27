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
const serverStart = Date.now();
const checkHistory = new Map();

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

function toMs(start) {
  return Math.max(0, Math.round(performance.now() - start));
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
        detail: error.message,
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
        detail: error.message,
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

async function getStatusPayload() {
  const snapshots = await Promise.all(services.map(getServiceSnapshot));
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/health") {
    sendJson(response, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - serverStart) / 1000),
      serviceCount: services.length,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/api/status") {
    try {
      const payload = await getStatusPayload();
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
