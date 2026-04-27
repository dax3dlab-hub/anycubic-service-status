param(
    [int]$Port = 8181
)

$node = "C:\Users\Aline\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path $node)) {
    throw "Node runtime empacotado nao encontrado em $node"
}

$env:PORT = "$Port"
& $node (Join-Path $PSScriptRoot "server.js")
