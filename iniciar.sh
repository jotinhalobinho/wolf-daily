#!/bin/bash
set -e
cd "$(dirname "$0")/server"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "[ERRO] Node.js nao foi encontrado neste computador."
  echo "Instale o Node.js versao 22.5 ou mais recente em https://nodejs.org e tente novamente."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependências na primeira execução, aguarde..."
  npm install
fi

echo
echo "Iniciando o sistema de Rateio de Horas..."
echo "Acesse pelo navegador em http://localhost:4000"
echo "Para encerrar, pressione Ctrl+C."
echo

( sleep 2; xdg-open http://localhost:4000 2>/dev/null || open http://localhost:4000 2>/dev/null || true ) &
npm start
