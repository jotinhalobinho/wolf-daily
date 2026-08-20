"use strict";

const db = require("./db");

// Pequenas migrações que rodam sozinhas toda vez que o servidor sobe — como
// não existe uma ferramenta de migração no projeto (o schema é só um arquivo
// SQL importado manualmente na primeira instalação), qualquer coluna nova
// precisa ser adicionada aqui também, senão quem já tem o banco criado nunca
// vai ganhar a coluna nova só rodando `mysql_schema.sql` de novo (o `CREATE
// TABLE IF NOT EXISTS` não altera tabelas que já existem).

async function columnExists(table, column) {
  const row = await db.get(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return row.cnt > 0;
}

async function runMigrations() {
  // Data de aniversário do colaborador (opcional) — usada pra descontar 1 dia
  // (day off) do rateio mensal no mês em que ela cai.
  if (!(await columnExists("collaborators", "birth_date"))) {
    await db.run("ALTER TABLE collaborators ADD COLUMN birth_date DATE NULL AFTER role");
    console.log("  [migração] coluna collaborators.birth_date criada.");
  }

  // Day off de aniversário: um único dia por mês, marcado no Rateio Diário,
  // que some as horas sem centro de custo (ver [[daily-suggestion-feature]]).
  if (!(await columnExists("daily_days", "day_off"))) {
    await db.run("ALTER TABLE daily_days ADD COLUMN day_off TINYINT(1) NOT NULL DEFAULT 0 AFTER atestado");
    console.log("  [migração] coluna daily_days.day_off criada.");
  }

  // Amplia o centro de custo do rateio diário para aceitar "geral" (demanda
  // que não precisa ser lançada num centro de custo específico).
  const unitColumn = await db.get(
    `SELECT COLUMN_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_day_items' AND COLUMN_NAME = 'unit'`
  );
  if (unitColumn && !unitColumn.type.includes("'geral'")) {
    await db.run(
      "ALTER TABLE daily_day_items MODIFY COLUMN unit ENUM('wolf','fraga','woncred','profit','geral') NOT NULL"
    );
    console.log("  [migração] daily_day_items.unit agora aceita 'geral'.");
  }
}

module.exports = { runMigrations };
