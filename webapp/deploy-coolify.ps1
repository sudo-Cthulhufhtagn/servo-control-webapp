$uri = "https://c.ai-man.cc/api/v1/deploy?uuid=ko4w0cc00ccg4wsg0c8g8ks0&force=false"
$headers = @{ Authorization = "Bearer 1|mBzxGIyFvaHepxSqLDm1YR4UYXev1OpXNIh2l9Ysf0fdd1ae" }

Invoke-RestMethod -Method Get -Uri $uri -Headers $headers