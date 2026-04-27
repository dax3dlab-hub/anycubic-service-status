param(
    [int]$Port = 8181
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$publicDir = Join-Path $root "public"

Add-Type -AssemblyName System.Net.Http

$services = @(
    @{
        id = "anycubic-main"
        name = "Site Principal Anycubic"
        category = "Portal"
        host = "anycubic.com"
        ip = "104.18.10.183"
        type = "https"
        url = "https://anycubic.com/"
        expectedStatus = @(200, 301, 302, 307, 308, 403)
        description = "Portal principal da marca e ponto de entrada do ecossistema."
    },
    @{
        id = "anycubic-web"
        name = "Website Global"
        category = "Portal"
        host = "www.anycubic.com"
        ip = "104.18.11.183"
        type = "https"
        url = "https://www.anycubic.com/en/"
        expectedStatus = @(200, 301, 302, 307, 308, 403)
        description = "Frontend web principal usado por visitantes e clientes."
    },
    @{
        id = "anycubic-cloud"
        name = "Nuvem / Login"
        category = "Conta"
        host = "cloud-universe.anycubic.com"
        ip = "18.119.31.174"
        type = "https"
        url = "https://cloud-universe.anycubic.com/"
        expectedStatus = @(200, 301, 302, 307, 308, 401, 403)
        description = "Autenticacao, sessao e servicos em nuvem do app."
    },
    @{
        id = "anycubic-mqtt"
        name = "Comunicacao da Impressora (MQTT)"
        category = "IoT"
        host = "mqtt-universe.anycubic.com"
        ip = "172.65.173.145"
        type = "tcp"
        port = 8883
        description = "Broker MQTT usado para comunicacao entre impressoras e nuvem."
    },
    @{
        id = "makeronline-main"
        name = "Plataforma Web Makeronline"
        category = "Comunidade"
        host = "www.makeronline.com"
        ip = "104.18.27.143"
        type = "https"
        url = "https://www.makeronline.com/"
        expectedStatus = @(200, 301, 302, 307, 308, 403)
        description = "Portal web publico da comunidade Makeronline."
    },
    @{
        id = "makeronline-root"
        name = "Makeronline Root"
        category = "Comunidade"
        host = "makeronline.com"
        ip = "104.18.26.143"
        type = "https"
        url = "https://makeronline.com/"
        expectedStatus = @(200, 301, 302, 307, 308, 403)
        description = "Dominio raiz da plataforma, usado em redirecionamentos e acesso direto."
    }
)

$historyDepth = 24
$checkHistory = @{}
$httpClient = [System.Net.Http.HttpClient]::new()
$httpClient.Timeout = [TimeSpan]::FromSeconds(6)
$serverStart = Get-Date

function ConvertTo-JsonBytes {
    param([object]$Value)
    $json = $Value | ConvertTo-Json -Depth 8
    return [System.Text.Encoding]::UTF8.GetBytes($json)
}

function Resolve-ServiceDns {
    param([hashtable]$Service)

    $dnsWatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $addresses = [System.Net.Dns]::GetHostAddresses($Service.host)
        $dnsWatch.Stop()
        $addressStrings = @($addresses | ForEach-Object { $_.IPAddressToString } | Select-Object -Unique)
        return @{
            ok = $true
            latencyMs = [Math]::Round($dnsWatch.Elapsed.TotalMilliseconds, 0)
            addresses = $addressStrings
        }
    }
    catch {
        $dnsWatch.Stop()
        return @{
            ok = $false
            latencyMs = [Math]::Round($dnsWatch.Elapsed.TotalMilliseconds, 0)
            addresses = @()
            error = $_.Exception.Message
        }
    }
}

function Invoke-HttpsProbe {
    param([hashtable]$Service)

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, $Service.url)
        $response = $httpClient.Send($request)
        $watch.Stop()
        $statusCode = [int]$response.StatusCode
        $ok = $Service.expectedStatus -contains $statusCode
        return @{
            ok = $ok
            latencyMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 0)
            detail = "HTTP $statusCode"
            statusCode = $statusCode
        }
    }
    catch {
        $watch.Stop()
        try {
            $fallbackRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Service.url)
            $fallbackResponse = $httpClient.Send($fallbackRequest)
            $statusCode = [int]$fallbackResponse.StatusCode
            $ok = $Service.expectedStatus -contains $statusCode
            return @{
                ok = $ok
                latencyMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 0)
                detail = "GET fallback HTTP $statusCode"
                statusCode = $statusCode
            }
        }
        catch {
            return @{
                ok = $false
                latencyMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 0)
                detail = $_.Exception.Message
            }
        }
    }
}

function Invoke-TcpProbe {
    param([hashtable]$Service)

    $client = [System.Net.Sockets.TcpClient]::new()
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $asyncResult = $client.BeginConnect($Service.host, [int]$Service.port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(6000)) {
            throw "Timeout ao conectar na porta $($Service.port)."
        }
        $client.EndConnect($asyncResult)
        $watch.Stop()
        return @{
            ok = $true
            latencyMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 0)
            detail = "TCP $($Service.port) aceitou conexao"
        }
    }
    catch {
        $watch.Stop()
        return @{
            ok = $false
            latencyMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 0)
            detail = $_.Exception.Message
        }
    }
    finally {
        $client.Dispose()
    }
}

