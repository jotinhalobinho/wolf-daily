@echo off
setlocal
cd /d "%~dp0server"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao foi encontrado neste computador.
  echo Instale o Node.js versao 22.5 ou mais recente em https://nodejs.org e tente novamente.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias na primeira execucao, aguarde...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)

echo.
echo Iniciando o sistema de Rateio de Horas...
echo Acesse pelo navegador em http://localhost:4000
echo Para encerrar, feche esta janela ou pressione Ctrl+C.
echo.

start "" http://localhost:4000
call npm start

pause
