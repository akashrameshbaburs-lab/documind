<#
.SYNOPSIS
    DocuMind AI - end-to-end demo / smoke test.

.DESCRIPTION
    Drives the real HTTP API against a running stack and proves, in order:
      1. health + readiness
      2. register + login (JWT)
      3. upload the evaluation PDF + Markdown (private document set)
      4. ask a question -> non-empty answer, citations with page numbers, answerMode
      5. ask the same question again -> cached = true
      6. thumbs feedback
      7. usage counter
      8. cross-user access to another user's set is rejected (401/403)
      9. admin feedback aggregation

.NOTES
    Windows PowerShell 5.1 compatible.

    HTTP is performed with `Invoke-WebRequest -UseBasicParsing` rather than
    `curl`. Two reasons:
      (a) plain `curl` in PowerShell is an alias for Invoke-WebRequest and
          behaves differently, and
      (b) array-splatting a JSON body into `curl.exe` in Windows PowerShell 5.1
          strips the quotes from `key: value`-looking strings, corrupting the
          payload. Invoke-WebRequest passes the body intact and surfaces the real
          HTTP status code, including for 4xx/5xx responses.

    Requires: docker compose up --build -d   (stack healthy on $BaseUrl)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "http://localhost:3200",
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http | Out-Null
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:PassCount = 0

function Write-Head($text) {
    Write-Host ""
    Write-Host ("=" * 74) -ForegroundColor DarkGray
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host ("=" * 74) -ForegroundColor DarkGray
}
function Write-Ok($text)   { Write-Host "  [PASS] $text" -ForegroundColor Green; $script:PassCount++ }
function Write-Bad($text)  { Write-Host "  [FAIL] $text" -ForegroundColor Red; $script:Failures.Add($text) }
function Write-Info($text) { Write-Host "  [info] $text" -ForegroundColor Yellow }

function Assert($condition, $message) {
    if ($condition) { Write-Ok $message } else { Write-Bad $message }
}

function Convert-Json($text) {
    if (-not $text) { return $null }
    try { return $text | ConvertFrom-Json } catch { return $null }
}

<#
 .SYNOPSIS Core HTTP helper.
 .OUTPUTS  @{ Status = <int>; Body = <string as JSON>; Json = <object|null> }
 .NOTES    Returns the real status code for error responses instead of throwing.
#>
function Invoke-Api {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Token = "",
        [string]$Json = "",
        [object]$Form = $null
    )

    $uri = "$BaseUrl$Path"
    $headers = @{}
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }

    # Multipart upload: build the body manually so we can send the SAME field
    # name ("files") multiple times, which .NET's MultipartFormDataContent
    # supports natively.
    if ($Form) {
        $client = New-Object System.Net.Http.HttpClient
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $content = New-Object System.Net.Http.MultipartFormDataContent
        if ($Form.ContainsKey("name")) {
            $content.Add((New-Object System.Net.Http.StringContent([string]$Form["name"])), "name")
        }
        foreach ($filePath in $Form["files"]) {
            $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
            $fileContent = New-Object System.Net.Http.ByteArrayContent($fileBytes, 0, $fileBytes.Length)
            $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/octet-stream")
            $content.Add($fileContent, "files", [System.IO.Path]::GetFileName($filePath))
        }
        $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($Method), $uri)
        $req.Content = $content
        if ($Token) { $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $Token) }
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $client.Dispose()
        $status = [int]$resp.StatusCode
        return @{ Status = $status; Body = $body; Json = (Convert-Json $body) }
    }

    # JSON / plain requests.
    $params = @{
        Uri             = $uri
        Method          = $Method
        UseBasicParsing = $true
        TimeoutSec      = $TimeoutSec
    }
    if ($headers.Count -gt 0) { $params["Headers"] = $headers }
    if ($Json) {
        $params["ContentType"] = "application/json"
        $params["Body"] = $Json
    }

    try {
        $response = Invoke-WebRequest @params
        $body = $response.Content
        return @{ Status = [int]$response.StatusCode; Body = $body; Json = (Convert-Json $body) }
    } catch {
        $webResponse = $_.Exception.Response
        if ($null -eq $webResponse) { throw }
        $statusCode = [int]$webResponse.StatusCode
        $stream = $webResponse.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        $reader.Dispose()
        return @{ Status = $statusCode; Body = $body; Json = (Convert-Json $body) }
    }
}

