"use strict";

// Helpers de data compartilhados entre routes/daily.js e routes/homeOffice.js.

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Retorna as datas (YYYY-MM-DD) de segunda a sexta de um mês (month: 1-12).
function weekdaysOfMonth(year, month) {
  const dates = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    const weekday = d.getDay(); // 0=domingo, 6=sábado
    if (weekday !== 0 && weekday !== 6) {
      dates.push(`${year}-${pad2(month)}-${pad2(day)}`);
    }
  }
  return dates;
}

module.exports = { pad2, weekdaysOfMonth };