function Get-ServiceSnapshot {
    param([hashtable]$Service)

    $checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    $dnsResult = Resolve-ServiceDns -Service $Service
    $probeResult = if ($Service.type -eq "tcp") {
        Invoke-TcpProbe -Service $Service
    }
    else {
        Invoke-HttpsProbe -Service $Service
    }

    $state = if ($dnsResult.ok -and $probeResult.ok) {
        "operational"
    }
    elseif ($dnsResult.ok -or $probeResult.ok) {
        "degraded"
    }
    else {
        "outage"
    }

    $latency = if ($probeResult.latencyMs -gt 0) { $probeResult.latencyMs } else { $dnsResult.latencyMs }

    $entry = @{
        id = $Service.id
        name = $Service.name
        category = $Service.category
        description = $Service.description
        host = $Service.host
        ip = $Service.ip
        type = $Service.type
        port = $Service.port
        checkedAt = $checkedAt
        state = $state
        latencyMs = $latency
        dns = $dnsResult
        probe = $probeResult
    }

    if (-not $checkHistory.ContainsKey($Service.id)) {
        $checkHistory[$Service.id] = New-Object System.Collections.ArrayList
    }

    $historyItem = @{
        checkedAt = $checkedAt
        state = $state
        latencyMs = $latency
    }

    [void]$checkHistory[$Service.id].Insert(0, $historyItem)
    while ($checkHistory[$Service.id].Count -gt $historyDepth) {
        $checkHistory[$Service.id].RemoveAt($checkHistory[$Service.id].Count - 1)
    }

    $entry.history = @($checkHistory[$Service.id])
    return $entry
}

function Get-StatusPayload {
    $serviceSnapshots = @($services | ForEach-Object { Get-ServiceSnapshot -Service $_ })
    $operational = @($serviceSnapshots | Where-Object { $_.state -eq "operational" }).Count
    $degraded = @($serviceSnapshots | Where-Object { $_.state -eq "degraded" }).Count
    $outage = @($serviceSnapshots | Where-Object { $_.state -eq "outage" }).Count

    $overall = if ($outage -gt 0) {
        "major-outage"
    }
    elseif ($degraded -gt 0) {
        "degraded-performance"
    }
    else {
        "all-systems-operational"
    }

    $avgLatency = 0
    if ($serviceSnapshots.Count -gt 0) {
        $avgLatency = [Math]::Round((($serviceSnapshots | Measure-Object -Property latencyMs -Average).Average), 0)
    }

    return @{
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        monitoringWindow = $historyDepth
        overall = $overall
        services = $serviceSnapshots
        summary = @{
            total = $serviceSnapshots.Count
            operational = $operational
            degraded = $degraded
            outage = $outage
            avgLatencyMs = $avgLatency
            uptimeSeconds = [Math]::Round(((Get-Date) - $serverStart).TotalSeconds, 0)
        }
    }
}

function Send-BytesResponse {
    param(
        [System.IO.Stream]$Stream,
        [byte[]]$Bytes,
        [string]$ContentType,
        [int]$StatusCode = 200,
        [string]$StatusText = "OK"
    )

    $headerText = "HTTP/1.1 $StatusCode $StatusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush()
}

function Send-TextResponse {
    param(
        [System.IO.Stream]$Stream,
        [string]$Text,
        [string]$ContentType,
        [int]$StatusCode = 200,
        [string]$StatusText = "OK"
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    Send-BytesResponse -Stream $Stream -Bytes $bytes -ContentType $ContentType -StatusCode $StatusCode -StatusText $StatusText
}

function Get-ContentType {
    param([string]$Path)

    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { "text/html; charset=utf-8" }
        ".css" { "text/css; charset=utf-8" }
        ".js" { "application/javascript; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".svg" { "image/svg+xml" }
        default { "application/octet-stream" }
    }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host "Status page running at http://localhost:$Port"

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()

        try {
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
            $requestLine = $reader.ReadLine()

            if ([string]::IsNullOrWhiteSpace($requestLine)) {
                throw "Linha de requisicao vazia."
            }

            while ($true) {
                $headerLine = $reader.ReadLine()
                if ([string]::IsNullOrEmpty($headerLine)) {
                    break
                }
            }

            $parts = $requestLine.Split(" ")
            if ($parts.Count -lt 2) {
                throw "Linha de requisicao invalida: $requestLine"
            }

            $rawPath = $parts[1]
            $path = $rawPath.Split("?")[0]

            if ($path -eq "/api/status") {
                $payload = Get-StatusPayload
                $bytes = ConvertTo-JsonBytes -Value $payload
                Send-BytesResponse -Stream $stream -Bytes $bytes -ContentType "application/json; charset=utf-8"
                continue
            }

            if ($path -eq "/" -or [string]::IsNullOrWhiteSpace($path)) {
                $filePath = Join-Path $publicDir "index.html"
            }
            else {
                $relativePath = $path.TrimStart("/") -replace "/", "\"
                $filePath = Join-Path $publicDir $relativePath
            }

            if ((Test-Path $filePath) -and -not (Get-Item $filePath).PSIsContainer) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $contentType = Get-ContentType -Path $filePath
                Send-BytesResponse -Stream $stream -Bytes $bytes -ContentType $contentType
            }
            else {
                Send-TextResponse -Stream $stream -Text "Not found" -ContentType "text/plain; charset=utf-8" -StatusCode 404 -StatusText "Not Found"
            }
        }
        catch {
            try {
                Send-TextResponse -Stream $stream -Text $_.Exception.Message -ContentType "text/plain; charset=utf-8" -StatusCode 500 -StatusText "Internal Server Error"
            }
            catch {
            }
        }
        finally {
            $stream.Dispose()
            $client.Dispose()
        }
    }
}
finally {
    $listener.Stop()
    $httpClient.Dispose()
}