function New-CredentialBody([string]$email, [string]$password) {
    # Compact JSON built by hand: deterministic and quote-safe.
    return "{`"email`":`"$email`",`"password`":`"$password`"}"
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$userA = "demo-a-$stamp@documind.local"
$userB = "demo-b-$stamp@documind.local"
$password = "demo-password-123"
$pdfPath = Join-Path $PSScriptRoot "..\eval\docs\world-facts.pdf"
$mdPath  = Join-Path $PSScriptRoot "..\eval\docs\field-notes.md"

Write-Host ""
Write-Host "  DocuMind AI - end-to-end demo" -ForegroundColor White
Write-Host "  target: $BaseUrl" -ForegroundColor DarkGray
Write-Host "  user A: $userA" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
Write-Head "1. Health & readiness"
$health = Invoke-Api -Method GET -Path "/healthz"
Assert ($health.Status -eq 200) "GET /healthz -> 200 (got $($health.Status))"
$ready = Invoke-Api -Method GET -Path "/readyz"
Assert ($ready.Status -eq 200) "GET /readyz -> 200, database reachable (got $($ready.Status))"
$cfg = Invoke-Api -Method GET -Path "/api/config"
if ($cfg.Json) {
    Write-Info "runtime mode: $($cfg.Json.answerMode) / embeddings: $($cfg.Json.embeddingProvider) / limit: $($cfg.Json.maxQueriesPerDay) queries/day"
}

# ---------------------------------------------------------------------------
Write-Head "2. Register + login"
$regA = Invoke-Api -Method POST -Path "/api/register" -Json (New-CredentialBody $userA $password)
Assert ($regA.Status -eq 201) "POST /api/register -> 201 (got $($regA.Status))"

$loginA = Invoke-Api -Method POST -Path "/api/login" -Json (New-CredentialBody $userA $password)
Assert ($loginA.Status -eq 200 -and $loginA.Json.token) "POST /api/login -> 200 with JWT"
$tokenA = $loginA.Json.token

$dup = Invoke-Api -Method POST -Path "/api/register" -Json (New-CredentialBody $userA $password)
Assert ($dup.Status -eq 409) "duplicate register -> 409 (got $($dup.Status))"

$badLogin = Invoke-Api -Method POST -Path "/api/login" -Json (New-CredentialBody $userA "wrong-password")
Assert ($badLogin.Status -eq 401) "POST /api/login with wrong password -> 401 (got $($badLogin.Status))"

$noToken = Invoke-Api -Method GET -Path "/api/sets"
Assert ($noToken.Status -eq 401) "GET /api/sets without token -> 401 (got $($noToken.Status))"

$badToken = Invoke-Api -Method GET -Path "/api/sets" -Token "not-a-real-token"
Assert ($badToken.Status -eq 401) "GET /api/sets with a garbage token -> 401 (got $($badToken.Status))"

# ---------------------------------------------------------------------------
Write-Head "3. Upload documents (private set)"
if (-not (Test-Path $pdfPath)) { Write-Bad "missing fixture $pdfPath (run: npm run generate-samples)"; exit 1 }
if (-not (Test-Path $mdPath))  { Write-Bad "missing fixture $mdPath (run: npm run generate-samples)"; exit 1 }

$upload = Invoke-Api -Method POST -Path "/api/docs" -Token $tokenA -Form @{
    name  = "demo-set-$stamp"
    files = @($pdfPath, $mdPath)
}
Assert ($upload.Status -eq 201) "POST /api/docs -> 201 (got $($upload.Status))"
$setId = $upload.Json.setId
Assert ([bool]$setId) "response contains setId"
$fileCount = @($upload.Json.files).Count
Assert ($fileCount -eq 2) "response lists 2 files (got $fileCount)"
foreach ($f in @($upload.Json.files)) { Write-Info "file: $($f.name) - $($f.pages) pages, $($f.chunks) chunks" }

$emptyUpload = Invoke-Api -Method POST -Path "/api/docs" -Token $tokenA -Form @{ name = "empty"; files = @() }
Assert ($emptyUpload.Status -eq 400) "upload with no files -> 400 (got $($emptyUpload.Status))"

$sets = Invoke-Api -Method GET -Path "/api/sets" -Token $tokenA
$ownSet = @($sets.Json.sets) | Where-Object { $_.id -eq $setId }
Assert ([bool]$ownSet) "GET /api/sets lists the new set for its owner ($(@($sets.Json.sets).Count) set(s))"

# ---------------------------------------------------------------------------
Write-Head "4. Ask a question"
$question = "How tall is Mount Everest and where is it located?"
$askBody = "{`"setId`":`"$setId`",`"question`":`"$question`"}"
$ask1 = Invoke-Api -Method POST -Path "/api/chat" -Token $tokenA -Json $askBody
Assert ($ask1.Status -eq 200) "POST /api/chat -> 200 (got $($ask1.Status))"
$r1 = $ask1.Json
Assert ([bool]$r1.answer -and $r1.answer.Length -gt 40) "answer is non-empty ($($r1.answer.Length) chars)"
Assert ($r1.answerMode -in @("extractive", "llm")) "answerMode present: '$($r1.answerMode)'"
$citations = @($r1.citations)
Assert ($citations.Count -gt 0) "citations returned: $($citations.Count)"
$withPages = @($citations | Where-Object { $_.page -ge 1 -and $_.fileName })
Assert ($withPages.Count -eq $citations.Count) "every citation carries a file name and page number"
Assert ($r1.cached -eq $false) "first ask is not cached (cached=$($r1.cached))"
Assert ($r1.latencyMs -ge 0) "latencyMs reported: $($r1.latencyMs) ms"
$chatId = $r1.id

