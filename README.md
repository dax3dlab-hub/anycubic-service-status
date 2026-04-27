# Anycubic Service Status

Painel web local para monitorar os principais servicos Anycubic e Makeronline em tempo real.

## Como abrir localmente

Execute no PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-status-page.ps1
```

Depois abra:

`http://127.0.0.1:8181`

## Como publicar na internet

### Render

1. Suba esta pasta para um repositorio no GitHub.
2. No Render, crie um `Web Service` conectado a esse repositorio.
3. Use `npm start` como comando de inicializacao.
4. Garanta que a plataforma exponha a variavel `PORT`.
5. A aplicacao respondera em `/` e o healthcheck em `/health`.

#### Variaveis para alertas externos

Configure no painel do Render:

- `ALERT_WEBHOOK_URL`: URL do webhook que recebera os incidentes
- `ALERT_WEBHOOK_FORMAT`: `generic`, `slack`, `discord` ou `ntfy`
- `ALERT_MINIMUM_STATE`: `degraded` ou `outage`
- `ALERT_COOLDOWN_SECONDS`: intervalo minimo entre alertas repetidos do mesmo servico
- `MONITOR_INTERVAL_MS`: intervalo entre verificacoes do monitor em background

Com isso, o monitor passa a rodar sozinho no servidor e envia notificacoes quando um servico piora ou quando se recupera.

O projeto ja inclui [`render.yaml`](C:/Users/Aline/Documents/Codex/2026-04-27/criar-uma-p-gina-de-status/render.yaml) e [`package.json`](C:/Users/Aline/Documents/Codex/2026-04-27/criar-uma-p-gina-de-status/package.json), entao o deploy fica direto.

### Railway

1. Importe o repositorio no Railway.
2. Deixe o start command como `npm start`.
3. A plataforma injeta a porta automaticamente; o servidor ja esta pronto para isso.

## O que a pagina monitora

- Website principal da Anycubic
- Dominio global `www.anycubic.com`
- Nuvem/Login `cloud-universe.anycubic.com`
- Broker MQTT `mqtt-universe.anycubic.com:8883`
- Plataforma web `www.makeronline.com`
- Dominio raiz `makeronline.com`

## Como funciona

- Backend local em Node.js servindo a interface e a API `/api/status`
- Endpoint de healthcheck em `/health`
- Monitor em background independente de visitantes
- Verificacoes periodicas de DNS, HTTPS e TCP
- Webhook externo para incidentes e recuperacoes
- Historico curto por servico para visualizar degradacao e quedas
- Filtros por categoria, refresh manual e auto-refresh