Write-Info "answer:"
$r1.answer -split "`n" | Select-Object -First 6 | ForEach-Object { Write-Host "      $($_.TrimEnd())" -ForegroundColor Gray }
Write-Info "citations:"
foreach ($c in $citations | Select-Object -First 3) {
    $n = [Math]::Min(70, $c.snippet.Length)
    Write-Host ("      [{0} p.{1}] score={2} {3}" -f $c.fileName, $c.page, $c.score, $c.snippet.Substring(0, $n)) -ForegroundColor Gray
}

# ---------------------------------------------------------------------------
Write-Head "5. Cache proof (identical question)"
$ask2 = Invoke-Api -Method POST -Path "/api/chat" -Token $tokenA -Json $askBody
Assert ($ask2.Json.cached -eq $true) "second identical ask returns cached:true (got $($ask2.Json.cached))"
Assert ($ask2.Json.answer -eq $r1.answer) "cached answer is byte-identical to the first"
Write-Info "cached latency: $($ask2.Json.latencyMs) ms vs uncached: $($r1.latencyMs) ms"

# ---------------------------------------------------------------------------
Write-Head "6. Thumbs feedback"
$fb = Invoke-Api -Method POST -Path "/api/chat/$chatId/feedback" -Token $tokenA -Json "{`"thumbs`":1}"
Assert ($fb.Status -eq 200) "POST /api/chat/:id/feedback -> 200 (got $($fb.Status))"
$fbDown = Invoke-Api -Method POST -Path "/api/chat/$chatId/feedback" -Token $tokenA -Json "{`"thumbs`":-1}"
Assert ($fbDown.Status -eq 200) "thumbs can be changed (upsert) -> 200 (got $($fbDown.Status))"
$fbBad = Invoke-Api -Method POST -Path "/api/chat/$chatId/feedback" -Token $tokenA -Json "{`"thumbs`":5}"
Assert ($fbBad.Status -eq 400) "invalid thumbs value -> 400 (got $($fbBad.Status))"

# ---------------------------------------------------------------------------
Write-Head "7. Usage counter"
$usage = Invoke-Api -Method GET -Path "/api/usage" -Token $tokenA
Assert ($usage.Json.queries -ge 2) "usage counter counted both asks: $($usage.Json.queries)/$($usage.Json.limit)"
Assert ($usage.Json.remaining -eq ($usage.Json.limit - $usage.Json.queries)) "remaining computed correctly: $($usage.Json.remaining)"
Write-Info "day=$($usage.Json.day) queries=$($usage.Json.queries) limit=$($usage.Json.limit)"

# ---------------------------------------------------------------------------
Write-Head "8. Privacy: cross-user access must be rejected"
$regB = Invoke-Api -Method POST -Path "/api/register" -Json (New-CredentialBody $userB $password)
Assert ($regB.Status -eq 201) "registered second user (got $($regB.Status))"
$loginB = Invoke-Api -Method POST -Path "/api/login" -Json (New-CredentialBody $userB $password)
$tokenB = $loginB.Json.token

$crossBody = "{`"setId`":`"$setId`",`"question`":`"What is in this document?`"}"
$crossAsk = Invoke-Api -Method POST -Path "/api/chat" -Token $tokenB -Json $crossBody
Assert ($crossAsk.Status -in @(401, 403, 404)) "user B asking user A's set -> $($crossAsk.Status) (expected 401/403/404)"

$crossDocs = Invoke-Api -Method GET -Path "/api/docs/$setId" -Token $tokenB
Assert ($crossDocs.Status -eq 403) "user B reading user A's set -> 403 (got $($crossDocs.Status))"

$crossDelete = Invoke-Api -Method DELETE -Path "/api/docs/$setId" -Token $tokenB
Assert ($crossDelete.Status -eq 403) "user B deleting user A's set -> 403 (got $($crossDelete.Status))"

$bSets = Invoke-Api -Method GET -Path "/api/sets" -Token $tokenB
Assert (@($bSets.Json.sets).Count -eq 0) "user B sees 0 sets (isolation confirmed)"

# ---------------------------------------------------------------------------
Write-Head "9. Admin feedback aggregation"
$forbidden = Invoke-Api -Method GET -Path "/api/admin/feedback" -Token $tokenA
Assert ($forbidden.Status -eq 403) "non-admin GET /api/admin/feedback -> 403 (got $($forbidden.Status))"

$adminEmail = if ($env:ADMIN_EMAIL) { $env:ADMIN_EMAIL } else { "admin@documind.local" }
$adminBody = New-CredentialBody $adminEmail "admin-password-123"
Invoke-Api -Method POST -Path "/api/register" -Json $adminBody | Out-Null
$adminLogin = Invoke-Api -Method POST -Path "/api/login" -Json $adminBody
$adminToken = $adminLogin.Json.token
if ($adminToken) {
    $stats = Invoke-Api -Method GET -Path "/api/admin/feedback" -Token $adminToken
    if ($stats.Json) {
        Write-Info "total=$($stats.Json.total) up=$($stats.Json.up) down=$($stats.Json.down) ratio=$($stats.Json.ratio)"
        Assert ($stats.Json.total -ge 1) "admin feedback aggregation returns data (total=$($stats.Json.total))"
    } else {
        Write-Bad "admin feedback returned no parseable body"
    }
} else {
    Write-Info "skipped admin check (admin account could not be created/logged in)"
}

# ---------------------------------------------------------------------------
Write-Head "RESULT"
if ($script:Failures.Count -eq 0) {
    Write-Host "  ALL CHECKS PASSED ($script:PassCount assertions)" -ForegroundColor Green
    Write-Host ""
    exit 0
} else {
    Write-Host "  $($script:Failures.Count) CHECK(S) FAILED ($script:PassCount passed)" -ForegroundColor Red
    foreach ($f in $script:Failures) { Write-Host "    - $f" -ForegroundColor Red }
    Write-Host ""
    exit 1
}
